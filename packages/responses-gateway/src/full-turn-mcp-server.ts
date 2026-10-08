import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { fullTurnError } from "./full-turn-broker.js";
import type { FullTurnBroker } from "./full-turn-broker.js";
import { FullNativeRegistry } from "./full-native-registry.js";
import type { BridgeToolDefinition } from "./tool-protocol.js";
import { FULL_CHECKPOINT_TOOL } from "./full-checkpoint.js";
import { canonicalJson } from "./operation-identity.js";
import {
  commandOutputTokenBudget,
  DEFAULT_COMMAND_OUTPUT_TOKENS,
  MAX_COMMAND_OUTPUT_TOKENS,
} from "./command-output-budget.js";
import {
  BRIDGE_FULL_REPLAY_TTL_MS,
  BRIDGE_FULL_TURN_TIMEOUT_MS,
} from "./full-turn-limits.js";

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

interface SessionState {
  readonly id: string;
  readonly requests: Map<string, RpcInvocation>;
  lastAccess: number;
}

interface RpcInvocation {
  readonly fingerprint: string;
  readonly turnToken: string;
  readonly abort: AbortController;
  readonly result: Promise<unknown>;
  settledAt?: number;
}

export interface FullTurnMcpAddress {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly url: string;
}

const TOOL_DEFINITIONS = [
  {
    name: "codex_manual_complete",
    description:
      "Complete an explicitly sent manual Bridge turn with its full final answer. Only available for an owned manual turn; native tools must have finished.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["turn_token", "text"],
      properties: {
        turn_token: { type: "string" },
        text: { type: "string", minLength: 1, maxLength: 2000000 },
      },
    },
  },
  {
    name: "codex_exec",
    title: "Run a native Codex command",
    description:
      "Invoke the command tool advertised by the active outer Codex turn. A long-running command returns its native session_id; Codex retains sandbox and approval ownership.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["turn_token", "cmd"],
      properties: {
        turn_token: { type: "string", minLength: 40, maxLength: 256 },
        cmd: { type: "string", minLength: 1, maxLength: 100_000 },
        workdir: { type: "string", maxLength: 16_384 },
        yield_time_ms: { type: "integer", minimum: 250, maximum: 30_000 },
        max_output_tokens: {
          type: "integer",
          minimum: 1,
          maximum: 1_000_000,
          default: DEFAULT_COMMAND_OUTPUT_TOKENS,
          description: `Bridge defaults to ${DEFAULT_COMMAND_OUTPUT_TOKENS} output tokens and caps requests at ${MAX_COMMAND_OUTPUT_TOKENS}. Read large files in targeted ranges; redirect long logs to a file and inspect the relevant lines.`,
        },
        tty: { type: "boolean" },
        sandbox_permissions: {
          type: "string",
          enum: ["use_default", "require_escalated"],
        },
        justification: { type: "string", maxLength: 10_000 },
        prefix_rule: {
          type: "array",
          maxItems: 100,
          items: { type: "string", maxLength: 10_000 },
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "codex_write_stdin",
    title: "Continue a native Codex command session",
    description:
      "Write characters to, or poll, a session_id returned by codex_exec for this same outer Codex turn.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["turn_token", "session_id"],
      properties: {
        turn_token: { type: "string", minLength: 40, maxLength: 256 },
        session_id: { type: "integer", minimum: 0 },
        chars: { type: "string", maxLength: 1_000_000 },
        yield_time_ms: { type: "integer", minimum: 250, maximum: 300_000 },
        max_output_tokens: {
          type: "integer",
          minimum: 1,
          maximum: 1_000_000,
          default: DEFAULT_COMMAND_OUTPUT_TOKENS,
          description: `Bridge defaults to ${DEFAULT_COMMAND_OUTPUT_TOKENS} output tokens and caps requests at ${MAX_COMMAND_OUTPUT_TOKENS}. Inspect long command logs in bounded ranges.`,
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "codex_apply_patch",
    title: "Apply a native Codex patch",
    description:
      "Invoke the apply_patch tool advertised by the active outer Codex turn, preserving its native file-change lifecycle.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["turn_token", "patch"],
      properties: {
        turn_token: { type: "string", minLength: 40, maxLength: 256 },
        patch: { type: "string", minLength: 1, maxLength: 5_000_000 },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "codex_view_image",
    title: "View an image through native Codex",
    description:
      "Invoke the view_image tool advertised by the active outer Codex turn and return its multimodal result.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["turn_token", "path"],
      properties: {
        turn_token: { type: "string", minLength: 40, maxLength: 256 },
        path: { type: "string", minLength: 1, maxLength: 16_384 },
        detail: { type: "string", enum: ["high", "original"] },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "codex_tool_inventory",
    description:
      "List the exact tools supplied by the active outer Codex turn. The turn_token must come from the current Codex prompt.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["turn_token"],
      properties: {
        turn_token: { type: "string", minLength: 40, maxLength: 256 },
        query: { type: "string", maxLength: 500 },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "codex_tool_call",
    description:
      "Call one exact wire_name returned by codex_tool_inventory. Codex executes the action and keeps its native sandbox, approval, UI and result lifecycle.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["turn_token", "wire_name"],
      properties: {
        turn_token: { type: "string", minLength: 40, maxLength: 256 },
        wire_name: { type: "string", minLength: 1, maxLength: 1_000 },
        arguments: { type: "object" },
        input: { type: "string", maxLength: 5_000_000 },
      },
    },
  },
] as const;

export const MANUAL_COMPLETION_TOOL = "bridge.control.manual_complete";
const manualCompletionTool: BridgeToolDefinition = {
  kind: "function",
  wireName: MANUAL_COMPLETION_TOOL,
  name: "bridge_manual_complete",
  description:
    "Return the full final answer to Codex for an explicitly sent manual Bridge turn. Native tools must have finished. This is a Bridge transport control, executed through codex_tool_call.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: { type: "string", minLength: 1, maxLength: 2000000 },
    },
  },
};
const MCP_SESSION_TTL_MS =
  BRIDGE_FULL_TURN_TIMEOUT_MS + BRIDGE_FULL_REPLAY_TTL_MS;
const MAX_MCP_SESSIONS = 64;
const MAX_RPC_REQUESTS_PER_SESSION = 1024;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function rpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
): unknown {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new Error("MCP request exceeds 1 MiB.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function guardSocket(socket: Duplex): void {
  socket.on("error", () => {
    if (!socket.destroyed) socket.destroy();
  });
}

function exactTool(broker: FullTurnBroker, turnToken: string, name: string) {
  const candidates = broker
    .inventory(turnToken, name, 0, 100)
    .tools.filter((tool) => tool.wireName === name || tool.name === name);
  const exact = candidates.find((tool) => tool.wireName === name);
  if (exact) return exact;
  if (candidates.length > 1)
    throw new Error(`Ambiguous native tool ${name} in the active Codex turn.`);
  return candidates[0];
}

function nestedResultProgram(invocation: readonly string[]): string {
  return [
    ...invocation,
    "const emit = value => {",
    "  if (Array.isArray(value)) { for (const item of value) emit(item); return; }",
    '  if (value && typeof value === "object") {',
    '    if (value.type === "image") { image(value); return; }',
    '    if (value.type === "audio") { audio(value); return; }',
    '    if (value.type === "text" && typeof value.text === "string") { text(value.text); return; }',
    '    if (typeof value.image_url === "string" && typeof value.output_hint === "string") { generatedImage(value); return; }',
    '    if (typeof value.image_url === "string") { image(value.image_url, value.detail ?? "auto"); return; }',
    '    if (typeof value.audio_url === "string") { audio(value.audio_url); return; }',
    "    if (Array.isArray(value.content)) { for (const item of value.content) emit(item); return; }",
    "  }",
    "  text(value);",
    "};",
    "emit(result);",
  ].join("\n");
}

function nestedToolProgram(
  name: "write_stdin" | "apply_patch" | "view_image",
  payload: Record<string, unknown> | string,
): string {
  return nestedResultProgram([
    'if (typeof ALL_TOOLS === "undefined" || !Array.isArray(ALL_TOOLS)) throw new Error("Native nested tool registry is unavailable");',
    `const nestedToolName = ${JSON.stringify(name)};`,
    'if (!ALL_TOOLS.some(tool => tool?.name === nestedToolName)) throw new Error("Native nested tool is not listed in this turn: " + nestedToolName);',
    "const nestedTool = tools[nestedToolName];",
    'if (typeof nestedTool !== "function") throw new Error("Native nested tool is listed but unavailable: " + nestedToolName);',
    `const result = await nestedTool(${JSON.stringify(payload)});`,
  ]);
}

function commandGatewayProgram(
  execCommandArguments: Record<string, unknown>,
  shellCommandArguments: Record<string, unknown>,
): string {
  return nestedResultProgram([
    'if (typeof ALL_TOOLS === "undefined" || !Array.isArray(ALL_TOOLS)) throw new Error("Native command tool registry is unavailable");',
    "const commandNames = new Set(ALL_TOOLS.map(tool => tool?.name));",
    'const candidates = ["exec_command", "shell_command"].filter(name => commandNames.has(name));',
    'if (candidates.length !== 1) throw new Error("Expected exactly one native command tool; found " + (candidates.join(", ") || "none"));',
    "const commandName = candidates[0];",
    "const commandTool = tools[commandName];",
    'if (typeof commandTool !== "function") throw new Error("Native command tool is listed but unavailable: " + commandName);',
    `const commandInput = commandName === "exec_command" ? ${JSON.stringify(execCommandArguments)} : ${JSON.stringify(shellCommandArguments)};`,
    "const result = await commandTool(commandInput);",
  ]);
}

function resultSessionId(result: unknown): number | undefined {
  const visited = new Set<object>();
  const inspect = (value: unknown): number | undefined => {
    if (value === null || typeof value !== "object") return undefined;
    if (visited.has(value)) return undefined;
    visited.add(value);
    if (!Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (
        typeof record.session_id === "number" &&
        Number.isSafeInteger(record.session_id) &&
        record.session_id >= 0
      ) {
        return record.session_id;
      }
      for (const entry of Object.values(record)) {
        const found = inspect(entry);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    for (const entry of value) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>).type === "text" &&
        typeof (entry as Record<string, unknown>).text === "string"
      ) {
        const text = (entry as Record<string, unknown>).text as string;
        try {
          const found = inspect(JSON.parse(text));
          if (found !== undefined) return found;
        } catch {
          const match = /\bsession[_ ]id\D{0,12}(\d+)\b/iu.exec(text);
          if (match) return Number(match[1]);
        }
      }
      const found = inspect(entry);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return inspect(result);
}

export class FullTurnMcpServer {
  readonly #broker: FullTurnBroker;
  readonly #nativeRegistry: FullNativeRegistry;
  readonly #sessions = new Map<string, SessionState>();
  readonly #commandSessions = new Map<string, Set<number>>();
  #server: Server | undefined;

  constructor(
    broker: FullTurnBroker,
    readonly onManualComplete?: (token: string, text: string) => void,
    readonly validateManualTurn?: (token: string) => void,
  ) {
    this.#broker = broker;
    this.#nativeRegistry = new FullNativeRegistry(broker);
  }

  async start(port = 0): Promise<FullTurnMcpAddress> {
    if (this.#server) throw new Error("Full MCP server is already running.");
    const server = createServer((request, response) => {
      request.on("error", () => response.destroy());
      response.on("error", () => request.destroy());
      void this.#handle(request, response).catch(() => {
        if (!response.destroyed && !response.writableEnded) response.destroy();
      });
    });
    server.on("connection", guardSocket);
    server.on("clientError", (_error, socket) => socket.destroy());
    this.#server = server;
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", rejectPromise);
          resolvePromise();
        });
      });
    } catch (error) {
      this.#server = undefined;
      server.close();
      throw error;
    }
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Full MCP server did not expose a TCP address.");
    }
    return {
      host: "127.0.0.1",
      port: address.port,
      url: `http://127.0.0.1:${address.port}/mcp`,
    };
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    for (const session of this.#sessions.values())
      for (const invocation of session.requests.values())
        invocation.abort.abort(new Error("Full MCP server closed."));
    this.#sessions.clear();
    this.#commandSessions.clear();
    this.#nativeRegistry.close();
    if (!server) return;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) =>
        error ? rejectPromise(error) : resolvePromise(),
      );
      server.closeAllConnections();
    });
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.url === "/health" && request.method === "GET") {
      json(response, 200, {
        status: "ok",
        service: "codexgpt-bridge-full-mcp",
      });
      return;
    }
    if (request.url !== "/mcp") {
      json(response, 404, { error: "not_found" });
      return;
    }
    if (request.method === "DELETE") {
      const sessionId = request.headers["mcp-session-id"];
      if (typeof sessionId === "string") {
        const session = this.#sessions.get(sessionId);
        if (session)
          for (const invocation of session.requests.values())
            invocation.abort.abort(new Error("Full MCP session deleted."));
        this.#sessions.delete(sessionId);
      }
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== "POST") {
      json(response, 405, { error: "method_not_allowed" });
      return;
    }

    const raw = await readJson(request);
    const rpc = asRecord(raw) as Partial<JsonRpcRequest> | undefined;
    if (rpc?.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
      json(response, 400, rpcError(rpc?.id, -32600, "Invalid Request"));
      return;
    }
    this.#pruneSessions();
    if (rpc.method === "initialize") {
      if (this.#sessions.size >= MAX_MCP_SESSIONS) {
        const oldest = [...this.#sessions.values()]
          .sort((left, right) => left.lastAccess - right.lastAccess)
          .find((session) =>
            [...session.requests.values()].every(
              (invocation) =>
                invocation.settledAt !== undefined &&
                !this.#broker.isActive(invocation.turnToken),
            ),
          );
        if (oldest) this.#sessions.delete(oldest.id);
        else {
          json(
            response,
            503,
            rpcError(
              rpc.id,
              -32000,
              "All Full MCP sessions still own active requests.",
            ),
          );
          return;
        }
      }
      const session: SessionState = {
        id: randomUUID(),
        lastAccess: Date.now(),
        requests: new Map(),
      };
      this.#sessions.set(session.id, session);
      const params = asRecord(rpc.params);
      const protocolVersion =
        typeof params?.protocolVersion === "string"
          ? params.protocolVersion
          : "2025-03-26";
      json(
        response,
        200,
        {
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "CodexGPT Bridge Full MCP", version: "1.0.0" },
          },
        },
        { "Mcp-Session-Id": session.id },
      );
      return;
    }

    const sessionId = request.headers["mcp-session-id"];
    if (typeof sessionId !== "string" || !this.#sessions.has(sessionId)) {
      json(response, 404, rpcError(rpc.id, -32001, "MCP session not found"));
      return;
    }
    const session = this.#sessions.get(sessionId)!;
    session.lastAccess = Date.now();
    if (rpc.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    if (rpc.method === "notifications/cancelled") {
      const requestId = asRecord(rpc.params)?.requestId;
      if (typeof requestId === "string" || typeof requestId === "number")
        session.requests
          .get(JSON.stringify(requestId))
          ?.abort.abort(
            new Error("Full MCP invocation was explicitly cancelled."),
          );
      response.writeHead(202);
      response.end();
      return;
    }
    if (rpc.method === "ping") {
      json(response, 200, { jsonrpc: "2.0", id: rpc.id ?? null, result: {} });
      return;
    }
    if (rpc.method === "tools/list") {
      json(response, 200, {
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        result: {
          tools: TOOL_DEFINITIONS.filter(
            (tool) =>
              tool.name !== "codex_manual_complete" ||
              this.onManualComplete !== undefined,
          ),
        },
      });
      return;
    }
    if (rpc.method !== "tools/call") {
      json(response, 200, rpcError(rpc.id, -32601, "Method not found"));
      return;
    }

    const params = asRecord(rpc.params);
    const name = params?.name;
    const args = asRecord(params?.arguments) ?? {};
    const turnToken = args.turn_token;
    if (typeof name !== "string" || typeof turnToken !== "string") {
      json(response, 200, rpcError(rpc.id, -32602, "Invalid tool arguments"));
      return;
    }
    if (typeof rpc.id !== "string" && typeof rpc.id !== "number") {
      json(
        response,
        200,
        rpcError(rpc.id, -32600, "Full MCP tool calls require a request ID."),
      );
      return;
    }
    const requestKey = JSON.stringify(rpc.id);
    const fingerprint = createHash("sha256")
      .update(canonicalJson({ name, args }))
      .digest("hex");
    let invocation = session.requests.get(requestKey);
    if (invocation && invocation.fingerprint !== fingerprint) {
      json(
        response,
        200,
        rpcError(
          rpc.id,
          -32600,
          "Full MCP request ID was reused with different tool arguments.",
        ),
      );
      return;
    }
    if (!invocation) {
      if (session.requests.size >= MAX_RPC_REQUESTS_PER_SESSION) {
        json(
          response,
          200,
          rpcError(
            rpc.id,
            -32000,
            "Full MCP session request capacity reached; initialize a new session.",
          ),
        );
        return;
      }
      const abort = new AbortController();
      const result = Promise.resolve()
        .then(() => this.#runTool(name, args, turnToken, abort.signal))
        .catch(fullTurnError);
      const owned: RpcInvocation = { fingerprint, turnToken, abort, result };
      session.requests.set(requestKey, owned);
      void result.then(() => {
        owned.settledAt = Date.now();
      });
      invocation = owned;
    }
    // A disconnected HTTP peer loses only its observer. The operation remains
    // owned by this RPC request, and a retry with the same ID joins its result.
    const result = await invocation.result;
    json(response, 200, { jsonrpc: "2.0", id: rpc.id, result });
  }

  async #runTool(
    name: string,
    args: Record<string, unknown>,
    turnToken: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    try {
      this.validateManualTurn?.(turnToken);
      const staging = this.#broker.contextStagingInstruction(turnToken);
      if (staging) return staging;
      if (
        name === "codex_manual_complete" ||
        (name === "codex_tool_call" &&
          args.wire_name === MANUAL_COMPLETION_TOOL)
      ) {
        if (this.#broker.checkpointInstruction(turnToken))
          throw new Error(
            "Submit the requested checkpoint control before finishing.",
          );
        const completionArgs =
          name === "codex_manual_complete" ? args : asRecord(args.arguments);
        if (
          !this.onManualComplete ||
          typeof completionArgs?.text !== "string" ||
          (name === "codex_tool_call" && args.input !== undefined) ||
          Object.keys(completionArgs).some(
            (key) =>
              key !== "text" &&
              (name !== "codex_manual_complete" || key !== "turn_token"),
          )
        )
          throw new Error("Manual completion is unavailable.");
        this.onManualComplete(turnToken, completionArgs.text);
        return {
          content: [{ type: "text", text: "Manual final answer accepted." }],
        };
      }
      const checkpoint = this.#broker.checkpointInstruction(turnToken);
      if (
        name === "codex_tool_call" &&
        args.wire_name === FULL_CHECKPOINT_TOOL
      ) {
        const result = this.#broker.submitCheckpoint(
          turnToken,
          asRecord(args.arguments) ?? {},
        );
        if (this.onManualComplete) {
          // Automatic turns have no manual owner; their browser finishes normally.
          try {
            this.onManualComplete(
              turnToken,
              String(asRecord(args.arguments)?.summary ?? ""),
            );
          } catch {
            /* no manual owner */
          }
        }
        return result;
      }
      if (checkpoint && name !== "codex_tool_inventory") return checkpoint;
      let result: unknown;
      if (name === "codex_tool_inventory") {
        const query = typeof args.query === "string" ? args.query : "";
        const completionQuery =
          this.onManualComplete &&
          !checkpoint &&
          [MANUAL_COMPLETION_TOOL, "codex_manual_complete"].includes(
            query.trim().toLocaleLowerCase(),
          );
        const inventory = completionQuery
          ? {
              tools:
                typeof args.offset === "number" && args.offset > 0
                  ? []
                  : [manualCompletionTool],
              total: 1,
              nextOffset: null,
            }
          : await this.#nativeRegistry.inventory(
              turnToken,
              query,
              typeof args.offset === "number" ? args.offset : 0,
              typeof args.limit === "number" ? args.limit : 50,
              signal,
            );
        result = {
          content: [{ type: "text", text: JSON.stringify(inventory) }],
          structuredContent: inventory,
        };
      } else if (name === "codex_tool_call") {
        if (typeof args.wire_name !== "string") {
          throw new Error("codex_tool_call requires wire_name.");
        }
        result = await this.#nativeRegistry.invoke(
          turnToken,
          args.wire_name,
          { arguments: args.arguments, input: args.input },
          signal,
        );
      } else if (name === "codex_exec") {
        if (typeof args.cmd !== "string" || args.cmd.length === 0) {
          throw new Error("codex_exec requires cmd.");
        }
        const permissionArguments = {
          ...(typeof args.sandbox_permissions === "string"
            ? { sandbox_permissions: args.sandbox_permissions }
            : {}),
          ...(typeof args.justification === "string"
            ? { justification: args.justification }
            : {}),
          ...(Array.isArray(args.prefix_rule)
            ? { prefix_rule: args.prefix_rule }
            : {}),
        };
        const execCommandArguments = {
          cmd: args.cmd,
          ...(typeof args.workdir === "string"
            ? { workdir: args.workdir }
            : {}),
          ...(typeof args.yield_time_ms === "number"
            ? { yield_time_ms: args.yield_time_ms }
            : {}),
          max_output_tokens: commandOutputTokenBudget(args.max_output_tokens),
          ...(typeof args.tty === "boolean" ? { tty: args.tty } : {}),
          ...permissionArguments,
        };
        const shellCommandArguments = {
          command: args.cmd,
          ...(typeof args.workdir === "string"
            ? { workdir: args.workdir }
            : {}),
          ...(typeof args.yield_time_ms === "number"
            ? { timeout_ms: args.yield_time_ms }
            : {}),
          ...permissionArguments,
        };
        const command =
          exactTool(this.#broker, turnToken, "exec_command") ??
          exactTool(this.#broker, turnToken, "shell_command");
        if (command) {
          result = await this.#broker.invoke(
            turnToken,
            command.wireName,
            {
              arguments:
                command.name === "exec_command"
                  ? execCommandArguments
                  : shellCommandArguments,
            },
            signal,
          );
        } else {
          const gateway = exactTool(this.#broker, turnToken, "exec");
          if (!gateway || gateway.kind !== "custom") {
            throw new Error(
              "This Codex turn did not advertise a native command tool or freeform exec gateway.",
            );
          }
          result = await this.#broker.invoke(
            turnToken,
            gateway.wireName,
            {
              input: commandGatewayProgram(
                execCommandArguments,
                shellCommandArguments,
              ),
            },
            signal,
          );
        }
        const commandSessionId = resultSessionId(result);
        if (commandSessionId !== undefined) {
          let owned = this.#commandSessions.get(turnToken);
          if (!owned) {
            owned = new Set();
            this.#commandSessions.set(turnToken, owned);
          }
          owned.add(commandSessionId);
        }
      } else if (name === "codex_write_stdin") {
        if (
          typeof args.session_id !== "number" ||
          !Number.isSafeInteger(args.session_id) ||
          args.session_id < 0
        ) {
          throw new Error(
            "codex_write_stdin requires a non-negative session_id.",
          );
        }
        if (!this.#commandSessions.get(turnToken)?.has(args.session_id)) {
          throw new Error(
            "codex_write_stdin rejected a session_id that was not returned by codex_exec for this turn.",
          );
        }
        const payload = {
          session_id: args.session_id,
          ...(typeof args.chars === "string" ? { chars: args.chars } : {}),
          ...(typeof args.yield_time_ms === "number"
            ? { yield_time_ms: args.yield_time_ms }
            : {}),
          max_output_tokens: commandOutputTokenBudget(args.max_output_tokens),
        };
        const tool = exactTool(this.#broker, turnToken, "write_stdin");
        const gateway = exactTool(this.#broker, turnToken, "exec");
        result = tool
          ? await this.#broker.invoke(
              turnToken,
              tool.wireName,
              { arguments: payload },
              signal,
            )
          : gateway?.kind === "custom"
            ? await this.#broker.invoke(
                turnToken,
                gateway.wireName,
                { input: nestedToolProgram("write_stdin", payload) },
                signal,
              )
            : (() => {
                throw new Error(
                  "This Codex turn did not advertise write_stdin or the freeform exec gateway.",
                );
              })();
      } else if (name === "codex_apply_patch") {
        if (typeof args.patch !== "string" || args.patch.length === 0) {
          throw new Error("codex_apply_patch requires patch.");
        }
        const tool = exactTool(this.#broker, turnToken, "apply_patch");
        const gateway = exactTool(this.#broker, turnToken, "exec");
        result = tool
          ? await this.#broker.invoke(
              turnToken,
              tool.wireName,
              tool.kind === "custom"
                ? { input: args.patch }
                : { arguments: { input: args.patch } },
              signal,
            )
          : gateway?.kind === "custom"
            ? await this.#broker.invoke(
                turnToken,
                gateway.wireName,
                { input: nestedToolProgram("apply_patch", args.patch) },
                signal,
              )
            : (() => {
                throw new Error(
                  "This Codex turn did not advertise apply_patch or the freeform exec gateway.",
                );
              })();
      } else if (name === "codex_view_image") {
        if (typeof args.path !== "string" || args.path.length === 0) {
          throw new Error("codex_view_image requires path.");
        }
        const payload = {
          path: args.path,
          ...(args.detail === "high" || args.detail === "original"
            ? { detail: args.detail }
            : {}),
        };
        const tool = exactTool(this.#broker, turnToken, "view_image");
        const gateway = exactTool(this.#broker, turnToken, "exec");
        result = tool
          ? await this.#broker.invoke(
              turnToken,
              tool.wireName,
              { arguments: payload },
              signal,
            )
          : gateway?.kind === "custom"
            ? await this.#broker.invoke(
                turnToken,
                gateway.wireName,
                { input: nestedToolProgram("view_image", payload) },
                signal,
              )
            : (() => {
                throw new Error(
                  "This Codex turn did not advertise view_image or the freeform exec gateway.",
                );
              })();
      } else {
        throw new Error(`Unknown Full MCP tool: ${name}`);
      }
      return result;
    } catch (error) {
      return fullTurnError(error);
    }
  }

  #pruneSessions(): void {
    this.#nativeRegistry.prune();
    const cutoff = Date.now() - MCP_SESSION_TTL_MS;
    for (const [sessionId, session] of this.#sessions) {
      for (const [key, invocation] of session.requests) {
        if (
          invocation.settledAt !== undefined &&
          invocation.settledAt + BRIDGE_FULL_REPLAY_TTL_MS <= Date.now() &&
          !this.#broker.isActive(invocation.turnToken)
        )
          session.requests.delete(key);
      }
      if (session.lastAccess <= cutoff) this.#sessions.delete(sessionId);
    }
    for (const turnToken of this.#commandSessions.keys()) {
      if (!this.#broker.isActive(turnToken)) {
        this.#commandSessions.delete(turnToken);
      }
    }
  }
}
