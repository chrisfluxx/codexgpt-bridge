import { createHash } from "node:crypto";
import { isBridgeProgressMessage } from "./bridge-progress.js";
import { canonicalJson } from "./operation-identity.js";
import { responseFormatValidator } from "./tool-validation.js";
type JsonRecord = Record<string, unknown>;

const MAX_OUTPUT_FORMAT_CHARS = 1024 * 1024;

function asRecord(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRecord;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      const record = asRecord(part);
      if (record === undefined) return "";
      const type = typeof record.type === "string" ? record.type : "";
      if (type === "input_text" || type === "output_text" || type === "text") {
        return typeof record.text === "string" ? record.text : "";
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

export interface CompiledResponsesImage {
  readonly ref: string;
  readonly imageUrl: string;
  readonly detail?: string;
}

export interface CompiledResponsesToolResult {
  readonly callId: string;
  readonly kind:
    "function_call_output" | "custom_tool_call_output" | "tool_search_output";
  readonly output: string;
  /** Original native result for Full MCP multimodal delivery; never prompt text. */
  readonly nativeOutput?: unknown;
  readonly toolName?: string;
}

interface CompiledUserContent {
  readonly prompt: string;
  readonly images: readonly CompiledResponsesImage[];
}

function userContent(value: unknown): CompiledUserContent {
  const prompt = contentText(value).trim();
  if (!Array.isArray(value)) return { prompt, images: [] };

  const images: CompiledResponsesImage[] = [];
  for (const part of value) {
    const record = asRecord(part);
    if (
      record?.type !== "input_image" ||
      typeof record.image_url !== "string"
    ) {
      continue;
    }
    images.push({
      ref: `codex-input-image-${images.length + 1}`,
      imageUrl: record.image_url,
      ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
    });
  }
  return { prompt, images };
}

function itemText(item: unknown): string {
  if (typeof item === "string") return item;
  const record = asRecord(item);
  if (record === undefined) return "";

  const text = contentText(record.content);
  if (text.length > 0) return text;

  if (
    record.type === "function_call_output" ||
    record.type === "custom_tool_call_output"
  ) {
    const output =
      typeof record.output === "string"
        ? record.output
        : JSON.stringify(record.output ?? null);
    return output;
  }
  return "";
}

function callWireName(record: JsonRecord): string | undefined {
  if (typeof record.name !== "string" || record.name.length === 0)
    return undefined;
  const namespace =
    typeof record.namespace === "string" &&
    record.namespace.length > 0 &&
    record.namespace !== "functions"
      ? record.namespace
      : undefined;
  return namespace === undefined ? record.name : `${namespace}__${record.name}`;
}

function toolCallsById(input: readonly unknown[]): Map<string, string> {
  const calls = new Map<string, string>();
  for (const value of input) {
    const record = asRecord(value);
    if (
      record === undefined ||
      (record.type !== "function_call" &&
        record.type !== "custom_tool_call" &&
        record.type !== "tool_search_call") ||
      typeof record.call_id !== "string"
    ) {
      continue;
    }
    const name =
      record.type === "tool_search_call" ? "tool_search" : callWireName(record);
    if (name !== undefined) calls.set(record.call_id, name);
  }
  return calls;
}

function serializedToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .map((part) => {
        const record = asRecord(part);
        if (record === undefined) return "";
        return record.type === "text" ||
          record.type === "input_text" ||
          record.type === "output_text"
          ? typeof record.text === "string"
            ? record.text
            : ""
          : "";
      })
      .filter((part) => part.length > 0)
      .join("\n");
    if (text.length > 0) return text;
    return JSON.stringify(value, (key, item: unknown) =>
      key === "image_url" ? "[attached image]" : item,
    );
  }
  return JSON.stringify(value ?? null) ?? String(value ?? "");
}

function toolOutputImages(
  value: unknown,
  startIndex: number,
): CompiledResponsesImage[] {
  if (!Array.isArray(value)) return [];
  const images: CompiledResponsesImage[] = [];
  for (const part of value) {
    const record = asRecord(part);
    if (
      record === undefined ||
      (record.type !== "input_image" && record.type !== "output_image") ||
      typeof record.image_url !== "string"
    ) {
      continue;
    }
    images.push({
      ref: `codex-tool-image-${startIndex + images.length + 1}`,
      imageUrl: record.image_url,
      ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
    });
  }
  return images;
}

function isTrailingToolSideEffect(record: JsonRecord): boolean {
  if (record.type === "world_state") return true;
  if (record.type !== "message" || record.role !== "user") return false;
  const metadata = asRecord(record.internal_chat_message_metadata_passthrough);
  const kinds = Array.isArray(metadata?.content_item_kinds)
    ? metadata.content_item_kinds
    : [];
  if (kinds.includes("multi_agent.subagent_notification")) return true;
  const text = contentText(record.content).trim();
  return (
    text.startsWith("<subagent_notification>") &&
    text.endsWith("</subagent_notification>")
  );
}

function trailingToolResults(
  input: readonly unknown[],
  allCanonical = false,
): {
  readonly results: readonly CompiledResponsesToolResult[];
  readonly images: readonly CompiledResponsesImage[];
} {
  const calls = toolCallsById(input);
  const records: JsonRecord[] = [];
  let foundResult = false;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const record = asRecord(input[index]);
    if (record === undefined) {
      if (allCanonical) continue;
      break;
    }
    if (
      (record.type === "function_call_output" ||
        record.type === "custom_tool_call_output" ||
        record.type === "tool_search_output") &&
      typeof record.call_id === "string" &&
      record.call_id.length > 0
    ) {
      foundResult = true;
      records.unshift(record);
      continue;
    }
    if (isTrailingToolSideEffect(record)) continue;
    if (allCanonical) continue;
    break;
  }

  if (!foundResult) return { results: [], images: [] };

  const results: CompiledResponsesToolResult[] = [];
  const images: CompiledResponsesImage[] = [];
  for (const record of records) {
    const callId = record.call_id as string;
    const kind = record.type as CompiledResponsesToolResult["kind"];
    const value =
      kind === "tool_search_output"
        ? {
            status: record.status ?? "completed",
            tools: Array.isArray(record.tools) ? record.tools : [],
          }
        : record.output;
    const output = serializedToolOutput(value);
    const toolName =
      kind === "tool_search_output" ? "tool_search" : calls.get(callId);
    results.push({
      callId,
      kind,
      output,
      ...(value !== null && typeof value === "object"
        ? { nativeOutput: structuredClone(value) }
        : {}),
      ...(toolName === undefined ? {} : { toolName }),
    });
    images.push(...toolOutputImages(record.output, images.length));
  }
  return { results, images };
}

function loadedToolDefinitions(input: readonly unknown[]): unknown[] {
  const tools: unknown[] = [];
  for (const value of input) {
    const record = asRecord(value);
    if (
      (record?.type === "additional_tools" ||
        record?.type === "tool_search_output") &&
      Array.isArray(record.tools)
    ) {
      tools.push(...record.tools);
    }
  }
  return tools;
}

function latestUserContent(
  input: readonly unknown[],
): CompiledUserContent | undefined {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = asRecord(input[index]);
    if (item === undefined || isTrailingToolSideEffect(item)) continue;
    const delegated =
      (item.type === "function_call_output" ||
        item.type === "custom_tool_call_output") &&
      (typeof item.call_id !== "string" || item.call_id.length === 0) &&
      item.name === "send_message_to_thread";
    if (item.role !== "user" && !delegated) continue;
    const compiled = delegated
      ? { prompt: itemText(item).trim(), images: [] }
      : userContent(item.content);
    if (compiled.prompt.length > 0 || compiled.images.length > 0)
      return compiled;
  }
  return undefined;
}

function latestInputText(input: readonly unknown[]): string | undefined {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const text = itemText(input[index]).trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

export interface BridgeContext {
  readonly instructions: string;
  readonly history: readonly string[];
  readonly ledger: readonly string[];
  readonly images: readonly CompiledResponsesImage[];
}

export type BridgeTextFormat =
  | { readonly type: "text" }
  | { readonly type: "json_object" }
  | {
      readonly type: "json_schema";
      readonly name: string;
      readonly schema: JsonRecord;
      readonly strict?: boolean;
      readonly description?: string;
    };

export interface CompiledResponsesPrompt {
  readonly forwardedCommentaryIds?: readonly string[];
  readonly context: BridgeContext;
  readonly compaction?: boolean;
  readonly toolChoice: unknown;
  readonly parallelToolCalls: boolean;
  readonly prompt: string;
  readonly images: readonly CompiledResponsesImage[];
  readonly textFormat: BridgeTextFormat;
  readonly verbosity?: "low" | "medium" | "high";
  /** Stable native Codex turn identity used only for reconnect-safe browser replay. */
  readonly turnId?: string;
  /** Checkpoint boundary within a native turn; stable across tools and reconnects. */
  readonly contextEpoch?: string;
  readonly threadId?: string;
  /** Native workspace identity, never extracted from assistant text or tool output. */
  readonly cwd?: string;
  /** Bounded prose history, used only when creating a new task-bound Web conversation. */
  readonly conversationHistory?: string;
  readonly hasToolDefinitions: boolean;
  readonly toolChoiceRequired: boolean;
  readonly toolDefinitions: readonly unknown[];
  readonly toolResults: readonly CompiledResponsesToolResult[];
  /** Canonical results available only to an exact-source Full checkpoint handoff. */
  readonly compactionToolResults?: readonly CompiledResponsesToolResult[];
}

function responsesTextFormat(record: JsonRecord): BridgeTextFormat {
  if (record.text === undefined) return { type: "text" };
  const text = asRecord(record.text);
  if (text === undefined)
    throw new Error("Responses text configuration must be an object.");
  if (text.format === undefined) return { type: "text" };
  const format = asRecord(text.format);
  if (format === undefined)
    throw new Error("Responses text format must be an object.");
  if (format.type === "text") return { type: "text" };
  if (format.type === "json_object") return { type: "json_object" };
  if (format.type !== "json_schema")
    throw new Error(
      `Unsupported Responses text format: ${String(format.type)}`,
    );
  if (
    typeof format.name !== "string" ||
    format.name.length === 0 ||
    format.name.length > 64
  )
    throw new Error(
      "Responses JSON Schema format requires a name of 1 to 64 characters.",
    );
  const schema = asRecord(format.schema);
  if (schema === undefined)
    throw new Error("Responses JSON Schema format requires a schema object.");
  if (format.strict !== undefined && typeof format.strict !== "boolean")
    throw new Error("Responses JSON Schema strict must be a boolean.");
  if (
    format.description !== undefined &&
    typeof format.description !== "string"
  )
    throw new Error("Responses JSON Schema description must be a string.");
  if (JSON.stringify(format).length > MAX_OUTPUT_FORMAT_CHARS)
    throw new Error("Responses output schema exceeds the browser budget.");
  responseFormatValidator(schema);
  return {
    type: "json_schema",
    name: format.name,
    schema,
    ...(typeof format.strict === "boolean" ? { strict: format.strict } : {}),
    ...(typeof format.description === "string"
      ? { description: format.description }
      : {}),
  };
}

function safeTurnId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{6,128}$/.test(value)
    ? value
    : undefined;
}

function turnIdFromMetadata(
  value: unknown,
  field: "turn_id" | "thread_id",
): string | undefined {
  const metadata = asRecord(value);
  return safeTurnId(metadata?.[field]);
}

function responsesTurnId(
  record: JsonRecord,
  field: "turn_id" | "thread_id",
): string | undefined {
  const clientMetadata = asRecord(record.client_metadata);
  const encoded = clientMetadata?.["x-codex-turn-metadata"];
  if (typeof encoded === "string") {
    try {
      const parsed = turnIdFromMetadata(JSON.parse(encoded) as unknown, field);
      if (parsed !== undefined) return parsed;
    } catch {
      // Fall through to the other native metadata locations.
    }
  } else {
    const parsed = turnIdFromMetadata(encoded, field);
    if (parsed !== undefined) return parsed;
  }

  const direct = turnIdFromMetadata(record.metadata, field);
  if (direct !== undefined) return direct;

  if (Array.isArray(record.input)) {
    for (let index = record.input.length - 1; index >= 0; index -= 1) {
      const item = asRecord(record.input[index]);
      const itemTurnId = turnIdFromMetadata(
        item?.internal_chat_message_metadata_passthrough,
        field,
      );
      if (itemTurnId !== undefined) return itemTurnId;
    }
  }
  return undefined;
}

export function responsesNativeTurnIdentity(
  value: unknown,
): { readonly threadId: string; readonly turnId: string } | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const identity = (
    candidate: unknown,
  ): { readonly threadId: string; readonly turnId: string } | undefined => {
    const metadata = asRecord(candidate);
    const threadId = safeTurnId(metadata?.thread_id);
    const turnId = safeTurnId(metadata?.turn_id);
    return threadId && turnId ? { threadId, turnId } : undefined;
  };
  const clientMetadata = asRecord(record.client_metadata);
  const encoded = clientMetadata?.["x-codex-turn-metadata"];
  if (typeof encoded === "string") {
    try {
      const found = identity(JSON.parse(encoded) as unknown);
      if (found) return found;
    } catch {
      // Fall through to the other native metadata locations.
    }
  } else {
    const found = identity(encoded);
    if (found) return found;
  }
  const direct = identity(record.metadata);
  if (direct) return direct;
  if (Array.isArray(record.input)) {
    for (let index = record.input.length - 1; index >= 0; index -= 1) {
      const item = asRecord(record.input[index]);
      const found = identity(item?.internal_chat_message_metadata_passthrough);
      if (found) return found;
    }
  }
  return undefined;
}

function responsesCwd(record: JsonRecord): string | undefined {
  const path = (value: unknown): string | undefined =>
    typeof value === "string" &&
    value.length <= 4096 &&
    ![...value].some((character) => character.charCodeAt(0) < 32) &&
    /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value)
      ? value
      : undefined;
  const client = asRecord(record.client_metadata);
  let native = client?.["x-codex-turn-metadata"];
  if (typeof native === "string") {
    try {
      native = JSON.parse(native) as unknown;
    } catch {
      native = undefined;
    }
  }
  const explicit =
    path(asRecord(native)?.cwd) ?? path(asRecord(record.metadata)?.cwd);
  if (explicit) return explicit;
  if (!Array.isArray(record.input)) return undefined;
  for (const value of [...record.input].reverse()) {
    const item = asRecord(value);
    if (
      item?.role !== "user" &&
      item?.role !== "developer" &&
      item?.role !== "system"
    )
      continue;
    const fromMetadata = path(
      asRecord(item.internal_chat_message_metadata_passthrough)?.cwd,
    );
    if (fromMetadata) return fromMetadata;
    // Only a standalone native environment block, optionally preceded by the
    // native plugin catalog, is routing context. Quoted examples are not.
    const text = contentText(item.content).trim();
    const environment =
      /^(?:<recommended_plugins>[\s\S]*?<\/recommended_plugins>\s*)?<environment_context>([\s\S]*?)<\/environment_context>$/.exec(
        text,
      );
    const cwd = environment && /<cwd>([^<>]+)<\/cwd>/.exec(environment[1]!);
    const found = path(cwd?.[1]?.trim());
    if (found) return found;
  }
  return undefined;
}

export function compileResponsesPrompt(body: unknown): CompiledResponsesPrompt {
  const raw = asRecord(body);
  if (raw === undefined) {
    throw new Error("Responses body must be a JSON object.");
  }
  const record = Array.isArray(raw.input)
    ? {
        ...raw,
        input: raw.input.filter((item) => !isBridgeProgressMessage(item)),
      }
    : raw;

  const compaction =
    record.bridge_compaction === true ||
    (Array.isArray(record.input) &&
      record.input.some(
        (value) => asRecord(value)?.type === "compaction_trigger",
      ));
  const textFormat = compaction
    ? ({ type: "text" } as const)
    : responsesTextFormat(record);
  if (compaction && Array.isArray(record.input)) {
    const pending = new Set<string>();
    for (const value of record.input) {
      const item = asRecord(value);
      if (typeof item?.call_id !== "string") continue;
      if (
        ["function_call", "custom_tool_call", "tool_search_call"].includes(
          String(item.type),
        )
      )
        pending.add(item.call_id);
      if (
        [
          "function_call_output",
          "custom_tool_call_output",
          "tool_search_output",
        ].includes(String(item.type))
      )
        pending.delete(item.call_id);
    }
    if (pending.size)
      throw new Error(
        "Cannot compact before outstanding tool calls have returned.",
      );
  }
  let prompt: string | undefined;
  let images: readonly CompiledResponsesImage[] = [];
  let toolResults: readonly CompiledResponsesToolResult[] = [];
  let loadedTools: readonly unknown[] = [];
  if (typeof record.input === "string") {
    prompt = record.input.trim();
  } else if (Array.isArray(record.input)) {
    // Keep the current payload separate from canonical history and instructions.
    // The browser synchronizer sends only the parts missing from its retained chat.
    const user = latestUserContent(record.input);
    prompt = user?.prompt ?? latestInputText(record.input);
    images = user?.images ?? [];
    const trailing = trailingToolResults(record.input);
    toolResults = trailing.results;
    loadedTools = loadedToolDefinitions(record.input);
    if (toolResults.length > 0) images = trailing.images;
  }

  const checkpointItems = Array.isArray(record.input)
    ? record.input.filter((value) => {
        const item = asRecord(value);
        return (
          item?.type === "compaction" ||
          (item?.role === "user" &&
            contentText(item.content).startsWith("[Codex checkpoint:"))
        );
      })
    : [];
  const lastCheckpointIndex = Array.isArray(record.input)
    ? record.input.reduce(
        (last, value, index) =>
          checkpointItems.includes(value) ? index : last,
        -1,
      )
    : -1;
  const lastUserIndex = Array.isArray(record.input)
    ? record.input.reduce(
        (last, value, index) =>
          asRecord(value)?.role === "user" ? index : last,
        -1,
      )
    : -1;
  const checkpointResume =
    !compaction &&
    Array.isArray(record.input) &&
    checkpointItems.length > 0 &&
    (lastCheckpointIndex > lastUserIndex ||
      latestUserContent(record.input)?.prompt.startsWith("[Codex checkpoint:"));
  if (checkpointResume)
    prompt =
      "Continue the current Codex task from the checkpoint in the synchronized history. The Bridge context checkpoint has already been accepted; its internal receipt and control phase are complete, even if the summary describes them as pending. Resume only the user's task, following the user's goal, constraints and requested final response format preserved in that history. Do not resubmit the checkpoint or repeat completed actions.";
  if (compaction) {
    prompt =
      "Create a context checkpoint for this Codex task. Summarize the user's goal, current instructions and constraints, completed actions, decisions, files and references, test results, remaining work and next steps. Preserve exact critical identifiers. Do not execute any tools or repeat completed actions. Return only the checkpoint text.";
    toolResults = [];
  }
  const declaredTools = Array.isArray(record.tools) ? record.tools : [];
  const toolChoice = asRecord(record.tool_choice);
  const toolsDisabled =
    compaction || record.tool_choice === "none" || toolChoice?.mode === "none";
  const toolDefinitions = toolsDisabled
    ? []
    : [...loadedTools, ...declaredTools];
  const hasToolDefinitions = toolDefinitions.length > 0;
  const toolChoiceRequired =
    record.tool_choice === "required" || toolChoice?.mode === "required";
  if (
    (prompt === undefined || prompt.length === 0) &&
    images.length === 0 &&
    toolResults.length === 0
  )
    throw new Error("Responses request contains no textual input.");
  const turnId = responsesTurnId(record, "turn_id");
  const threadId = responsesTurnId(record, "thread_id");
  const cwd = responsesCwd(record);
  const items = Array.isArray(record.input)
    ? record.input
    : typeof record.input === "string"
      ? [{ role: "user", content: record.input }]
      : [];
  const instructionItems = items
    .map(asRecord)
    .filter((item) => item?.role === "system" || item?.role === "developer");
  const instructions = JSON.stringify({
    instructions: record.instructions ?? "",
    messages: instructionItems.map((item) => ({
      role: item?.role,
      content: item?.content,
    })),
  });
  const historyImages: CompiledResponsesImage[] = [];
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    const item = asRecord(value);
    if (!item) return value;
    // Responses replays generated image bytes in `result`, not `image_url`.
    // Keep those bytes out of the composer while preserving the image as context.
    if (
      item.type === "image_generation_call" &&
      typeof item.result === "string" &&
      item.result.length > 0
    ) {
      const format =
        item.output_format === "jpeg" || item.output_format === "webp"
          ? item.output_format
          : "png";
      const image = canonical({
        type: "output_image",
        image_url: item.result.startsWith("data:image/")
          ? item.result
          : `data:image/${format};base64,${item.result}`,
      }) as JsonRecord;
      return canonical({
        ...item,
        result: undefined,
        image_ref: image.image_ref,
      });
    }
    if (item.type === "compaction") {
      const encoded = String(item.encrypted_content ?? "");
      if (!encoded.startsWith("cgb1:"))
        throw new Error(
          "Cannot restore an opaque compaction checkpoint in ChatGPT Web.",
        );
      return {
        type: "checkpoint",
        text: Buffer.from(encoded.slice(5), "base64").toString("utf8"),
      };
    }
    if (typeof item.image_url === "string") {
      const ref =
        "context-image-" +
        createHash("sha256").update(item.image_url).digest("hex").slice(0, 16);
      const existing = historyImages.findIndex((image) => image.ref === ref);
      const detail = typeof item.detail === "string" ? item.detail : undefined;
      const image = {
        ref,
        imageUrl: item.image_url,
        ...(detail ? { detail } : {}),
      };
      if (existing < 0) historyImages.push(image);
      else if (
        detail === "original" ||
        (detail && historyImages[existing]?.detail !== "original")
      )
        historyImages[existing] = image;
      return { type: item.type, image_ref: ref, ...(detail ? { detail } : {}) };
    }
    return Object.fromEntries(
      Object.entries(item)
        .filter(
          ([key, value]) =>
            ![
              "id",
              "status",
              "internal_chat_message_metadata_passthrough",
            ].includes(key) &&
            !(
              key === "annotations" &&
              ["input_text", "output_text", "text"].includes(
                String(item.type),
              ) &&
              Array.isArray(value) &&
              value.length === 0
            ),
        )
        .map(([key, value]) => [key, canonical(value)]),
    );
  };
  const relevant = items.filter((value) => {
    const item = asRecord(value);
    return (
      item?.role !== "developer" &&
      item?.role !== "system" &&
      item?.type !== "compaction_trigger" &&
      item?.type !== "additional_tools"
    );
  });
  let currentStart = relevant.length;
  if (compaction || checkpointResume) currentStart = relevant.length;
  else if (toolResults.length) {
    const resultKeys = new Set(
      toolResults.map((result) => `${result.kind}:${result.callId}`),
    );
    const found = new Set<string>();
    for (let index = relevant.length - 1; index >= 0; index -= 1) {
      const item = asRecord(relevant[index]);
      const key =
        item && typeof item.call_id === "string"
          ? `${String(item.type)}:${item.call_id}`
          : undefined;
      if (key !== undefined && resultKeys.has(key) && !found.has(key)) {
        found.add(key);
        currentStart = index;
        if (found.size === resultKeys.size) break;
      }
    }
  } else {
    for (let index = relevant.length - 1; index >= 0; index--) {
      if (asRecord(relevant[index])?.role === "user") {
        currentStart = index;
        break;
      }
    }
  }
  // Rebuilt input may reorder keys and omit empty text annotations. Neither
  // changes the conversation, so neither should reset a retained browser chat.
  const serialized = relevant.map((item) => canonicalJson(canonical(item)));
  const contextEpoch = checkpointItems.length
    ? createHash("sha256")
        .update(canonicalJson(checkpointItems.map((item) => canonical(item))))
        .digest("hex")
    : undefined;
  const history = serialized.slice(0, currentStart);
  const currentMessages = relevant.slice(currentStart);
  // Native Codex may append an agent_message after the human user message. The
  // old latest-user shortcut silently omitted that steering message while still
  // recording its ledger hash as delivered. Preserve the ordered current suffix
  // as a typed envelope whenever it contains more than the plain user message.
  if (
    toolResults.length === 0 &&
    currentMessages.some((item) => asRecord(item)?.type === "agent_message")
  ) {
    prompt =
      "[Current Codex messages: interpret roles and routing fields literally]\n" +
      JSON.stringify(currentMessages.map((item) => canonical(item)));
  }
  const ledger = serialized.map((item) =>
    createHash("sha256").update(item).digest("hex"),
  );
  const context: BridgeContext = {
    instructions,
    history,
    ledger,
    images: historyImages,
  };
  return {
    prompt: prompt ?? "",
    ...(() => {
      const ids = Array.isArray(record.input)
        ? record.input
            .map(asRecord)
            .filter(
              (item) =>
                item?.role === "assistant" && item.phase === "commentary",
            )
            .map((item) => item?.id)
            .filter(
              (id): id is string =>
                typeof id === "string" &&
                /^msg_bridge_commentary_[a-f0-9]{64}$/.test(id),
            )
        : [];
      return ids.length ? { forwardedCommentaryIds: ids } : {};
    })(),
    images,
    textFormat,
    ...(() => {
      const verbosity = asRecord(record.text)?.verbosity;
      if (verbosity === undefined) return {};
      if (!["low", "medium", "high"].includes(String(verbosity)))
        throw new Error("text.verbosity must be low, medium, or high.");
      return { verbosity: verbosity as "low" | "medium" | "high" };
    })(),
    ...(turnId === undefined ? {} : { turnId }),
    ...(contextEpoch === undefined ? {} : { contextEpoch }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(cwd === undefined ? {} : { cwd }),
    context,
    ...(compaction
      ? {
          compaction: true,
          compactionToolResults: Array.isArray(record.input)
            ? trailingToolResults(record.input, true).results
            : [],
        }
      : {}),
    toolChoice: compaction ? "none" : (record.tool_choice ?? "auto"),
    parallelToolCalls: record.parallel_tool_calls !== false,
    hasToolDefinitions,
    toolChoiceRequired,
    toolDefinitions,
    toolResults,
  };
}
