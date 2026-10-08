import type { FullTurnBroker, FullTurnToolResult } from "./full-turn-broker.js";
import type { BridgeToolDefinition } from "./tool-protocol.js";
import {
  assertFullAgentWait,
  FULL_AGENT_WAIT_POLL_MS,
  NATIVE_AGENT_WAIT_NAMES,
} from "./full-native-transport.js";

const START = "BRIDGE_NATIVE_REGISTRY_V1\n";
const END = "\nBRIDGE_NATIVE_REGISTRY_END";

interface NestedTool {
  readonly kind: "nested";
  readonly wireName: string;
  readonly name: string;
  readonly description: string;
}

function gatewayTool(
  tools: readonly BridgeToolDefinition[],
): BridgeToolDefinition | undefined {
  const candidates = tools.filter(
    (tool) => tool.kind === "custom" && tool.name === "exec",
  );
  if (candidates.length > 1)
    throw new Error(
      "The active Codex turn has ambiguous native exec gateways.",
    );
  return candidates[0];
}

function registryProgram(
  query: string,
  offset: number,
  limit: number,
  outerNames: readonly string[],
): string {
  return [
    'if (typeof ALL_TOOLS === "undefined" || !Array.isArray(ALL_TOOLS)) throw new Error("Native nested tool registry is unavailable");',
    'const entries = ALL_TOOLS.map(tool => ({ name: tool?.name, description: tool?.description ?? "" }));',
    `for (const tool of entries) if (${JSON.stringify(NATIVE_AGENT_WAIT_NAMES)}.some(name => tool.name === name || tool.name?.endsWith('__' + name))) tool.description += ${JSON.stringify(`\nFull transport: use timeout_ms=${FULL_AGENT_WAIT_POLL_MS} for each wait. A timeout is not completion; poll again so child agents can use the shared connector.`)};`,
    'if (new Set(entries.map(tool => tool.name)).size !== entries.length) throw new Error("Native nested tool registry has duplicate identities");',
    `const outerNames = new Set(${JSON.stringify(outerNames)});`,
    `const query = ${JSON.stringify(query)};`,
    'const matches = entries.filter(tool => !outerNames.has(tool.name) && (!query || (tool.name + "\\n" + tool.description).toLocaleLowerCase().includes(query)));',
    `const page = matches.slice(${offset}, ${offset + limit});`,
    `text(${JSON.stringify(START)} + JSON.stringify({ version: 1, total: matches.length, entries: page }) + ${JSON.stringify(END)});`,
  ].join("\n");
}

function decodeRegistry(result: FullTurnToolResult): {
  tools: readonly NestedTool[];
  total: number;
} {
  if (result.isError)
    throw new Error("Native tool registry discovery failed in Codex.");
  const candidates = result.content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const text = (block as Record<string, unknown>).text;
    return typeof text === "string" && text.includes(START) ? [text] : [];
  });
  if (candidates.length !== 1)
    throw new Error(
      "Native tool registry did not return exactly one bound discovery receipt.",
    );
  const text = candidates[0]!;
  const start = text.indexOf(START) + START.length;
  const end = text.indexOf(END, start);
  if (
    end < start ||
    end - start > 8 * 1024 * 1024 ||
    text.indexOf(START, start) >= 0
  )
    throw new Error("Native tool registry discovery receipt is invalid.");
  const decoded = JSON.parse(text.slice(start, end)) as {
    version?: unknown;
    entries?: unknown;
    total?: unknown;
  };
  if (
    decoded.version !== 1 ||
    !Array.isArray(decoded.entries) ||
    decoded.entries.length > 100 ||
    typeof decoded.total !== "number" ||
    !Number.isSafeInteger(decoded.total) ||
    decoded.total < decoded.entries.length ||
    decoded.total > 4096
  )
    throw new Error("Native tool registry discovery receipt is invalid.");
  const names = new Set<string>();
  const tools: NestedTool[] = decoded.entries.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Native tool registry entry is invalid.");
    const tool = entry as Record<string, unknown>;
    if (
      typeof tool.name !== "string" ||
      !/^[A-Za-z_$][A-Za-z0-9_$.-]{0,999}$/u.test(tool.name) ||
      names.has(tool.name) ||
      typeof tool.description !== "string"
    )
      throw new Error(
        "Native tool registry has an invalid or duplicate tool identity.",
      );
    names.add(tool.name);
    return {
      kind: "nested",
      wireName: tool.name,
      name: tool.name,
      description: tool.description,
    };
  });
  return { tools, total: decoded.total };
}

function invocationProgram(name: string, payload: unknown): string {
  const accessor = /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)
    ? `tools.${name}`
    : `tools[${JSON.stringify(name)}]`;
  return [
    `const nativeName = ${JSON.stringify(name)};`,
    'if (typeof ALL_TOOLS === "undefined" || !Array.isArray(ALL_TOOLS) || !ALL_TOOLS.some(tool => tool?.name === nativeName)) throw new Error("Native tool is not listed in this turn: " + nativeName);',
    'if (typeof tools[nativeName] !== "function") throw new Error("Native tool is listed but unavailable: " + nativeName);',
    `const result = await ${accessor}(${JSON.stringify(payload)});`,
    "const emit = value => {",
    "  if (Array.isArray(value)) { for (const item of value) emit(item); return; }",
    '  if (value && typeof value === "object") {',
    '    if (value.type === "image") { image(value); return; }',
    '    if (value.type === "audio") { audio(value); return; }',
    '    if (value.type === "text" && typeof value.text === "string") { text(value.text); return; }',
    '    if (typeof value.image_url === "string" && typeof value.output_hint === "string") { generatedImage(value); return; }',
    '    if (typeof value.image_url === "string") { image(value.image_url, value.detail ?? "auto"); return; }',
    '    if (typeof value.audio_url === "string") { audio(value.audio_url); return; }',
    "    if (value.isError === true || value.structuredContent !== undefined || value._meta !== undefined) { text(value); return; }",
    "    if (Array.isArray(value.content)) { for (const item of value.content) emit(item); return; }",
    "  }",
    "  text(value);",
    "};",
    "emit(result);",
  ].join("\n");
}

/** Discover through the real outer exec, then re-check that registry on every call. */
export class FullNativeRegistry {
  readonly #discovered = new Map<string, Set<string>>();
  constructor(private readonly broker: FullTurnBroker) {}

  #outerTools(token: string): readonly BridgeToolDefinition[] {
    const tools: BridgeToolDefinition[] = [];
    let offset: number | null = 0;
    do {
      const page = this.broker.inventory(token, "", offset, 100);
      tools.push(...page.tools);
      offset = page.nextOffset;
    } while (offset !== null);
    return tools;
  }

  async inventory(
    token: string,
    query = "",
    offset = 0,
    limit = 50,
    signal?: AbortSignal,
  ) {
    const outer = this.#outerTools(token);
    const gateway = gatewayTool(outer);
    const normalized = query.trim().toLocaleLowerCase();
    const matches = outer.filter(
      (tool) =>
        !normalized ||
        `${tool.wireName}\n${tool.description}`
          .toLocaleLowerCase()
          .includes(normalized),
    );
    const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    const size =
      Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50;
    const outerPage = matches.slice(start, start + size);
    let nested: { tools: readonly NestedTool[]; total: number } = {
      tools: [],
      total: 0,
    };
    if (gateway) {
      // Filter/page inside the actual native runtime so unrequested schemas never
      // inflate Codex history. Every inventory call observes the current registry.
      const result = await this.broker.invoke(
        token,
        gateway.wireName,
        {
          input: registryProgram(
            normalized,
            Math.max(0, start - matches.length),
            size - outerPage.length,
            outer.map((tool) => tool.wireName),
          ),
        },
        signal,
      );
      nested = decodeRegistry(result);
      const names = this.#discovered.get(token) ?? new Set<string>();
      for (const tool of nested.tools) names.add(tool.wireName);
      this.#discovered.set(token, names);
    }
    const tools = [...outerPage, ...nested.tools];
    const total = matches.length + nested.total;
    return {
      tools,
      total,
      nextOffset: start + tools.length < total ? start + tools.length : null,
    };
  }

  async invoke(
    token: string,
    name: string,
    payload: { readonly arguments?: unknown; readonly input?: unknown },
    signal?: AbortSignal,
  ): Promise<FullTurnToolResult> {
    const outer = this.#outerTools(token);
    const args = payload.arguments;
    const requestedCell =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>).cell_id
        : undefined;
    const nativeCellId =
      /(?:^|__)wait$/u.test(name) &&
      (typeof requestedCell === "string" || typeof requestedCell === "number")
        ? String(requestedCell)
        : undefined;
    if (nativeCellId && !this.broker.ownsNativeCell(token, nativeCellId))
      throw new Error(
        "The native execution cell does not belong to this Full turn.",
      );
    if (nativeCellId && args && typeof args === "object") {
      const yieldMs = (args as Record<string, unknown>).yield_time_ms;
      if (
        yieldMs !== undefined &&
        (typeof yieldMs !== "number" ||
          !Number.isSafeInteger(yieldMs) ||
          yieldMs < 1 ||
          yieldMs > FULL_AGENT_WAIT_POLL_MS)
      )
        throw new Error(
          "Full native cell waits require yield_time_ms between 1 and 30000, or the native default. Poll the same owned cell again when it is still running.",
        );
    }
    const direct = outer.find((tool) => tool.wireName === name);
    if (direct) {
      assertFullAgentWait(name, payload.arguments);
      return this.broker.invoke(token, name, payload, signal, {
        nativeExec: direct.kind === "custom" && direct.name === "exec",
        ...(nativeCellId ? { nativeCellId } : {}),
      });
    }
    const gateway = gatewayTool(outer);
    if (!gateway || !this.#discovered.get(token)?.has(name))
      throw new Error(
        `Discover the exact native tool ${name} with codex_tool_inventory before calling it.`,
      );
    if (payload.arguments !== undefined && payload.input !== undefined)
      throw new Error(
        "Native tool call must use either structured arguments or freeform input.",
      );
    if (payload.input !== undefined && typeof payload.input !== "string")
      throw new Error("Native freeform tool input must be a string.");
    if (
      payload.arguments !== undefined &&
      (!payload.arguments ||
        typeof payload.arguments !== "object" ||
        Array.isArray(payload.arguments))
    )
      throw new Error("Native structured tool arguments must be an object.");
    assertFullAgentWait(name, payload.arguments);
    return this.broker.invoke(
      token,
      gateway.wireName,
      {
        input: invocationProgram(
          name,
          payload.input ?? payload.arguments ?? {},
        ),
      },
      signal,
      { nativeExec: !nativeCellId, ...(nativeCellId ? { nativeCellId } : {}) },
    );
  }

  prune(): void {
    for (const token of this.#discovered.keys())
      if (!this.broker.isActive(token)) this.#discovered.delete(token);
  }

  close(): void {
    this.#discovered.clear();
  }
}
