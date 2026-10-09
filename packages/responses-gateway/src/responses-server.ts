import { BridgeTextStream, BridgeStreamError } from "./text-stream.js";
import {
  publicCommentaryOutputId,
  type BridgePublicCommentary,
} from "./public-commentary.js";
import {
  bridgeProgressDisplayStage,
  bridgeProgressText,
  isBridgeProgressMessage,
  type BridgeProgressStage,
} from "./bridge-progress.js";
export type { BridgeProgressStage } from "./bridge-progress.js";
import { canonicalJson, responsesOperationId } from "./operation-identity.js";
import type { BridgeContext } from "./prompt.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from "node:zlib";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
  compileResponsesPrompt,
  responsesNativeTurnIdentity,
  type BridgeTextFormat,
  type CompiledResponsesImage,
  type CompiledResponsesPrompt,
} from "./prompt.js";
import {
  parseBridgeGeneratedImagesEnvelope,
  bridgeCompactionRepairPrompt,
  bridgeStructuredOutputRepairPrompt,
  bridgeToolRepairPrompt,
  parseBridgeWebTurnResult,
  prepareBridgeWebTurn,
  UnsupportedWebNativeToolError,
  type BridgeToolCall,
  type BridgeGeneratedImagesResult,
  type BridgeWebTurnResult,
} from "./tool-protocol.js";
import { responseFormatValidator } from "./tool-validation.js";
import type { FullTurnBroker } from "./full-turn-broker.js";
import {
  FullMcpUnavailableError,
  RetainedFullSourceUnavailableError,
  FullTurnCoordinator,
  fullContract,
} from "./full-turn-coordinator.js";
import {
  estimateBridgeInputTokenBreakdown,
  estimateBridgeTextTokens,
} from "./input-tokens.js";
import { planBridgeCompactionStages } from "./compaction-staging.js";
import { FullContextTransferError } from "./full-context-transfer.js";
import {
  LunaCheckpointStore,
  LunaCheckpointError,
} from "./luna-checkpoints.js";
import {
  BRIDGE_NATIVE_MODEL_ROUTES,
  availableNativeModelRoutes,
  bridgeCatalogNativeFamilies,
  resolveNativeRouteEffort,
  BridgeReasoningEffortError,
  type BridgeNativeEffort,
  type BridgeNativeModelFamily,
} from "./native-model-routes.js";
import {
  resolveBridgeRouteContextBudget,
  type BridgeAccountContextProfile,
} from "./context-budgets.js";
import {
  ProviderDrainingError,
  ProviderLifecycleConflictError,
  ProviderLifecycleController,
  TurnOwnershipRegistry,
  type LifecycleLease,
  type NativeTurnIdentity,
  type ProviderLifecycleStatus,
} from "./provider-lifecycle.js";

export const CODEXGPT_BRIDGE_MODEL_PREFIX = "codexgpt-bridge/";
export type BridgeWebMode =
  "instant" | "medium" | "high" | "extra-high" | "pro" | "luna" | "think";

export interface BridgeWebModelRoute {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly effort: BridgeNativeEffort | "ultra";
  readonly mode: BridgeWebMode;
  readonly contextWindow: number;
  readonly supportedEfforts?: readonly BridgeNativeEffort[];
  readonly nativeFamily?: BridgeNativeModelFamily;
  readonly contextMultiplier?: 3;
  readonly stagedContext?: true;
}

export const BRIDGE_CONTEXT_WINDOW = 95_000;
export const BRIDGE_AUTO_COMPACT_TOKEN_LIMIT = 90_000;
export const BRIDGE_HARD_INPUT_TOKEN_LIMIT = 95_000;
export const BRIDGE_CONTEXT_BUDGET_PROFILE = "bridge-safe-v1";

export interface BridgeContextBudget {
  readonly stagedContext?: true;
  readonly contextWindow: number;
  readonly autoCompactTokenLimit: number;
  readonly hardInputTokenLimit: number;
  readonly browserMessageTokenLimit?: number;
  readonly browserComposerCharLimit?: number;
  readonly profile?: string;
}

/**
 * Bridge-owned transport budgets. They are explicit per Web mode so a mode can
 * be tightened independently after account validation without changing the
 * meaning of every other route.
 */
export const BRIDGE_CONTEXT_BUDGETS: Readonly<
  Record<BridgeWebMode, BridgeContextBudget>
> = Object.freeze({
  instant: {
    contextWindow: BRIDGE_CONTEXT_WINDOW,
    autoCompactTokenLimit: BRIDGE_AUTO_COMPACT_TOKEN_LIMIT,
    hardInputTokenLimit: BRIDGE_HARD_INPUT_TOKEN_LIMIT,
  },
  medium: {
    contextWindow: BRIDGE_CONTEXT_WINDOW,
    autoCompactTokenLimit: BRIDGE_AUTO_COMPACT_TOKEN_LIMIT,
    hardInputTokenLimit: BRIDGE_HARD_INPUT_TOKEN_LIMIT,
  },
  high: {
    contextWindow: BRIDGE_CONTEXT_WINDOW,
    autoCompactTokenLimit: BRIDGE_AUTO_COMPACT_TOKEN_LIMIT,
    hardInputTokenLimit: BRIDGE_HARD_INPUT_TOKEN_LIMIT,
  },
  "extra-high": {
    contextWindow: BRIDGE_CONTEXT_WINDOW,
    autoCompactTokenLimit: BRIDGE_AUTO_COMPACT_TOKEN_LIMIT,
    hardInputTokenLimit: BRIDGE_HARD_INPUT_TOKEN_LIMIT,
  },
  pro: {
    contextWindow: BRIDGE_CONTEXT_WINDOW,
    autoCompactTokenLimit: BRIDGE_AUTO_COMPACT_TOKEN_LIMIT,
    hardInputTokenLimit: BRIDGE_HARD_INPUT_TOKEN_LIMIT,
  },
  luna: {
    contextWindow: BRIDGE_CONTEXT_WINDOW,
    autoCompactTokenLimit: BRIDGE_AUTO_COMPACT_TOKEN_LIMIT,
    hardInputTokenLimit: BRIDGE_HARD_INPUT_TOKEN_LIMIT,
  },
  think: {
    contextWindow: BRIDGE_CONTEXT_WINDOW,
    autoCompactTokenLimit: BRIDGE_AUTO_COMPACT_TOKEN_LIMIT,
    hardInputTokenLimit: BRIDGE_HARD_INPUT_TOKEN_LIMIT,
  },
});

export type BridgeToolTransport = "none" | "simple" | "full";

/** Bounded, prompt-free evidence describing what Bridge is about to submit. */
export interface BridgeExecutionPreflight {
  readonly version: 1;
  readonly route: string;
  readonly mode: BridgeWebMode;
  /** Transport selected for the complete Codex operation. */
  readonly operationToolTransport: BridgeToolTransport;
  /** Transport exposed by this individual browser send. */
  readonly toolTransport: BridgeToolTransport;
  readonly attempt: "initial" | "follow-up";
  readonly toolCount: number;
  /** Complete Codex-side context estimate before retained-chat synchronization. */
  readonly sourceContextTokens: number;
  /** Whether inputTokens describes the complete source or the actual browser payload. */
  readonly inputBasis: "full-context" | "synchronized-payload";
  readonly inputTokens: number;
  readonly textTokens: number;
  readonly textCharacters: number;
  readonly imageCount: number;
  readonly imageReserveTokens: number;
  readonly platformReserveTokens: number;
  readonly contextWindow: number;
  readonly autoCompactTokenLimit: number;
  readonly hardInputTokenLimit: number;
  readonly browserMessageTokenLimit?: number;
  readonly browserComposerCharLimit?: number;
  readonly remainingInputTokens: number;
  readonly status:
    "within-limit" | "compaction-recommended" | "compaction-bypass";
  readonly budgetProfile: string;
  readonly contextMultiplier?: 3;
  readonly stagedContext?: true;
  readonly multipart?: {
    readonly transactionId: string;
    readonly part: number;
    readonly total: number;
    readonly phase: "stage" | "commit";
    readonly digest: string;
  };
}

export const CODEXGPT_BRIDGE_WEB_MODEL_ROUTES: readonly BridgeWebModelRoute[] =
  [
    {
      slug: "codexgpt-bridge/instant",
      displayName: "CodexGPT Bridge — Instant",
      description: "ChatGPT Instant through CodexGPT Bridge.",
      effort: "low",
      mode: "instant",
      contextWindow: BRIDGE_CONTEXT_WINDOW,
    },
    {
      slug: "codexgpt-bridge/medium",
      displayName: "CodexGPT Bridge — Medium",
      description: "ChatGPT Medium through CodexGPT Bridge.",
      effort: "medium",
      mode: "medium",
      contextWindow: BRIDGE_CONTEXT_WINDOW,
    },
    {
      slug: "codexgpt-bridge/high",
      displayName: "CodexGPT Bridge — High",
      description: "ChatGPT High through CodexGPT Bridge.",
      effort: "high",
      mode: "high",
      contextWindow: BRIDGE_CONTEXT_WINDOW,
    },
    {
      slug: "codexgpt-bridge/extra-high",
      displayName: "CodexGPT Bridge — Extra High",
      description: "ChatGPT Extra High through CodexGPT Bridge.",
      effort: "xhigh",
      mode: "extra-high",
      contextWindow: BRIDGE_CONTEXT_WINDOW,
    },
    {
      slug: "codexgpt-bridge/pro",
      displayName: "CodexGPT Bridge — Pro",
      description: "ChatGPT Pro through CodexGPT Bridge.",
      effort: "ultra",
      mode: "pro",
      contextWindow: BRIDGE_CONTEXT_WINDOW,
    },
    {
      slug: "codexgpt-bridge/luna",
      displayName: "CodexGPT Bridge — Luna",
      description: "ChatGPT Luna through CodexGPT Bridge.",
      effort: "low",
      mode: "luna",
      contextWindow: BRIDGE_CONTEXT_WINDOW,
    },
    {
      slug: "codexgpt-bridge/think",
      displayName: "CodexGPT Bridge — Think",
      description: "ChatGPT Luna Think through CodexGPT Bridge.",
      effort: "medium",
      mode: "think",
      contextWindow: BRIDGE_CONTEXT_WINDOW,
    },
  ];

export const CODEXGPT_BRIDGE_WEB_MODEL_IDS =
  CODEXGPT_BRIDGE_WEB_MODEL_ROUTES.map((route) => route.slug);
export const CODEXGPT_BRIDGE_ALL_WEB_MODEL_IDS = [
  ...CODEXGPT_BRIDGE_WEB_MODEL_ROUTES,
  ...BRIDGE_NATIVE_MODEL_ROUTES,
].map((route) => route.slug);
export const CODEXGPT_BRIDGE_PRO_MODEL_ID = "codexgpt-bridge/pro";
const DEFAULT_UPSTREAM = "https://chatgpt.com/backend-api/codex";
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const STREAM_HEARTBEAT_MS = 5_000;
const WEBSOCKET_HEARTBEAT_MS = 10_000;

export interface RunWebTurnInput {
  readonly turnToken?: string;
  readonly requiredSubagentResults?: number;
  readonly silenceTimeoutSeconds?: number;
  readonly autoApproveToolCalls?: boolean;
  /** Internal browser epoch isolation for completed Luna checkpoints. */
  readonly forceNewConversation?: boolean;
  /** Shared native operation identity; browser retries and Responses IDs use the same source. */
  readonly operationId?: string;
  readonly modelFamily?: string;
  readonly prompt: string;
  readonly context?: BridgeContext;
  readonly contract?: string;
  readonly onSnapshot?: (text: string) => void;
  /** Raw, current-message network text; mutable DOM snapshots must not use this. */
  readonly onStreamSnapshot?: (text: string) => void;
  readonly onCommentary?: (commentary: BridgePublicCommentary) => void;
  readonly onProgress?: (stage: BridgeProgressStage) => void;
  readonly images: readonly CompiledResponsesImage[];
  readonly signal: AbortSignal;
  readonly mode: BridgeWebMode;
  /** Prompt-free route, transport and token evidence computed before browser work. */
  readonly execution?: BridgeExecutionPreflight;
  /** Stable across transport reconnects, but different for distinct native Codex turns. */
  readonly turnId?: string;
  readonly threadId?: string;
  readonly cwd?: string;
  /** Optional exact destination used by owned browser tests and retained flows. */
  readonly projectUrl?: string;
  /** Sidebar name resolved locally; never accepted from the model prompt. */
  readonly projectName?: string;
  readonly temporaryChat?: boolean;
  /** A checkpoint control must fail before Send if its exact retained source is missing. */
  readonly requireRetainedConversation?: boolean;
  /** Internal Full transport gates; never accepted from an HTTP request. */
  readonly onContextStaging?: () => void;
  readonly onContextCommit?: () => void;
  readonly conversationHistory?: string;
  /** Full MCP keeps the ChatGPT response alive while its connector awaits Codex. */
  readonly allowWebNativeTools?: boolean;
  /** Exact ChatGPT connector selected for a Full MCP turn. */
  readonly connectorName?: string;
}

export interface ResponsesGatewayOptions {
  readonly lunaCheckpoints?: LunaCheckpointStore;
  readonly admin?: {
    readonly token: string;
    readonly onShutdown?: () => void | Promise<void>;
    readonly onCommand?: (
      command: string,
      args: readonly unknown[],
    ) => Promise<unknown>;
  };
  /** Independent provider: only Bridge Web routes, with a local (not OpenAI) credential. */
  readonly webOnly?: {
    readonly token: string;
    readonly models: () => Promise<unknown>;
  };
  /** Account-proven routes. Undefined preserves the unrestricted compatibility default. */
  readonly availableWebModes?: () =>
    | readonly BridgeWebMode[]
    | undefined
    | Promise<readonly BridgeWebMode[] | undefined>;
  readonly modelFamily?: () => string | undefined | Promise<string | undefined>;
  readonly accountContextProfile?: () =>
    BridgeAccountContextProfile | Promise<BridgeAccountContextProfile>;
  readonly nativeModelFamilies?: () =>
    | readonly BridgeNativeModelFamily[]
    | Promise<readonly BridgeNativeModelFamily[]>;
  readonly host?: "127.0.0.1";
  readonly port?: number;
  /** Provider that Codex used before Bridge installation. All non-Bridge routes pass through to it. */
  readonly upstreamBaseUrl?:
    string | (() => string | undefined | Promise<string | undefined>);
  readonly runWebTurn: (
    input: RunWebTurnInput,
  ) => Promise<string | BridgeGeneratedImagesResult>;
  /**
   * The browser provider recalculates and enforces the hard limit after applying
   * its retained-conversation receipt. This prevents already-synchronized
   * history from being rejected as if it were about to be submitted again.
   */
  readonly receiptAwareContextSync?: boolean;
  readonly fetchImpl?: typeof fetch;
  /** Test seam for the application-level response heartbeat. */
  readonly applicationHeartbeatMs?: number;
  readonly fullMcp?: {
    readonly broker: FullTurnBroker;
    readonly enabled: () => boolean | Promise<boolean>;
    readonly connectorName: () => string | Promise<string>;
  };
}

export interface ResponsesGatewayAddress {
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
}

type JsonRecord = Record<string, unknown>;

interface ResponseStreamState {
  readonly model: string;
  readonly responseId: string;
  readonly messageId: string;
  readonly createdAt: number;
  readonly textFormat: BridgeTextFormat;
  sequenceNumber: number;
  streamedText?: string;
  textStarted?: boolean;
  inputTokens?: number;
  progressItems?: JsonRecord[];
  progressStages?: Set<BridgeProgressStage>;
}

type ResponseEventWriter = (type: string, payload: JsonRecord) => void;

function asRecord(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRecord;
}

function transportDisconnectError(): DOMException {
  return new DOMException("Responses transport disconnected.", "NetworkError");
}

function destroyHttpExchange(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  if (!response.destroyed) response.destroy();
  if (!request.destroyed) request.destroy();
}

function guardHttpExchange(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  // Stream error events do not enter the async request handler's try/catch.
  // A Codex reconnect can therefore turn an ordinary TCP RST into an
  // uncaught Electron main-process exception unless both halves are guarded.
  request.on("error", () => destroyHttpExchange(request, response));
  response.on("error", () => {
    if (!request.destroyed) request.destroy();
  });
}

function guardSocket(socket: Duplex): void {
  socket.on("error", () => {
    if (!socket.destroyed) socket.destroy();
  });
}

function bearer(headers: IncomingHttpHeaders): string | undefined {
  const value = headers.authorization;
  if (typeof value !== "string" || !/^Bearer\s+\S+$/i.test(value))
    return undefined;
  return value;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function decodedBody(headers: IncomingHttpHeaders, body: Buffer): Buffer {
  const value = headers["content-encoding"];
  const encodings = (Array.isArray(value) ? value.join(",") : (value ?? ""))
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding.length !== 0 && encoding !== "identity")
    .reverse();
  let output = body;
  for (const encoding of encodings) {
    const options = { maxOutputLength: MAX_BODY_BYTES };
    if (encoding === "zstd") output = zstdDecompressSync(output, options);
    else if (encoding === "gzip") output = gunzipSync(output, options);
    else if (encoding === "deflate") output = inflateSync(output, options);
    else if (encoding === "br") output = brotliDecompressSync(output, options);
    else throw new Error(`Unsupported request content encoding: ${encoding}`);
  }
  return output;
}

function json(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function createResponseStreamState(
  model: string,
  source?: unknown,
): ResponseStreamState {
  const record = asRecord(source);
  const identity = record ? compileResponsesPrompt(record) : undefined;
  const id = identity?.turnId
    ? responsesOperationId(model, identity).slice(0, 32)
    : randomUUID().replaceAll("-", "");
  return {
    model,
    responseId: `resp_${id}`,
    messageId: `msg_${id}`,
    createdAt: Math.floor(Date.now() / 1000),
    textFormat: identity?.textFormat ?? { type: "text" },
    sequenceNumber: 0,
  };
}

function responseSnapshot(
  model: string,
  text: string,
  state = createResponseStreamState(model),
): JsonRecord {
  return {
    id: state.responseId,
    object: "response",
    created_at: state.createdAt,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: [
      {
        id: state.messageId,
        type: "message",
        status: "completed",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", annotations: [], text }],
      },
    ],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: state.textFormat },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: {
      input_tokens: state.inputTokens ?? 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: estimateBridgeTextTokens(text),
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: (state.inputTokens ?? 0) + estimateBridgeTextTokens(text),
    },
  };
}

function toolCallItems(
  calls: readonly BridgeToolCall[],
  state: ResponseStreamState,
): JsonRecord[] {
  return calls.map((call, index) => {
    const callId =
      call.callId ??
      "call_" +
        createHash("sha256")
          .update(state.responseId + ":" + index + ":" + canonicalJson(call))
          .digest("hex")
          .slice(0, 32);
    if (call.kind === "custom") {
      return {
        type: "custom_tool_call",
        id: `ctc_${callId.slice(5)}`,
        call_id: callId,
        name: call.name,
        ...(call.namespace === undefined ? {} : { namespace: call.namespace }),
        input: call.input ?? "",
        status: "completed",
      };
    }
    if (call.kind === "tool_search") {
      return {
        type: "tool_search_call",
        id: `tsc_${callId.slice(5)}`,
        call_id: callId,
        execution: "client",
        arguments: call.arguments,
        status: "completed",
      };
    }
    return {
      type: "function_call",
      id: `fc_${callId.slice(5)}`,
      call_id: callId,
      name: call.name,
      arguments: JSON.stringify(call.arguments),
      status: "completed",
      ...(call.namespace === undefined ? {} : { namespace: call.namespace }),
      ...(call.namespace === "collaboration" &&
      ["spawn_agent", "send_message", "followup_task"].includes(call.name)
        ? { encrypted_function_args: [] }
        : {}),
    };
  });
}

function toolResponseSnapshot(
  state: ResponseStreamState,
  items: readonly JsonRecord[],
): JsonRecord {
  return {
    ...responseSnapshot(state.model, "", state),
    output: items,
    end_turn: false,
  };
}

function generatedImageItems(
  result: BridgeGeneratedImagesResult,
): JsonRecord[] {
  return result.images.map((image) => ({
    id: `ig_${randomUUID().replaceAll("-", "")}`,
    type: "image_generation_call",
    status: "completed",
    result: image.base64,
  }));
}

function generatedImagesText(result: BridgeGeneratedImagesResult): string {
  // Codex retains native image items in history, but some desktop versions do not
  // render them as task items. Give the assistant message the saved local images too.
  const images = result.images.map((image, index) => {
    const path = image.localPath
      .replaceAll("\\", "/")
      .replace(/[<>\r\n]/g, (character) => encodeURIComponent(character));
    return `![Generated image ${index + 1}](<${path}>)`;
  });
  return [result.text, ...images].filter((part) => part.trim()).join("\n\n");
}

function generatedImagesResponseSnapshot(
  state: ResponseStreamState,
  result: BridgeGeneratedImagesResult,
  imageItems = generatedImageItems(result),
): JsonRecord {
  const text = generatedImagesText(result);
  const base = responseSnapshot(state.model, text, state);
  const output =
    text.trim().length > 0 ? [...(base.output as JsonRecord[])] : [];
  output.push(...imageItems);
  return { ...base, output };
}

function bridgeResponseSnapshot(
  state: ResponseStreamState,
  result: BridgeWebTurnResult,
): JsonRecord {
  if (result.kind === "compaction")
    return {
      ...responseSnapshot(state.model, "", state),
      output: [
        {
          type: "compaction",
          id: `cmp_${state.responseId.slice(5)}`,
          encrypted_content:
            "cgb1:" + Buffer.from(result.summary, "utf8").toString("base64"),
        },
      ],
    };
  if (result.kind === "text") {
    return responseSnapshot(state.model, result.text, state);
  }
  if (result.kind === "tool_calls") {
    return toolResponseSnapshot(state, toolCallItems(result.calls, state));
  }
  return generatedImagesResponseSnapshot(state, result);
}

function writeEvent(
  response: ServerResponse,
  type: string,
  payload: unknown,
): void {
  response.write(`event: ${type}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function emitResponseEvent(
  write: ResponseEventWriter,
  state: ResponseStreamState,
  type: string,
  payload: JsonRecord,
): void {
  write(type, {
    ...payload,
    type,
    sequence_number: state.sequenceNumber++,
  });
}

function beginResponseStream(
  write: ResponseEventWriter,
  state: ResponseStreamState,
): void {
  const snapshot = responseSnapshot(state.model, "", state);
  const inProgress = { ...snapshot, status: "in_progress", output: [] };
  emitResponseEvent(write, state, "response.created", {
    response: inProgress,
  });
  emitResponseEvent(write, state, "response.in_progress", {
    response: inProgress,
  });
}

function withProgressOutput(
  snapshot: JsonRecord,
  state: ResponseStreamState,
): JsonRecord {
  return {
    ...snapshot,
    output: [
      ...(state.progressItems ?? []),
      ...(snapshot.output as JsonRecord[]),
    ],
  };
}

/** Existing result events use result-local indices; progress occupies a prefix. */
function progressEventWriter(
  write: ResponseEventWriter,
  state: ResponseStreamState,
): ResponseEventWriter {
  return (type, payload) => {
    const response = asRecord(payload.response);
    write(type, {
      ...payload,
      ...(typeof payload.output_index === "number"
        ? {
            output_index:
              payload.output_index + (state.progressItems?.length ?? 0),
          }
        : {}),
      ...(response && Array.isArray(response.output)
        ? { response: withProgressOutput(response, state) }
        : {}),
    });
  };
}

function appendBridgeProgress(
  write: ResponseEventWriter,
  state: ResponseStreamState,
  stage: BridgeProgressStage,
): void {
  // Never change the output prefix once delivery of the settled answer begins.
  const text = bridgeProgressText(stage);
  if (state.textStarted || !text) return;
  const seen = (state.progressStages ??= new Set());
  if (seen.has(stage)) return;
  seen.add(stage);
  const itemId = `${state.messageId}_bridge_${stage}`;
  appendCommentaryItem(write, state, itemId, text);
}

function appendCommentaryItem(
  write: ResponseEventWriter,
  state: ResponseStreamState,
  itemId: string,
  text: string,
): void {
  if (state.textStarted) return;
  const items = (state.progressItems ??= []);
  if (items.some((item) => item.id === itemId)) return;
  const index = items.length;
  const part = { type: "output_text", annotations: [], text };
  const item = {
    id: itemId,
    type: "message",
    role: "assistant",
    phase: "commentary",
    status: "completed",
    content: [part],
  };
  const address = { item_id: itemId, output_index: index, content_index: 0 };
  emitResponseEvent(write, state, "response.output_item.added", {
    output_index: index,
    item: { ...item, status: "in_progress", content: [] },
  });
  emitResponseEvent(write, state, "response.content_part.added", {
    ...address,
    part: { ...part, text: "" },
  });
  emitResponseEvent(write, state, "response.output_text.delta", {
    ...address,
    delta: text,
  });
  emitResponseEvent(write, state, "response.output_text.done", {
    ...address,
    text,
  });
  emitResponseEvent(write, state, "response.content_part.done", {
    ...address,
    part,
  });
  emitResponseEvent(write, state, "response.output_item.done", {
    output_index: index,
    item,
  });
  items.push(item);
}

function appendTextDelta(
  write: ResponseEventWriter,
  state: ResponseStreamState,
  delta: string,
): void {
  if (!state.textStarted) {
    state.textStarted = true;
    emitResponseEvent(write, state, "response.output_item.added", {
      output_index: 0,
      item: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        phase: "final_answer",
        status: "in_progress",
        content: [],
      },
    });
    emitResponseEvent(write, state, "response.content_part.added", {
      item_id: state.messageId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", annotations: [], text: "" },
    });
  }
  if (delta)
    emitResponseEvent(write, state, "response.output_text.delta", {
      item_id: state.messageId,
      output_index: 0,
      content_index: 0,
      delta,
    });
  state.streamedText = (state.streamedText ?? "") + delta;
}

function completeResponseStream(
  write: ResponseEventWriter,
  state: ResponseStreamState,
  text: string,
): void {
  const snapshot = responseSnapshot(state.model, text, state);
  const output = snapshot.output as JsonRecord[];
  const message = output[0] as JsonRecord;
  const content = message.content as JsonRecord[];
  const part = content[0] as JsonRecord;
  const streamedText = state.streamedText ?? "";
  if (!text.startsWith(streamedText))
    throw new BridgeStreamError("Final response disagrees with streamed text.");
  appendTextDelta(write, state, text.slice(streamedText.length));
  emitResponseEvent(write, state, "response.output_text.done", {
    item_id: state.messageId,
    output_index: 0,
    content_index: 0,
    text,
  });
  emitResponseEvent(write, state, "response.content_part.done", {
    item_id: state.messageId,
    output_index: 0,
    content_index: 0,
    part,
  });
  emitResponseEvent(write, state, "response.output_item.done", {
    output_index: 0,
    item: message,
  });
  emitResponseEvent(write, state, "response.completed", {
    response: snapshot,
  });
}

function completeToolResponseStream(
  write: ResponseEventWriter,
  state: ResponseStreamState,
  calls: readonly BridgeToolCall[],
): void {
  const items = toolCallItems(calls, state);
  items.forEach((item, outputIndex) => {
    const itemId = String(item.id);
    const type = String(item.type);
    const inProgress: JsonRecord = { ...item, status: "in_progress" };
    if (type === "function_call") inProgress.arguments = "";
    if (type === "custom_tool_call") inProgress.input = "";
    if (type === "tool_search_call") inProgress.arguments = {};
    emitResponseEvent(write, state, "response.output_item.added", {
      output_index: outputIndex,
      item: inProgress,
    });
    if (type === "function_call") {
      const argumentsText = String(item.arguments ?? "{}");
      emitResponseEvent(
        write,
        state,
        "response.function_call_arguments.delta",
        {
          item_id: itemId,
          output_index: outputIndex,
          delta: argumentsText,
        },
      );
      emitResponseEvent(write, state, "response.function_call_arguments.done", {
        item_id: itemId,
        output_index: outputIndex,
        arguments: argumentsText,
      });
    } else if (type === "custom_tool_call") {
      const input = String(item.input ?? "");
      emitResponseEvent(write, state, "response.custom_tool_call_input.delta", {
        item_id: itemId,
        output_index: outputIndex,
        delta: input,
      });
      emitResponseEvent(write, state, "response.custom_tool_call_input.done", {
        item_id: itemId,
        output_index: outputIndex,
        input,
      });
    }
    emitResponseEvent(write, state, "response.output_item.done", {
      output_index: outputIndex,
      item,
    });
  });
  emitResponseEvent(write, state, "response.completed", {
    response: toolResponseSnapshot(state, items),
  });
}

function emitTextOutput(
  write: ResponseEventWriter,
  state: ResponseStreamState,
  text: string,
  outputIndex: number,
): JsonRecord {
  const message: JsonRecord = {
    id: state.messageId,
    type: "message",
    status: "completed",
    role: "assistant",
    phase: "final_answer",
    content: [{ type: "output_text", annotations: [], text }],
  };
  const part = (message.content as JsonRecord[])[0] as JsonRecord;
  if (outputIndex !== 0)
    throw new Error("Text output must precede generated images.");
  const streamedText = state.streamedText ?? "";
  if (!text.startsWith(streamedText))
    throw new Error("Final media text disagrees with streamed text.");
  appendTextDelta(write, state, text.slice(streamedText.length));
  emitResponseEvent(write, state, "response.output_text.done", {
    item_id: state.messageId,
    output_index: outputIndex,
    content_index: 0,
    text,
  });
  emitResponseEvent(write, state, "response.content_part.done", {
    item_id: state.messageId,
    output_index: outputIndex,
    content_index: 0,
    part,
  });
  emitResponseEvent(write, state, "response.output_item.done", {
    output_index: outputIndex,
    item: message,
  });
  return message;
}

function completeGeneratedImagesResponseStream(
  write: ResponseEventWriter,
  state: ResponseStreamState,
  result: BridgeGeneratedImagesResult,
): void {
  const output: JsonRecord[] = [];
  const text = generatedImagesText(result);
  if (text.trim().length > 0) {
    output.push(emitTextOutput(write, state, text, output.length));
  }
  for (const image of result.images) {
    const outputIndex = output.length;
    const item: JsonRecord = {
      id: `ig_${randomUUID().replaceAll("-", "")}`,
      type: "image_generation_call",
      status: "completed",
      result: image.base64,
    };
    emitResponseEvent(write, state, "response.output_item.added", {
      output_index: outputIndex,
      item: { ...item, status: "in_progress", result: null },
    });
    emitResponseEvent(
      write,
      state,
      "response.image_generation_call.in_progress",
      {
        item_id: item.id,
        output_index: outputIndex,
      },
    );
    emitResponseEvent(
      write,
      state,
      "response.image_generation_call.generating",
      {
        item_id: item.id,
        output_index: outputIndex,
      },
    );
    emitResponseEvent(
      write,
      state,
      "response.image_generation_call.completed",
      {
        item_id: item.id,
        output_index: outputIndex,
      },
    );
    emitResponseEvent(write, state, "response.output_item.done", {
      output_index: outputIndex,
      item,
    });
    output.push(item);
  }
  const snapshot = responseSnapshot(state.model, text, state);
  emitResponseEvent(write, state, "response.completed", {
    response: { ...snapshot, output },
  });
}

function completeBridgeResponseStream(
  write: ResponseEventWriter,
  state: ResponseStreamState,
  result: BridgeWebTurnResult,
): void {
  if (result.kind === "compaction") {
    const snapshot = bridgeResponseSnapshot(state, result);
    const item = (snapshot.output as JsonRecord[])[0]!;
    emitResponseEvent(write, state, "response.output_item.added", {
      output_index: 0,
      item,
    });
    emitResponseEvent(write, state, "response.output_item.done", {
      output_index: 0,
      item,
    });
    emitResponseEvent(write, state, "response.completed", {
      response: snapshot,
    });
  } else if (result.kind === "text") {
    completeResponseStream(write, state, result.text);
  } else if (result.kind === "tool_calls") {
    completeToolResponseStream(write, state, result.calls);
  } else {
    completeGeneratedImagesResponseStream(write, state, result);
  }
}

class BridgeStructuredOutputError extends Error {
  readonly code = "bridge_structured_output_invalid";

  constructor(problem: string) {
    super(`ChatGPT structured output failed validation: ${problem}`);
    this.name = "BridgeStructuredOutputError";
  }
}

class BridgeContextLimitError extends Error {
  readonly code = "bridge_context_limit_exceeded";

  constructor(
    readonly route: BridgeWebModelRoute,
    readonly inputTokens: number,
    readonly budget: BridgeContextBudget,
    readonly attempt: "initial" | "follow-up" = "initial",
    readonly problem?: string,
  ) {
    super(
      `${route.slug} (${route.mode}) ${problem ?? `input requires ${inputTokens.toLocaleString("en-US")} tokens, exceeding its ${budget.hardInputTokenLimit.toLocaleString("en-US")} token Bridge transport limit`} (${budget.profile ?? BRIDGE_CONTEXT_BUDGET_PROFILE}). Compact the task and retry. ${attempt === "initial" ? "No prompt was submitted." : "No additional prompt was submitted; the earlier browser response was not retried."}`,
    );
    this.name = "BridgeContextLimitError";
  }
}

function compiledInputTokenBreakdown(
  compiled: CompiledResponsesPrompt,
  prepared = prepareBridgeWebTurn(compiled),
) {
  return estimateBridgeInputTokenBreakdown({
    instructions: compiled.context.instructions,
    history: compiled.context.history,
    ...(compiled.conversationHistory === undefined
      ? {}
      : { conversationHistory: compiled.conversationHistory }),
    ...(prepared.contract === undefined ? {} : { contract: prepared.contract }),
    prompt: prepared.prompt,
    images: [...compiled.context.images, ...compiled.images],
  });
}

function estimateCompiledInputTokens(
  compiled: CompiledResponsesPrompt,
  prepared = prepareBridgeWebTurn(compiled),
): number {
  return compiledInputTokenBreakdown(compiled, prepared).total;
}

function bridgeExecutionPreflight(
  route: BridgeWebModelRoute,
  toolTransport: BridgeToolTransport,
  operationToolTransport: BridgeToolTransport,
  attempt: "initial" | "follow-up",
  toolCount: number,
  tokenBreakdown: ReturnType<typeof compiledInputTokenBreakdown>,
  compaction: boolean,
  budget: BridgeContextBudget = BRIDGE_CONTEXT_BUDGETS[route.mode],
): BridgeExecutionPreflight {
  return {
    version: 1,
    route: route.slug,
    mode: route.mode,
    operationToolTransport,
    toolTransport,
    attempt,
    toolCount,
    sourceContextTokens: tokenBreakdown.total,
    inputBasis: "full-context",
    inputTokens: tokenBreakdown.total,
    textTokens: tokenBreakdown.text,
    textCharacters: tokenBreakdown.textCharacters,
    imageCount: tokenBreakdown.imageCount,
    imageReserveTokens: tokenBreakdown.imageReserve,
    platformReserveTokens: tokenBreakdown.platformReserve,
    contextWindow: budget.contextWindow,
    autoCompactTokenLimit: budget.autoCompactTokenLimit,
    hardInputTokenLimit: budget.hardInputTokenLimit,
    ...(budget.browserMessageTokenLimit === undefined
      ? {}
      : { browserMessageTokenLimit: budget.browserMessageTokenLimit }),
    ...(budget.browserComposerCharLimit === undefined
      ? {}
      : { browserComposerCharLimit: budget.browserComposerCharLimit }),
    remainingInputTokens: Math.max(
      0,
      budget.hardInputTokenLimit - tokenBreakdown.total,
    ),
    status: compaction
      ? "compaction-bypass"
      : tokenBreakdown.total > budget.autoCompactTokenLimit
        ? "compaction-recommended"
        : "within-limit",
    budgetProfile: budget.profile ?? BRIDGE_CONTEXT_BUDGET_PROFILE,
    ...(route.contextMultiplier
      ? { contextMultiplier: route.contextMultiplier }
      : {}),
    ...(budget.stagedContext ? { stagedContext: true } : {}),
  };
}

/** Context size and the product's single-message limits are independent gates. */
export function bridgeExecutionLimitProblem(
  execution: BridgeExecutionPreflight,
): string | undefined {
  if (
    execution.status !== "compaction-bypass" &&
    execution.inputTokens > execution.hardInputTokenLimit
  )
    return `input requires ${execution.inputTokens.toLocaleString("en-US")} tokens, exceeding its ${execution.hardInputTokenLimit.toLocaleString("en-US")} token transport limit`;
  const messageTokens = execution.textTokens + execution.imageReserveTokens;
  if (
    execution.browserMessageTokenLimit !== undefined &&
    messageTokens > execution.browserMessageTokenLimit
  )
    return `one browser message requires ${messageTokens.toLocaleString("en-US")} visible tokens, exceeding its ${execution.browserMessageTokenLimit.toLocaleString("en-US")} token message limit`;
  if (
    execution.browserComposerCharLimit !== undefined &&
    execution.textCharacters > execution.browserComposerCharLimit
  )
    return `one browser message requires ${execution.textCharacters.toLocaleString("en-US")} characters, exceeding its ${execution.browserComposerCharLimit.toLocaleString("en-US")} character message limit`;
  return undefined;
}

/**
 * Replace a conservative full-context estimate with the exact payload that a
 * retained browser conversation will receive. The original context total stays
 * attached to the receipt so long-task growth remains observable.
 */
export function synchronizeBridgeExecutionPreflight(
  execution: BridgeExecutionPreflight,
  input: {
    readonly prompt: string;
    readonly images: readonly CompiledResponsesImage[];
  },
): BridgeExecutionPreflight {
  const tokenBreakdown = estimateBridgeInputTokenBreakdown({
    instructions: "",
    history: [],
    prompt: input.prompt,
    images: input.images,
  });
  return {
    ...execution,
    inputBasis: "synchronized-payload",
    inputTokens: tokenBreakdown.total,
    textTokens: tokenBreakdown.text,
    textCharacters: tokenBreakdown.textCharacters,
    imageCount: tokenBreakdown.imageCount,
    imageReserveTokens: tokenBreakdown.imageReserve,
    platformReserveTokens: tokenBreakdown.platformReserve,
    remainingInputTokens: Math.max(
      0,
      execution.hardInputTokenLimit - tokenBreakdown.total,
    ),
    status:
      execution.status === "compaction-bypass"
        ? "compaction-bypass"
        : tokenBreakdown.total > execution.autoCompactTokenLimit
          ? "compaction-recommended"
          : "within-limit",
  };
}

function browserInputTokenBreakdown(input: RunWebTurnInput) {
  return estimateBridgeInputTokenBreakdown({
    instructions: input.context?.instructions ?? "",
    history: input.context?.history ?? [],
    ...(input.conversationHistory === undefined
      ? {}
      : { conversationHistory: input.conversationHistory }),
    ...(input.contract === undefined ? {} : { contract: input.contract }),
    prompt: input.prompt,
    images: [...(input.context?.images ?? []), ...input.images],
  });
}

function structuredOutputProblem(
  format: BridgeTextFormat,
  text: string,
): string | undefined {
  if (format.type === "text") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return "the final response is not valid JSON";
  }
  if (format.type === "json_object") {
    return asRecord(parsed) === undefined
      ? "the final response is not a JSON object"
      : undefined;
  }
  const validate = responseFormatValidator(format.schema);
  if (validate(parsed)) return undefined;
  const error = validate.errors?.[0];
  return `schema ${format.name} rejected ${error?.instancePath || "/"} (${error?.keyword ?? "invalid"})`;
}

function validateStructuredResult(
  format: BridgeTextFormat,
  result: BridgeWebTurnResult,
): void {
  if (format.type === "text" || result.kind === "tool_calls") return;
  if (result.kind !== "text")
    throw new BridgeStructuredOutputError(
      "the final response was not textual JSON",
    );
  const problem = structuredOutputProblem(format, result.text);
  if (problem !== undefined) throw new BridgeStructuredOutputError(problem);
}

function compactionCheckpoint(value: string): {
  readonly summary?: string;
  readonly problem?: string;
} {
  let summary = value.trim();
  const fenced = /^```(?:text|markdown)?\s*\r?\n([\s\S]*?)\r?\n```$/iu.exec(
    summary,
  );
  if (fenced?.[1] !== undefined) summary = fenced[1].trim();
  summary = summary
    .replace(/^<codex_text>\s*/iu, "")
    .replace(/\s*<\/codex_text>$/iu, "")
    .trim();
  if (!summary) return { problem: "the response was empty" };
  if (summary.length > 200_000)
    return {
      problem: `the response was too large (${summary.length.toLocaleString("en-US")} characters)`,
    };
  if (/<codex_tool_calls?>/iu.test(summary))
    return { problem: "the response contained a tool-call protocol tag" };
  return { summary };
}

async function runBridgeWebTurn(
  options: ResponsesGatewayOptions,
  fullCoordinator: FullTurnCoordinator | undefined,
  lifecycle: ProviderLifecycleController,
  compiled: CompiledResponsesPrompt,
  route: BridgeWebModelRoute,
  signal: AbortSignal,
  onDelta?: (delta: string) => void,
  onProgress?: (stage: BridgeProgressStage) => void,
  onInputTokens?: (tokens: number) => void,
  onCommentary?: (commentary: BridgePublicCommentary) => void,
): Promise<BridgeWebTurnResult> {
  const canonicalSource = compiled;
  const rollingLuna = route.slug === "codexgpt-bridge/luna-native";
  const fullEnabled =
    !!fullCoordinator && (await options.fullMcp?.enabled()) === true;
  if (rollingLuna) {
    if (!fullEnabled) throw new FullMcpUnavailableError();
    if (compiled.compaction)
      throw new Error(
        "Luna captures a private checkpoint after each Full turn; separate compaction is unavailable. Canonical history was retained.",
      );
    compiled = await options.lunaCheckpoints!.prepare(compiled);
  }
  const prepared = prepareBridgeWebTurn(compiled);
  const connectorName =
    fullEnabled && !compiled.compaction
      ? await options.fullMcp!.connectorName()
      : undefined;
  // Full delivers schemas through its MCP inventory, not the Simple text catalog.
  // Use the same native contract for accounting and the initial context gate.
  // The coordinator replaces this placeholder with its real capability below.
  const usagePrepared =
    connectorName === undefined
      ? prepared
      : {
          ...prepared,
          contract: fullContract(
            prepared,
            connectorName,
            `turn_${"0".repeat(43)}`,
          ),
        };
  onInputTokens?.(estimateCompiledInputTokens(compiled, usagePrepared));
  const budget = resolveBridgeRouteContextBudget(
    route,
    await options.accountContextProfile?.(),
  );
  const canonicalTokens = rollingLuna
    ? compiledInputTokenBreakdown(
        canonicalSource,
        prepareBridgeWebTurn(canonicalSource),
      ).total
    : undefined;
  if (
    canonicalTokens !== undefined &&
    canonicalTokens > budget.hardInputTokenLimit
  )
    throw new BridgeContextLimitError(route, canonicalTokens, budget);
  let browserSubmissions = 0;
  const runBrowser = (
    input: RunWebTurnInput,
    toolTransport: BridgeToolTransport = input.allowWebNativeTools
      ? "full"
      : "none",
    toolCount = toolTransport === "none" ? 0 : prepared.tools.length,
    attempt?: "initial" | "follow-up",
    operationToolTransport: BridgeToolTransport = toolTransport,
    compactionBypass = compiled.compaction === true,
  ): Promise<string | BridgeGeneratedImagesResult> => {
    const resolvedAttempt =
      attempt ??
      (compiled.toolResults.length > 0 || browserSubmissions > 0
        ? "follow-up"
        : "initial");
    const preflight = bridgeExecutionPreflight(
      route,
      toolTransport,
      operationToolTransport,
      resolvedAttempt,
      toolCount,
      browserInputTokenBreakdown(input),
      compactionBypass,
      budget,
    );
    const execution: BridgeExecutionPreflight =
      canonicalTokens === undefined
        ? preflight
        : {
            ...preflight,
            sourceContextTokens: canonicalTokens,
            ...(compiled !== canonicalSource
              ? { inputBasis: "synchronized-payload" as const }
              : {}),
          };
    const problem = bridgeExecutionLimitProblem(execution);
    if (!options.receiptAwareContextSync && problem !== undefined) {
      return Promise.reject(
        new BridgeContextLimitError(
          route,
          execution.inputTokens,
          budget,
          resolvedAttempt,
          problem,
        ),
      );
    }
    const lease = lifecycle.acquireBrowserTurn();
    browserSubmissions += 1;
    return Promise.resolve()
      .then(() => options.runWebTurn({ ...input, execution }))
      .finally(() => lease.release());
  };
  const tokenBreakdown = compiledInputTokenBreakdown(compiled, usagePrepared);
  if (
    !options.receiptAwareContextSync &&
    !compiled.compaction &&
    tokenBreakdown.total > budget.hardInputTokenLimit
  ) {
    throw new BridgeContextLimitError(route, tokenBreakdown.total, budget);
  }
  const operationId = responsesOperationId(route.slug, compiled);
  const modelFamily = route.nativeFamily
    ? `bridge-native:${route.nativeFamily}`
    : await options.modelFamily?.();
  const reportProgress = (stage: BridgeProgressStage): void => {
    if (!signal.aborted && !compiled.compaction) onProgress?.(stage);
  };
  if (compiled.compaction && fullCoordinator && fullEnabled) {
    try {
      const checkpoint = await fullCoordinator.compact(
        compiled,
        route.slug,
        signal,
        {
          operationId,
          acquireToolLease: () => lifecycle.acquireToolTurn(),
          runBrowser: (input) =>
            runBrowser(input, "full", 1, "follow-up", "full", false),
        },
      );
      if (checkpoint) return checkpoint;
    } catch (error) {
      // Only an unavailable source detected before Send permits rebuilding a
      // read-only checkpoint from canonical history. Ordinary Full never falls back.
      if (!(error instanceof RetainedFullSourceUnavailableError)) throw error;
    }
  }
  const checkpointMessageTarget =
    budget.browserMessageTokenLimit === undefined
      ? Infinity
      : budget.browserMessageTokenLimit + tokenBreakdown.platformReserve;
  if (
    compiled.compaction &&
    options.receiptAwareContextSync &&
    (tokenBreakdown.total >
      Math.min(budget.hardInputTokenLimit, checkpointMessageTarget) ||
      (budget.browserComposerCharLimit !== undefined &&
        tokenBreakdown.textCharacters > budget.browserComposerCharLimit))
  ) {
    const stages = planBridgeCompactionStages(
      compiled.context,
      prepared.contract ?? "",
      Math.min(budget.autoCompactTokenLimit, checkpointMessageTarget),
      budget.browserComposerCharLimit,
    );
    let summary = "";
    for (const stage of stages) {
      const stageInput: RunWebTurnInput = {
        ...(compiled.cwd ? { cwd: compiled.cwd } : {}),
        operationId,
        ...(modelFamily ? { modelFamily } : {}),
        prompt: stage.prompt,
        context: stage.context,
        contract: prepared.contract ?? "",
        images: [],
        signal,
        mode: route.mode,
        ...(compiled.turnId === undefined ? {} : { turnId: compiled.turnId }),
        ...(compiled.threadId === undefined
          ? {}
          : { threadId: compiled.threadId }),
      };
      const output = await runBrowser(
        stageInput,
        "none",
        0,
        stage.index === 1 ? "initial" : "follow-up",
        "none",
        false,
      );
      if (typeof output !== "string") {
        throw new Error(
          `Rolling compaction stage ${stage.index} returned native media; the original conversation was retained.`,
        );
      }
      let checkpoint = compactionCheckpoint(output);
      if (checkpoint.summary === undefined) {
        const repaired = await runBrowser(
          {
            ...stageInput,
            prompt: bridgeCompactionRepairPrompt(
              checkpoint.problem ?? "the staged checkpoint was invalid",
            ),
          },
          "none",
          0,
          "follow-up",
          "none",
          false,
        );
        if (typeof repaired !== "string") {
          throw new Error(
            `Rolling compaction stage ${stage.index} correction returned native media; the original conversation was retained.`,
          );
        }
        checkpoint = compactionCheckpoint(repaired);
      }
      if (checkpoint.summary === undefined) {
        throw new Error(
          `Rolling compaction stage ${stage.index} did not produce a valid checkpoint after one correction (${checkpoint.problem ?? "unknown reason"}); the original conversation was retained.`,
        );
      }
      summary = checkpoint.summary;
    }
    return { kind: "compaction", summary };
  }
  if (fullCoordinator && !compiled.compaction && fullEnabled) {
    const result = await fullCoordinator.run({
      ...(rollingLuna ? { forceNewConversation: true } : {}),
      compiled,
      connectorName: connectorName!,
      model: route.slug,
      mode: route.mode,
      ...(modelFamily ? { modelFamily } : {}),
      operationId,
      requestSignal: signal,
      acquireToolLease: () => lifecycle.acquireToolTurn(),
      ...(onDelta ? { onDelta } : {}),
      onProgress: reportProgress,
      ...(onCommentary ? { onCommentary } : {}),
      onUsageContract: (contract) =>
        onInputTokens?.(
          estimateCompiledInputTokens(compiled, { ...prepared, contract }),
        ),
      runBrowser,
    });
    const finishLuna = async (result: BridgeWebTurnResult): Promise<void> => {
      if (
        rollingLuna &&
        (result.kind === "text" || result.kind === "generated_images")
      ) {
        try {
          const checkpointId = `luna-checkpoint-${operationId}`;
          const checkpoint = await fullCoordinator.compact(
            {
              ...compiled,
              compaction: true,
              toolResults: [],
              compactionToolResults: [],
            },
            route.slug,
            signal,
            {
              operationId: checkpointId,
              acquireToolLease: () => lifecycle.acquireToolTurn(),
              runBrowser: (input) =>
                runBrowser({
                  ...input,
                  turnId: checkpointId,
                  contract: `${input.contract}\nKeep this private Luna checkpoint within 4,000 tokens and 24,000 characters. Record compact task state and evidence; do not include hidden reasoning or credentials.`,
                }),
            },
          );
          if (checkpoint?.kind !== "compaction")
            throw new Error(
              "The exact completed Luna source did not produce its private checkpoint. Canonical history was retained.",
            );
          await options.lunaCheckpoints!.commit(
            canonicalSource,
            checkpoint.summary,
            result.text,
          );
        } catch (error) {
          throw new LunaCheckpointError(
            error instanceof Error
              ? error.message
              : "Luna checkpoint failed; canonical history was retained.",
          );
        }
      }
    };
    try {
      validateStructuredResult(compiled.textFormat, result);
      await finishLuna(result);
      return result;
    } catch (error) {
      if (
        error instanceof LunaCheckpointError ||
        compiled.textFormat.type === "text" ||
        result.kind === "tool_calls"
      )
        throw error;
      reportProgress("repairing");
      const repairedOutput = await runBrowser(
        {
          ...(compiled.cwd ? { cwd: compiled.cwd } : {}),
          operationId,
          ...(modelFamily ? { modelFamily } : {}),
          prompt: bridgeStructuredOutputRepairPrompt(
            prepared,
            error instanceof Error
              ? error.message
              : "invalid structured output",
          ),
          context: compiled.context,
          contract: `${prepared.outputContract ?? ""}\nThis is a formatting-only correction. Return the required JSON; do not call tools or repeat any action.`,
          onProgress: reportProgress,
          images: [],
          signal,
          mode: route.mode,
          ...(compiled.turnId === undefined ? {} : { turnId: compiled.turnId }),
          ...(compiled.threadId === undefined
            ? {}
            : { threadId: compiled.threadId }),
          ...(compiled.conversationHistory === undefined
            ? {}
            : { conversationHistory: compiled.conversationHistory }),
        },
        "none",
        0,
        "follow-up",
        "full",
      );
      if (typeof repairedOutput !== "string")
        throw new BridgeStructuredOutputError(
          "the corrected Full MCP response contained native media instead of JSON",
        );
      let repaired: BridgeWebTurnResult;
      try {
        repaired = parseBridgeWebTurnResult(repairedOutput, prepared);
      } catch (repairError) {
        throw new BridgeStructuredOutputError(
          repairError instanceof Error
            ? repairError.message
            : "invalid corrected Full MCP response",
        );
      }
      if (repaired.kind !== "text") {
        throw new BridgeStructuredOutputError(
          "a formatting-only Full MCP correction must not return tool calls or media",
        );
      }
      validateStructuredResult(compiled.textFormat, repaired);
      await finishLuna(repaired);
      return repaired;
    }
  }
  let textEmitted = false;
  const textStream = new BridgeTextStream((delta) => {
    textEmitted = true;
    onDelta?.(delta);
  });
  const runWebTurn = (
    prompt: string,
    images: readonly CompiledResponsesImage[],
    streamText: boolean,
  ) =>
    runBrowser(
      {
        ...(compiled.cwd ? { cwd: compiled.cwd } : {}),
        operationId,
        ...(modelFamily ? { modelFamily } : {}),
        prompt,
        context: compiled.context,
        contract: prepared.contract ?? "",
        onProgress: reportProgress,
        ...(streamText
          ? {
              onSnapshot: (text: string) => textStream.update(text),
              onStreamSnapshot: (text: string) =>
                textStream.updateNetwork(text),
            }
          : {}),
        images,
        signal,
        mode: route.mode,
        ...(compiled.turnId === undefined ? {} : { turnId: compiled.turnId }),
        ...(compiled.threadId === undefined
          ? {}
          : { threadId: compiled.threadId }),
        ...(compiled.conversationHistory === undefined
          ? {}
          : { conversationHistory: compiled.conversationHistory }),
      },
      prepared.tools.length > 0 ? "simple" : "none",
      prepared.tools.length,
    );
  let firstOutput: string | BridgeGeneratedImagesResult;
  try {
    firstOutput = await runWebTurn(
      prepared.prompt,
      compiled.images,
      !prepared.expectsToolCall &&
        !compiled.compaction &&
        compiled.textFormat.type === "text",
    );
  } catch (error) {
    if (
      !(error instanceof UnsupportedWebNativeToolError) ||
      textEmitted ||
      compiled.compaction ||
      prepared.tools.length === 0
    )
      throw error;
    reportProgress("repairing");
    const repairedOutput = await runWebTurn(
      bridgeToolRepairPrompt(
        prepared,
        "the previous response used an unsupported ChatGPT Web tool",
      ),
      [],
      false,
    );
    if (typeof repairedOutput !== "string")
      throw new Error(
        "ChatGPT used native media after an unsupported web-native tool instead of returning a Codex client tool call.",
        { cause: error },
      );
    const repaired = parseBridgeWebTurnResult(repairedOutput, prepared);
    if (repaired.kind === "text")
      throw new Error(
        "ChatGPT did not return a Codex client tool call after an unsupported web-native tool was rejected.",
        { cause: error },
      );
    return repaired;
  }
  if (typeof firstOutput !== "string") {
    if (compiled.compaction || prepared.expectsToolCall)
      throw new Error(
        "Expected a Codex checkpoint or tool call, but received native media.",
      );
    if (compiled.textFormat.type !== "text")
      throw new BridgeStructuredOutputError(
        "the final response contained native media instead of JSON",
      );
    const parsed = parseBridgeWebTurnResult(firstOutput.text, prepared);
    if (parsed.kind !== "text")
      throw new Error("Native media cannot contain a client tool decision.");
    textStream.update(firstOutput.text, true);
    return { ...firstOutput, text: parsed.text };
  }
  if (compiled.compaction) {
    const checkpoint = compactionCheckpoint(firstOutput);
    if (checkpoint.summary !== undefined)
      return { kind: "compaction", summary: checkpoint.summary };

    const repairedOutput = await runWebTurn(
      bridgeCompactionRepairPrompt(
        checkpoint.problem ?? "the response was invalid",
      ),
      [],
      false,
    );
    if (typeof repairedOutput !== "string")
      throw new Error(
        "Invalid compaction checkpoint after one correction (native media); original conversation retained.",
      );
    const repairedCheckpoint = compactionCheckpoint(repairedOutput);
    if (repairedCheckpoint.summary === undefined)
      throw new Error(
        `Invalid compaction checkpoint after one correction (${repairedCheckpoint.problem ?? "unknown reason"}); original conversation retained.`,
      );
    return { kind: "compaction", summary: repairedCheckpoint.summary };
  }
  const firstText = firstOutput;

  const firstGeneratedImages = parseBridgeGeneratedImagesEnvelope(firstText);
  if (
    firstGeneratedImages !== undefined &&
    compiled.textFormat.type === "text"
  ) {
    return { kind: "text", text: firstGeneratedImages };
  }
  let firstResult: BridgeWebTurnResult;
  let repairReason: string | undefined;
  let repairStructuredOutput = false;
  try {
    firstResult =
      firstGeneratedImages === undefined
        ? parseBridgeWebTurnResult(firstText, prepared)
        : { kind: "text", text: firstGeneratedImages };
    if (!(prepared.expectsToolCall && firstResult.kind === "text")) {
      if (firstResult.kind !== "text" && textEmitted)
        throw new Error("Tool output followed streamed text.");
      if (firstResult.kind === "text") {
        const problem = structuredOutputProblem(
          compiled.textFormat,
          firstResult.text,
        );
        if (problem === undefined) {
          textStream.update(firstText, true);
          return firstResult;
        }
        repairStructuredOutput = true;
        repairReason = problem;
      } else {
        return firstResult;
      }
    } else {
      repairReason = "the requested local action needs a client tool call";
    }
  } catch (error) {
    const attemptedToolCall =
      prepared.tools.length > 0 && /<codex_tool_calls?>/iu.test(firstText);
    if (
      compiled.textFormat.type !== "text" &&
      !textEmitted &&
      !attemptedToolCall
    ) {
      repairStructuredOutput = true;
      repairReason =
        error instanceof Error ? error.message : "invalid structured output";
    } else {
      if (prepared.tools.length === 0 || textEmitted) throw error;
      repairReason =
        error instanceof Error ? error.message : "invalid tool-call output";
    }
  }

  reportProgress("repairing");
  const repairedOutput = await runBrowser(
    {
      ...(compiled.cwd ? { cwd: compiled.cwd } : {}),
      operationId,
      ...(modelFamily ? { modelFamily } : {}),
      prompt: repairStructuredOutput
        ? bridgeStructuredOutputRepairPrompt(prepared, repairReason)
        : bridgeToolRepairPrompt(prepared, repairReason),
      context: compiled.context,
      contract: prepared.contract ?? "",
      onProgress: reportProgress,
      images: [],
      signal,
      mode: route.mode,
      ...(compiled.turnId === undefined ? {} : { turnId: compiled.turnId }),
      ...(compiled.threadId === undefined
        ? {}
        : { threadId: compiled.threadId }),
      ...(compiled.conversationHistory === undefined
        ? {}
        : { conversationHistory: compiled.conversationHistory }),
    },
    prepared.tools.length > 0 ? "simple" : "none",
    prepared.tools.length,
    "follow-up",
  );
  if (typeof repairedOutput !== "string") {
    if (repairStructuredOutput)
      throw new BridgeStructuredOutputError(
        "the corrected response contained native media instead of JSON",
      );
    return repairedOutput;
  }
  const repairedText = repairedOutput;
  const repairedGeneratedImages =
    parseBridgeGeneratedImagesEnvelope(repairedText);
  if (repairedGeneratedImages !== undefined) {
    if (repairStructuredOutput)
      throw new BridgeStructuredOutputError(
        "the corrected response contained generated image Markdown instead of JSON",
      );
    return { kind: "text", text: repairedGeneratedImages };
  }
  let repaired: BridgeWebTurnResult;
  try {
    repaired = parseBridgeWebTurnResult(repairedText, prepared);
  } catch (error) {
    if (repairStructuredOutput)
      throw new BridgeStructuredOutputError(
        error instanceof Error ? error.message : "invalid corrected response",
      );
    throw error;
  }
  if (repairStructuredOutput) {
    if (repaired.kind !== "text")
      throw new BridgeStructuredOutputError(
        "the corrected response was not textual JSON",
      );
    const problem = structuredOutputProblem(compiled.textFormat, repaired.text);
    if (problem !== undefined) throw new BridgeStructuredOutputError(problem);
    textStream.update(repairedText, true);
    return repaired;
  }
  if (repaired.kind === "text") {
    throw new Error(
      "ChatGPT did not return the required Codex client tool call after one correction.",
    );
  }
  return repaired;
}

function providerFailure(error: unknown): {
  type: string;
  code: string;
  message: string;
  retry_after_seconds?: number;
} {
  if (
    error instanceof FullContextTransferError ||
    error instanceof LunaCheckpointError
  )
    return { type: "server_error", code: error.code, message: error.message };
  if (
    error instanceof FullMcpUnavailableError ||
    error instanceof BridgeReasoningEffortError
  ) {
    return {
      type: "invalid_request_error",
      code: error.code,
      message: error.message,
    };
  }
  const limited =
    error instanceof Error &&
    "code" in error &&
    error.code === "chatgpt_web_rate_limited" &&
    "retryAfterSeconds" in error &&
    typeof error.retryAfterSeconds === "number" &&
    Number.isFinite(error.retryAfterSeconds) &&
    error.retryAfterSeconds > 0;
  const preparation =
    error instanceof Error &&
    "code" in error &&
    error.code === "chatgpt_web_preparation_failed";
  const sessionExpired =
    error instanceof Error &&
    "code" in error &&
    error.code === "chatgpt_web_session_expired";
  const modelSelectionFailure =
    preparation &&
    "diagnosticCode" in error &&
    typeof error.diagnosticCode === "string" &&
    error.diagnosticCode.startsWith("model-");
  const sessionUnavailable =
    error instanceof Error &&
    "code" in error &&
    error.code === "chatgpt_web_session_unavailable";
  const verificationRequired =
    error instanceof Error &&
    "code" in error &&
    error.code === "chatgpt_web_verification_required";
  const recovery =
    error instanceof Error &&
    "code" in error &&
    error.code === "bridge_operation_recovery_required";
  const invalidResponseFormatRequest =
    error instanceof Error &&
    (/^Responses (?:text|JSON Schema|output schema)/.test(error.message) ||
      /^Unsupported Responses text format:/.test(error.message) ||
      error.message === "Invalid or unsupported Responses output schema.");
  const invalidStructuredOutput = error instanceof BridgeStructuredOutputError;
  const contextLimit =
    error instanceof BridgeContextLimitError ||
    (error instanceof Error &&
      "code" in error &&
      error.code === "bridge_context_limit_exceeded");
  return {
    type: limited
      ? "rate_limit_error"
      : sessionExpired
        ? "authentication_error"
        : preparation || invalidResponseFormatRequest || contextLimit
          ? "invalid_request_error"
          : "server_error",
    code: limited
      ? "rate_limit_exceeded"
      : sessionExpired
        ? "chatgpt_web_session_expired"
        : sessionUnavailable
          ? "chatgpt_web_session_unavailable"
          : verificationRequired
            ? "chatgpt_web_verification_required"
            : contextLimit
              ? "bridge_context_limit_exceeded"
              : preparation
                ? modelSelectionFailure
                  ? "invalid_prompt"
                  : "codexgpt_bridge_preparation_failed"
                : invalidResponseFormatRequest
                  ? "invalid_response_format"
                  : invalidStructuredOutput
                    ? "bridge_structured_output_invalid"
                    : recovery
                      ? "bridge_operation_recovery_required"
                      : error instanceof UnsupportedWebNativeToolError
                        ? "bridge_web_tool_failed"
                        : error instanceof Error &&
                            /streamed|Network answer|text frame|duplicate logical message identities/.test(
                              error.message,
                            )
                          ? "bridge_stream_conflict"
                          : error instanceof Error &&
                              error.name === "AbortError"
                            ? "bridge_cancelled"
                            : "codexgpt_bridge_provider_error",
    message:
      error instanceof Error ? error.message : "Provider request failed.",
    ...(limited
      ? { retry_after_seconds: Math.ceil(error.retryAfterSeconds as number) }
      : {}),
  };
}

function failResponseStream(
  write: ResponseEventWriter,
  state: ResponseStreamState,
  error: unknown,
): void {
  const snapshot = responseSnapshot(state.model, "", state);
  emitResponseEvent(write, state, "response.failed", {
    response: {
      ...snapshot,
      status: "failed",
      output: [],
      error: providerFailure(error),
    },
  });
}

function beginHttpResponseStream(
  response: ServerResponse,
  model: string,
  heartbeatMs = STREAM_HEARTBEAT_MS,
  source?: unknown,
): {
  readonly state: ResponseStreamState;
  readonly heartbeat: NodeJS.Timeout;
} {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  const state = createResponseStreamState(model, source);
  const write: ResponseEventWriter = (type, payload) =>
    writeEvent(response, type, payload);
  beginResponseStream(write, state);
  const heartbeat = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) {
      emitResponseEvent(write, state, "response.heartbeat", {});
    }
  }, heartbeatMs);
  heartbeat.unref();
  return { state, heartbeat };
}

function sanitizedHeaders(
  headers: IncomingHttpHeaders,
  stripContentEncoding = false,
): Headers {
  const output = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      value === undefined ||
      lower === "host" ||
      lower === "connection" ||
      lower === "content-length" ||
      (stripContentEncoding && lower === "content-encoding") ||
      lower === "if-none-match"
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) output.append(key, item);
    } else {
      output.set(key, value);
    }
  }
  return output;
}

function copyResponseHeaders(source: Headers, target: ServerResponse): void {
  for (const [key, value] of source) {
    const lower = key.toLowerCase();
    if (
      lower === "content-length" ||
      lower === "connection" ||
      lower === "transfer-encoding"
    ) {
      continue;
    }
    target.setHeader(key, value);
  }
}

function modelSlug(value: unknown): string | undefined {
  const record = asRecord(value);
  return typeof record?.slug === "string" ? record.slug : undefined;
}

function bridgeWebModelRoute(model: unknown): BridgeWebModelRoute | undefined {
  if (typeof model !== "string") return undefined;
  return [
    ...CODEXGPT_BRIDGE_WEB_MODEL_ROUTES,
    ...BRIDGE_NATIVE_MODEL_ROUTES,
  ].find((route) => route.slug === model);
}

function isBridgeWebModel(model: unknown): model is string {
  return (
    typeof model === "string" && model.startsWith(CODEXGPT_BRIDGE_MODEL_PREFIX)
  );
}

function bridgeModel(
  template: JsonRecord | undefined,
  route: BridgeWebModelRoute,
  priority: number,
  accountProfile: BridgeAccountContextProfile = "compatibility",
): JsonRecord {
  const budget = resolveBridgeRouteContextBudget(route, accountProfile);
  const model: JsonRecord = {
    ...(template ?? {}),
    slug: route.slug,
    display_name: route.displayName,
    description: route.description,
    input_modalities: ["text", "image"],
    default_reasoning_level: route.effort,
    supported_reasoning_levels: (route.supportedEfforts ?? [route.effort]).map(
      (effort) => ({ effort, description: `${route.displayName} · ${effort}` }),
    ),
    visibility: route.contextMultiplier ? "hide" : "list",
    supported_in_api: true,
    // gpt-5.6 templates currently opt into Responses Lite, which moves every
    // client tool schema into an input.additional_tools item and leaves the
    // callable top-level tool surface empty for local bridge providers. This
    // gateway implements the standard Responses contract, so never inherit
    // that transport-only flag into Bridge-owned model rows.
    use_responses_lite: false,
    tool_mode:
      accountProfile !== "compatibility" ? null : (template?.tool_mode ?? null),
    multi_agent_version: template?.multi_agent_version ?? "v1",
    priority,
    context_window: budget.contextWindow,
    max_context_window: budget.hardInputTokenLimit,
    effective_context_window_percent: Math.round(
      (budget.autoCompactTokenLimit / budget.contextWindow) * 100,
    ),
    auto_compact_token_limit: budget.autoCompactTokenLimit,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
  };
  delete model.comp_hash;
  return model;
}

function availableBridgeRoutes(
  availableModes?: readonly BridgeWebMode[],
): readonly BridgeWebModelRoute[] {
  const allowed =
    availableModes === undefined ? undefined : new Set(availableModes);
  // Keep Pro selectable while an account's temporary restriction can recover.
  // The browser verifies the current Pro control on every request before Send.
  const listPro = availableModes?.some((mode) =>
    ["instant", "medium", "high", "extra-high", "pro"].includes(mode),
  );
  return CODEXGPT_BRIDGE_WEB_MODEL_ROUTES.filter(
    (route) =>
      allowed === undefined ||
      allowed.has(route.mode) ||
      (route.mode === "pro" && listPro),
  );
}

export function buildStartupModelsPayload(
  existingPayload: unknown,
  availableModes?: readonly BridgeWebMode[],
  accountProfile: BridgeAccountContextProfile = "compatibility",
  nativeFamilies?: readonly BridgeNativeModelFamily[],
  nativeRoutesEnabled: boolean | "simple" = true,
): unknown {
  const record = asRecord(existingPayload);
  if (record === undefined || !Array.isArray(record.models)) {
    throw new Error("Existing Codex model catalog is missing a models array.");
  }
  // The startup catalog is a snapshot of the catalog Codex was already using before Bridge
  // installation. Keep every non-Bridge row byte-for-byte equivalent at the JSON object level
  // and append only our own namespace. Runtime /models refreshes apply the same ownership rule.
  const merged = asRecord(
    mergeModelsPayload(
      existingPayload,
      availableModes,
      accountProfile,
      nativeFamilies,
      nativeRoutesEnabled,
    ),
  );
  if (merged === undefined || !Array.isArray(merged.models)) return merged;
  const fallbackInstructions = merged.models
    .map(asRecord)
    .map((model) => {
      if (typeof model?.base_instructions === "string") {
        return model.base_instructions;
      }
      const messages = asRecord(model?.model_messages);
      return typeof messages?.instructions_template === "string"
        ? messages.instructions_template
        : undefined;
    })
    .find((instructions) => instructions !== undefined);
  return {
    ...merged,
    models: merged.models.map((model) => {
      const row = asRecord(model);
      if (
        row === undefined ||
        (typeof row.base_instructions === "string" &&
          typeof row.supports_reasoning_summaries === "boolean" &&
          typeof row.supports_parallel_tool_calls === "boolean")
      ) {
        return model;
      }
      const messages = asRecord(row.model_messages);
      const instructions =
        typeof messages?.instructions_template === "string"
          ? messages.instructions_template
          : fallbackInstructions;
      return {
        ...row,
        ...(instructions === undefined
          ? {}
          : { base_instructions: instructions }),
        supports_reasoning_summaries:
          typeof row.supports_reasoning_summaries === "boolean"
            ? row.supports_reasoning_summaries
            : true,
        supports_parallel_tool_calls:
          typeof row.supports_parallel_tool_calls === "boolean"
            ? row.supports_parallel_tool_calls
            : true,
      };
    }),
  };
}

export function mergeModelsPayload(
  originalProviderPayload: unknown,
  availableModes?: readonly BridgeWebMode[],
  accountProfile: BridgeAccountContextProfile = "compatibility",
  nativeFamilies?: readonly BridgeNativeModelFamily[],
  nativeRoutesEnabled: boolean | "simple" = true,
): unknown {
  const record = asRecord(originalProviderPayload);
  if (record === undefined || !Array.isArray(record.models))
    return originalProviderPayload;
  const models = record.models.filter(
    (model) => !isBridgeWebModel(modelSlug(model)),
  );
  const template =
    models.map(asRecord).find((model) => model !== undefined) ??
    record.models.map(asRecord).find((model) => model !== undefined);
  const families = nativeFamilies ?? bridgeCatalogNativeFamilies(record);
  const nativeRoutes = availableNativeModelRoutes(
    availableModes,
    accountProfile,
    families,
    nativeRoutesEnabled,
  );
  const hasNamedRoutes = nativeRoutes.some((route) => !route.contextMultiplier);
  models.push(
    ...availableBridgeRoutes(availableModes).map((route, index) => ({
      ...bridgeModel(template, route, 50 + index, accountProfile),
      // Retain legacy IDs for existing chats while named routes own the picker.
      visibility: hasNamedRoutes ? "hide" : "list",
    })),
    ...nativeRoutes.map((route, index) =>
      bridgeModel(template, route, 30 + index, accountProfile),
    ),
  );
  const capabilities = asRecord(record.bridge_account_capabilities);
  return {
    ...record,
    models,
    ...(availableModes === undefined &&
    nativeFamilies === undefined &&
    !record.bridge_account_capabilities
      ? {}
      : {
          bridge_account_capabilities: {
            ...capabilities,
            version: 1,
            native_families: [...families],
            ...(availableModes === undefined
              ? {}
              : { available_modes: [...availableModes] }),
          },
        }),
  };
}

export function augmentModelsPayload(
  payload: unknown,
  availableModes?: readonly BridgeWebMode[],
  accountProfile: BridgeAccountContextProfile = "compatibility",
  nativeFamilies?: readonly BridgeNativeModelFamily[],
): unknown {
  return mergeModelsPayload(
    payload,
    availableModes,
    accountProfile,
    nativeFamilies,
  );
}

export function buildWebOnlyModelsPayload(
  payload: unknown,
  availableModes?: readonly BridgeWebMode[],
  accountProfile: BridgeAccountContextProfile = "compatibility",
  nativeFamilies?: readonly BridgeNativeModelFamily[],
  nativeRoutesEnabled: boolean | "simple" = true,
): unknown {
  const existing = asRecord(payload);
  // A Web-only snapshot is already compiled against the installed native schema.
  // Do not strip all its templates and rebuild from an empty native catalog on refresh.
  const alreadyWebOnly =
    Array.isArray(existing?.models) &&
    existing.models.length > 0 &&
    existing.models.every((row) => bridgeWebModelRoute(modelSlug(row)));
  const families = nativeFamilies ?? bridgeCatalogNativeFamilies(payload);
  const catalog =
    alreadyWebOnly && nativeFamilies === undefined && families.length === 0
      ? existing
      : asRecord(
          buildStartupModelsPayload(
            payload,
            availableModes,
            accountProfile,
            nativeFamilies,
            nativeRoutesEnabled,
          ),
        );
  if (!catalog || !Array.isArray(catalog.models)) {
    throw new Error("Web-only model catalog is unavailable.");
  }
  const legacyRoutes = availableBridgeRoutes(availableModes);
  const rows = [...catalog.models];
  const pro = legacyRoutes.find((route) => route.mode === "pro");
  if (pro && !rows.some((row) => modelSlug(row) === pro.slug)) {
    rows.push(bridgeModel(asRecord(rows[0]), pro, 54, accountProfile));
  }
  return {
    ...(catalog.bridge_account_capabilities || availableModes !== undefined
      ? {
          bridge_account_capabilities: {
            ...asRecord(catalog.bridge_account_capabilities),
            version: 1,
            native_families: [...families],
            ...(availableModes === undefined
              ? {}
              : { available_modes: [...availableModes] }),
          },
        }
      : {}),
    models: rows
      .filter((row) => {
        const route = bridgeWebModelRoute(modelSlug(row));
        return (
          route !== undefined &&
          (route.supportedEfforts
            ? availableNativeModelRoutes(
                availableModes,
                accountProfile,
                families,
                nativeRoutesEnabled,
              ).some((candidate) => candidate.slug === route.slug)
            : legacyRoutes.some((candidate) => candidate.slug === route.slug))
        );
      })
      .map((row) => {
        if (accountProfile === "compatibility") return row;
        const route = bridgeWebModelRoute(modelSlug(row))!;
        const budget = resolveBridgeRouteContextBudget(route, accountProfile);
        return {
          ...asRecord(row),
          context_window: budget.contextWindow,
          max_context_window: budget.hardInputTokenLimit,
          auto_compact_token_limit: budget.autoCompactTokenLimit,
          effective_context_window_percent: Math.round(
            (budget.autoCompactTokenLimit / budget.contextWindow) * 100,
          ),
        };
      }),
  };
}

function matchesWebOnlyToken(
  headers: IncomingHttpHeaders,
  token?: string,
): boolean {
  if (!token) return false;
  const actual = Buffer.from(bearer(headers)?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function matchesBearerToken(
  headers: IncomingHttpHeaders,
  token: string,
): boolean {
  const actual = Buffer.from(bearer(headers)?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function lifecyclePayload(status: ProviderLifecycleStatus): JsonRecord {
  return {
    state: status.state,
    accepting_turns: status.acceptingTurns,
    active_http_turns: status.activeHttpTurns,
    active_browser_turns: status.activeBrowserTurns,
    active_tool_turns: status.activeToolTurns,
    ...(status.drainId ? { drain_id: status.drainId } : {}),
    ...(status.drainingSince ? { draining_since: status.drainingSince } : {}),
  };
}

function routingHintModel(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers["x-codex-routing-hint"];
  const value = Array.isArray(raw) ? raw.join(";") : raw;
  if (typeof value !== "string") return undefined;
  return /(?:^|[,;\s])model=([^,;\s]+)/.exec(value)?.[1];
}

function rejectWebSocketUpgrade(
  socket: Duplex,
  status: number,
  message: string,
): void {
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function webSocketText(data: RawData): string {
  return (
    Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
  ).toString("utf8");
}

export class ResponsesGateway {
  readonly #options: ResponsesGatewayOptions;
  readonly #lifecycle = new ProviderLifecycleController();
  readonly #turns = new TurnOwnershipRegistry();
  readonly #progressTurns = new Set<string>();
  readonly #history = new Map<
    string,
    { request: JsonRecord; output: readonly JsonRecord[]; bytes: number }
  >();
  #historyBytes = 0;
  readonly #fullCoordinator: FullTurnCoordinator | undefined;
  #hydrate(value: unknown): unknown {
    const record = asRecord(value);
    if (!record || typeof record.previous_response_id !== "string")
      return value;
    const previous = this.#history.get(record.previous_response_id);
    if (!previous)
      throw new Error(
        "Previous response is unavailable; resend the complete Codex context.",
      );
    const input =
      typeof record.input === "string"
        ? [{ role: "user", content: record.input }]
        : Array.isArray(record.input)
          ? record.input
          : [];
    return {
      ...record,
      ...(record.tools === undefined && previous.request.tools !== undefined
        ? { tools: previous.request.tools }
        : {}),
      ...(record.tool_choice === undefined &&
      previous.request.tool_choice !== undefined
        ? { tool_choice: previous.request.tool_choice }
        : {}),
      ...(record.parallel_tool_calls === undefined &&
      previous.request.parallel_tool_calls !== undefined
        ? { parallel_tool_calls: previous.request.parallel_tool_calls }
        : {}),
      ...(record.instructions === undefined &&
      previous.request.instructions !== undefined
        ? { instructions: previous.request.instructions }
        : {}),
      ...(record.text === undefined && previous.request.text !== undefined
        ? { text: previous.request.text }
        : {}),
      ...(record.metadata === undefined &&
      previous.request.metadata !== undefined
        ? { metadata: previous.request.metadata }
        : {}),
      ...(record.client_metadata === undefined &&
      previous.request.client_metadata !== undefined
        ? { client_metadata: previous.request.client_metadata }
        : {}),
      input: [
        ...(Array.isArray(previous.request.input)
          ? previous.request.input
          : [{ role: "user", content: previous.request.input }]),
        ...previous.output,
        ...input,
      ],
    };
  }
  #remember(
    source: unknown,
    state: ResponseStreamState,
    result: BridgeWebTurnResult,
  ): void {
    const request = asRecord(source);
    if (!request) return;
    const output = withProgressOutput(
      bridgeResponseSnapshot(state, result),
      state,
    ).output as JsonRecord[];
    const bytes = Buffer.byteLength(JSON.stringify([request, output]));
    const old = this.#history.get(state.responseId);
    if (old) {
      this.#historyBytes -= old.bytes;
      this.#history.delete(state.responseId);
    }
    if (bytes > MAX_BODY_BYTES) return;
    this.#history.set(state.responseId, { request, output, bytes });
    this.#historyBytes += bytes;
    while (this.#historyBytes > MAX_BODY_BYTES || this.#history.size > 100) {
      const first = this.#history.keys().next().value;
      if (!first) break;
      this.#historyBytes -= this.#history.get(first)!.bytes;
      this.#history.delete(first);
    }
  }
  #server: Server | undefined;
  #webSocketServer: WebSocketServer | undefined;

  constructor(options: ResponsesGatewayOptions) {
    if (options.admin && options.admin.token.length < 16)
      throw new Error(
        "Provider admin token must contain at least 16 characters.",
      );
    this.#options = {
      ...options,
      lunaCheckpoints: options.lunaCheckpoints ?? new LunaCheckpointStore(),
    };
    this.#fullCoordinator = options.fullMcp
      ? new FullTurnCoordinator(options.fullMcp.broker)
      : undefined;
  }

  lifecycleStatus(): ProviderLifecycleStatus {
    return this.#lifecycle.status();
  }

  interruptTurn(identity: NativeTurnIdentity): {
    readonly matchedHttp: number;
    readonly matchedBrowser: number;
    readonly alreadyInterrupted: boolean;
  } {
    const reason = new DOMException("Codex turn interrupted.", "AbortError");
    const transport = this.#turns.interrupt(identity, reason);
    const browser =
      this.#fullCoordinator?.interrupt(
        identity.threadId,
        identity.turnId,
        reason,
      ) ?? 0;
    return {
      matchedHttp: transport.matched,
      matchedBrowser: browser,
      alreadyInterrupted: transport.alreadyInterrupted,
    };
  }

  #ownTurn(source: unknown, controller: AbortController): LifecycleLease {
    const identity = responsesNativeTurnIdentity(source);
    return identity
      ? this.#turns.register(identity, controller)
      : { release: () => undefined };
  }

  #reportProgress(
    write: ResponseEventWriter,
    state: ResponseStreamState,
    source: unknown,
    observedStage: BridgeProgressStage,
  ): void {
    if (state.textStarted) return;
    const stage = bridgeProgressDisplayStage(observedStage);
    if (stage === "working") {
      const identity = responsesNativeTurnIdentity(source);
      const key = identity
        ? `${identity.threadId}\0${identity.turnId}`
        : undefined;
      if (key && this.#progressTurns.has(key)) return;
      // Older clients may omit turn metadata. Their replayed commentary still
      // identifies a notice already delivered after the latest user message.
      const input = asRecord(source)?.input;
      if (Array.isArray(input)) {
        for (let index = input.length - 1; index >= 0; index -= 1) {
          const item = asRecord(input[index]);
          if (item?.role === "user") break;
          if (
            isBridgeProgressMessage(item) &&
            (item!.content as JsonRecord[])[0]?.text ===
              bridgeProgressText("working")
          )
            return;
        }
      }
      if (key) {
        this.#progressTurns.add(key);
        // Bound memory without expiring a long-running native user turn.
        if (this.#progressTurns.size > 10_000)
          this.#progressTurns.delete(
            this.#progressTurns.values().next().value!,
          );
      }
    }
    appendBridgeProgress(write, state, stage);
  }

  async #availableWebModes(): Promise<readonly BridgeWebMode[] | undefined> {
    const configured = await this.#options.availableWebModes?.();
    if (configured === undefined) return undefined;
    const known = new Set(
      CODEXGPT_BRIDGE_WEB_MODEL_ROUTES.map((route) => route.mode),
    );
    if (configured.some((mode) => !known.has(mode))) {
      throw new Error("Configured ChatGPT capability snapshot is invalid.");
    }
    return [...new Set(configured)];
  }

  async #availableBridgeRoute(
    model: unknown,
    reasoning?: unknown,
  ): Promise<BridgeWebModelRoute | undefined> {
    const route = bridgeWebModelRoute(model);
    if (route === undefined) return undefined;
    if (route.supportedEfforts) {
      const fullEnabled = (await this.#options.fullMcp?.enabled()) === true;
      const available = availableNativeModelRoutes(
        await this.#availableWebModes(),
        (await this.#options.accountContextProfile?.()) ?? "compatibility",
        (await this.#options.nativeModelFamilies?.()) ?? [],
        fullEnabled ? true : "simple",
      );
      const native = available.find(
        (candidate) => candidate.slug === route.slug,
      );
      if (!native) return undefined;
      const record = asRecord(reasoning);
      if (reasoning !== undefined && !record)
        throw new BridgeReasoningEffortError(
          route.slug,
          reasoning,
          native.supportedEfforts!,
        );
      return resolveNativeRouteEffort(native, record?.effort);
    }
    return availableBridgeRoutes(await this.#availableWebModes()).find(
      (candidate) => candidate.slug === route.slug,
    );
  }

  async start(): Promise<ResponsesGatewayAddress> {
    if (this.#server !== undefined)
      throw new Error("Responses gateway is already running.");
    const server = createServer((request, response) => {
      guardHttpExchange(request, response);
      void this.#handle(request, response).catch(() =>
        destroyHttpExchange(request, response),
      );
    });
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_BODY_BYTES,
      perMessageDeflate: false,
    });
    server.on("connection", guardSocket);
    server.on("clientError", (_error, socket) => {
      if (!socket.destroyed) socket.destroy();
    });
    server.on("upgrade", (request, socket, head) => {
      this.#upgrade(request, socket, head);
    });
    webSocketServer.on("error", () => undefined);
    this.#server = server;
    this.#webSocketServer = webSocketServer;
    const host = this.#options.host ?? "127.0.0.1";
    const port = this.#options.port ?? 7767;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(port, host, () => resolvePromise());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Responses gateway did not expose a TCP address.");
    }
    return {
      host,
      port: address.port,
      baseUrl: `http://${host}:${address.port}/v1`,
    };
  }

  async close(): Promise<void> {
    const server = this.#server;
    const webSocketServer = this.#webSocketServer;
    this.#server = undefined;
    this.#webSocketServer = undefined;
    this.#fullCoordinator?.close();
    if (server === undefined) return;
    if (webSocketServer !== undefined) {
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise<void>((resolvePromise) =>
        webSocketServer.close(() => resolvePromise()),
      );
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) =>
        error === undefined ? resolvePromise() : rejectPromise(error),
      );
      server.closeAllConnections();
    });
  }

  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const webOnly = requestUrl.pathname === "/web/v1/responses";
    if (!webOnly && requestUrl.pathname !== "/v1/responses") {
      rejectWebSocketUpgrade(socket, 404, "Not Found");
      return;
    }
    if (
      webOnly
        ? !matchesWebOnlyToken(request.headers, this.#options.webOnly?.token)
        : bearer(request.headers) === undefined ||
          matchesWebOnlyToken(request.headers, this.#options.webOnly?.token)
    ) {
      rejectWebSocketUpgrade(socket, 401, "Unauthorized");
      return;
    }
    const hintedModel = routingHintModel(request.headers);
    if (
      hintedModel !== undefined &&
      bridgeWebModelRoute(hintedModel) === undefined
    ) {
      rejectWebSocketUpgrade(socket, 426, "Upgrade Required");
      return;
    }
    const webSocketServer = this.#webSocketServer;
    if (webSocketServer === undefined) {
      rejectWebSocketUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.#serveBridgeWebSocket(webSocket);
    });
  }

  #serveBridgeWebSocket(webSocket: WebSocket): void {
    let activeAbortController: AbortController | undefined;
    let messageQueue = Promise.resolve();
    const heartbeat = setInterval(() => {
      if (webSocket.readyState === WebSocket.OPEN) webSocket.ping();
    }, WEBSOCKET_HEARTBEAT_MS);
    heartbeat.unref();

    webSocket.on("message", (data, isBinary) => {
      if (isBinary) {
        webSocket.close(1003, "Text messages are required.");
        return;
      }
      const text = webSocketText(data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        this.#sendWebSocketError(
          webSocket,
          "invalid_json",
          "WebSocket messages must contain valid JSON.",
        );
        return;
      }
      const record = asRecord(parsed);
      // A cancellation cannot wait behind the response it needs to cancel.
      // Handle it before entering the serial response.create queue.
      if (record?.type === "response.cancel") {
        activeAbortController?.abort();
        return;
      }
      messageQueue = messageQueue
        .then(async () => {
          if (record?.type !== "response.create") {
            this.#sendWebSocketError(
              webSocket,
              "unsupported_event",
              "Only response.create events are supported.",
            );
            return;
          }
          let lifecycleLease: LifecycleLease | undefined;
          let turnLease: LifecycleLease | undefined;
          try {
            lifecycleLease = this.#lifecycle.acquireHttpTurn();
          } catch (error) {
            if (error instanceof ProviderDrainingError) {
              this.#sendWebSocketError(webSocket, error.code, error.message, {
                status: 503,
                type: "server_error",
                retryAfterSeconds: 5,
              });
              return;
            }
            throw error;
          }
          try {
            const knownRoute = bridgeWebModelRoute(record.model);
            const route = await this.#availableBridgeRoute(
              record.model,
              record.reasoning,
            );
            if (route === undefined) {
              this.#sendWebSocketError(
                webSocket,
                knownRoute
                  ? "bridge_web_model_unavailable"
                  : "unsupported_bridge_web_model",
                knownRoute
                  ? `CodexGPT Bridge Web model is unavailable for the probed ChatGPT account: ${String(record.model)}`
                  : `Unsupported CodexGPT Bridge Web model: ${String(record.model)}`,
              );
              return;
            }

            parsed = this.#hydrate(parsed);
            const state = createResponseStreamState(route.slug, parsed);
            const rawWrite: ResponseEventWriter = (_type, payload) => {
              if (webSocket.readyState === WebSocket.OPEN) {
                webSocket.send(JSON.stringify(payload));
              }
            };
            const write = progressEventWriter(rawWrite, state);
            const abortController = new AbortController();
            activeAbortController = abortController;
            turnLease = this.#ownTurn(parsed, abortController);
            beginResponseStream(write, state);
            const applicationHeartbeat = setInterval(() => {
              if (webSocket.readyState === WebSocket.OPEN) {
                emitResponseEvent(write, state, "response.heartbeat", {});
              }
            }, this.#options.applicationHeartbeatMs ?? STREAM_HEARTBEAT_MS);
            applicationHeartbeat.unref();
            try {
              const compiled = compileResponsesPrompt(parsed);
              const result = await runBridgeWebTurn(
                this.#options,
                this.#fullCoordinator,
                this.#lifecycle,
                compiled,
                route,
                abortController.signal,
                (delta) => appendTextDelta(write, state, delta),
                (stage) => this.#reportProgress(rawWrite, state, parsed, stage),
                (tokens) => {
                  state.inputTokens = tokens;
                },
                (entry) =>
                  appendCommentaryItem(
                    rawWrite,
                    state,
                    publicCommentaryOutputId(compiled.turnId!, entry.messageId),
                    entry.text,
                  ),
              );
              this.#remember(parsed, state, result);
              if (
                !abortController.signal.aborted &&
                webSocket.readyState === WebSocket.OPEN
              ) {
                completeBridgeResponseStream(write, state, result);
              }
            } catch (error) {
              if (
                !abortController.signal.aborted &&
                webSocket.readyState === WebSocket.OPEN
              ) {
                failResponseStream(write, state, error);
              }
            } finally {
              clearInterval(applicationHeartbeat);
              if (activeAbortController === abortController) {
                activeAbortController = undefined;
              }
            }
          } finally {
            turnLease?.release();
            lifecycleLease.release();
          }
        })
        .catch((error: unknown) => {
          const failure = providerFailure(error);
          this.#sendWebSocketError(webSocket, failure.code, failure.message, {
            status:
              failure.retry_after_seconds !== undefined
                ? 429
                : failure.type === "invalid_request_error"
                  ? 400
                  : 500,
            type: failure.type,
            ...(failure.retry_after_seconds === undefined
              ? {}
              : { retryAfterSeconds: failure.retry_after_seconds }),
          });
        });
    });
    webSocket.once("close", () => {
      clearInterval(heartbeat);
      activeAbortController?.abort(transportDisconnectError());
    });
    webSocket.on("error", () => undefined);
  }

  #sendWebSocketError(
    webSocket: WebSocket,
    code: string,
    message: string,
    options: {
      readonly status?: number;
      readonly type?: string;
      readonly retryAfterSeconds?: number;
    } = {},
  ): void {
    if (webSocket.readyState !== WebSocket.OPEN) return;
    webSocket.send(
      JSON.stringify({
        type: "error",
        // Codex maps pre-response WebSocket errors through an HTTP status and
        // a nested error. A flat event is ignored until the stream idle timeout.
        status: options.status ?? 400,
        error: {
          type: options.type ?? "invalid_request_error",
          code,
          message,
          param: null,
        },
        ...(options.retryAfterSeconds === undefined
          ? {}
          : { headers: { "retry-after": String(options.retryAfterSeconds) } }),
        sequence_number: 0,
      }),
    );
  }

  async #handleAdmin(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL,
  ): Promise<boolean> {
    if (requestUrl.pathname === "/health" && request.method === "GET") {
      json(response, 200, {
        service: "codexgpt-bridge-provider",
        status: "ok",
        ...lifecyclePayload(this.#lifecycle.status()),
      });
      return true;
    }
    if (!requestUrl.pathname.startsWith("/admin/")) return false;
    const admin = this.#options.admin;
    if (!admin) {
      json(response, 404, { error: { code: "not_found" } });
      return true;
    }
    if (!matchesBearerToken(request.headers, admin.token)) {
      json(response, 401, { error: { code: "unauthorized" } });
      return true;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/admin/lifecycle"
    ) {
      json(response, 200, lifecyclePayload(this.#lifecycle.status()));
      return true;
    }
    if (request.method === "POST" && requestUrl.pathname === "/admin/drain") {
      json(response, 200, lifecyclePayload(this.#lifecycle.drain()));
      return true;
    }
    const body = await readBody(request);
    let parsed: JsonRecord | undefined;
    try {
      parsed = asRecord(JSON.parse(body.toString("utf8")) as unknown);
    } catch {
      parsed = undefined;
    }
    if (!parsed) {
      json(response, 400, {
        error: {
          code: "invalid_admin_request",
          message: "Valid JSON is required.",
        },
      });
      return true;
    }
    if (request.method === "POST" && requestUrl.pathname === "/admin/command") {
      if (
        !admin.onCommand ||
        typeof parsed.command !== "string" ||
        !Array.isArray(parsed.args) ||
        parsed.args.length > 8
      ) {
        json(response, 400, { error: { code: "invalid_command" } });
        return true;
      }
      try {
        json(response, 200, {
          result: await admin.onCommand(parsed.command, parsed.args),
        });
      } catch (error) {
        json(response, 400, {
          error: {
            code: "command_failed",
            message:
              error instanceof Error
                ? error.message
                : "Desktop command failed.",
          },
        });
      }
      return true;
    }
    if (request.method === "POST" && requestUrl.pathname === "/admin/resume") {
      json(
        response,
        200,
        lifecyclePayload(this.#lifecycle.resume(String(parsed.drain_id ?? ""))),
      );
      return true;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/admin/interrupt-turn"
    ) {
      const threadId = parsed.thread_id;
      const turnId = parsed.turn_id;
      if (
        typeof threadId !== "string" ||
        typeof turnId !== "string" ||
        !/^[A-Za-z0-9_-]{6,128}$/u.test(threadId) ||
        !/^[A-Za-z0-9_-]{6,128}$/u.test(turnId)
      ) {
        json(response, 400, {
          error: {
            code: "invalid_turn_identity",
            message:
              "thread_id and turn_id must be exact native Codex identities.",
          },
        });
        return true;
      }
      const interrupted = this.interruptTurn({ threadId, turnId });
      json(response, 200, {
        status: "ok",
        cancelled_http_turns: interrupted.matchedHttp,
        cancelled_browser_turns: interrupted.matchedBrowser,
        matched_http: interrupted.matchedHttp,
        matched_browser: interrupted.matchedBrowser,
        already_interrupted: interrupted.alreadyInterrupted,
      });
      return true;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/admin/shutdown"
    ) {
      const status = this.#lifecycle.beginShutdown(
        String(parsed.drain_id ?? ""),
      );
      json(response, 202, lifecyclePayload(status));
      setTimeout(() => void admin.onShutdown?.(), 0).unref?.();
      return true;
    }
    json(response, 404, { error: { code: "not_found" } });
    return true;
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let lifecycleLease: LifecycleLease | undefined;
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (await this.#handleAdmin(request, response, requestUrl)) return;
      const webOnly = requestUrl.pathname.startsWith("/web/v1/");
      if (webOnly) requestUrl.pathname = requestUrl.pathname.slice(4);
      if (!requestUrl.pathname.startsWith("/v1/")) {
        json(response, 404, { error: { message: "Not found." } });
        return;
      }
      if (
        webOnly
          ? !matchesWebOnlyToken(request.headers, this.#options.webOnly?.token)
          : bearer(request.headers) === undefined ||
            matchesWebOnlyToken(request.headers, this.#options.webOnly?.token)
      ) {
        json(response, 401, {
          error: { message: "Bearer authorization is required." },
        });
        return;
      }

      lifecycleLease = this.#lifecycle.acquireHttpTurn();

      if (
        webOnly &&
        !(
          (request.method === "GET" && requestUrl.pathname === "/v1/models") ||
          (request.method === "POST" &&
            ["/v1/responses", "/v1/responses/compact"].includes(
              requestUrl.pathname,
            ))
        )
      ) {
        json(response, 404, {
          error: { message: "This provider supports Web models only." },
        });
        return;
      }

      const body =
        request.method === "GET" || request.method === "HEAD"
          ? Buffer.alloc(0)
          : await readBody(request);
      const inspectedBody =
        body.length === 0 ? body : decodedBody(request.headers, body);
      if (requestUrl.pathname === "/v1/models" && request.method === "GET") {
        if (webOnly) {
          const availableModes = await this.#availableWebModes();
          json(
            response,
            200,
            buildWebOnlyModelsPayload(
              await this.#options.webOnly!.models(),
              availableModes,
              await this.#options.accountContextProfile?.(),
              await this.#options.nativeModelFamilies?.(),
              (await this.#options.fullMcp?.enabled()) === true
                ? true
                : "simple",
            ),
          );
          return;
        }
        await this.#models(request, response, requestUrl);
        return;
      }
      let parsed: unknown;
      if (inspectedBody.length !== 0) {
        try {
          parsed = JSON.parse(inspectedBody.toString("utf8")) as unknown;
        } catch {
          parsed = undefined;
        }
      }
      const headerMetadata = request.headers["x-codex-turn-metadata"];
      if (typeof headerMetadata === "string" && asRecord(parsed)) {
        const body = asRecord(parsed)!;
        parsed = {
          ...body,
          client_metadata: {
            ...asRecord(body.client_metadata),
            "x-codex-turn-metadata": headerMetadata,
          },
        };
      }
      const record = asRecord(parsed);
      const knownBridgeRoute = bridgeWebModelRoute(record?.model);
      const availableBridgeRoute = await this.#availableBridgeRoute(
        record?.model,
        record?.reasoning,
      );
      if (knownBridgeRoute && !availableBridgeRoute) {
        json(response, 400, {
          error: {
            type: "invalid_request_error",
            code: "bridge_web_model_unavailable",
            message: `CodexGPT Bridge Web model is unavailable for the probed ChatGPT account: ${String(record?.model)}`,
          },
        });
        return;
      }
      if (webOnly && !knownBridgeRoute) {
        json(response, 400, {
          error: {
            type: "invalid_request_error",
            code: "web_only_model_required",
            message:
              "Choose a CodexGPT Bridge Web model. Native models require the regular provider.",
          },
        });
        return;
      }
      if (
        requestUrl.pathname === "/v1/responses/compact" &&
        request.method === "POST" &&
        availableBridgeRoute
      ) {
        const route = availableBridgeRoute;
        const compiled = compileResponsesPrompt({
          ...record,
          bridge_compaction: true,
        });
        const controller = new AbortController();
        const turnLease = this.#ownTurn(parsed, controller);
        request.once("aborted", () => controller.abort());
        response.once("close", () => {
          if (!response.writableEnded) controller.abort();
        });
        let result: BridgeWebTurnResult;
        try {
          result = await runBridgeWebTurn(
            this.#options,
            this.#fullCoordinator,
            this.#lifecycle,
            compiled,
            route,
            controller.signal,
          );
        } finally {
          turnLease.release();
        }
        if (result.kind !== "compaction")
          throw new Error("Compaction did not produce a checkpoint.");
        json(response, 200, {
          id: `cmp_${randomUUID()}`,
          object: "response.compaction",
          created_at: Math.floor(Date.now() / 1000),
          output: [
            {
              type: "compaction",
              id: `cmp_${randomUUID()}`,
              encrypted_content:
                "cgb1:" +
                Buffer.from(result.summary, "utf8").toString("base64"),
            },
          ],
        });
        return;
      }
      if (
        requestUrl.pathname === "/v1/responses" &&
        request.method === "POST"
      ) {
        const requestedModel = record?.model;
        const route = availableBridgeRoute;
        if (route !== undefined) {
          parsed = this.#hydrate(parsed);
          const compiled = compileResponsesPrompt(parsed);
          const abortController = new AbortController();
          const turnLease = this.#ownTurn(parsed, abortController);
          const abort = (): void =>
            abortController.abort(transportDisconnectError());
          request.once("aborted", abort);
          response.once("close", () => {
            if (!response.writableEnded) abort();
          });
          if (record?.stream === true) {
            const stream = beginHttpResponseStream(
              response,
              route.slug,
              this.#options.applicationHeartbeatMs ?? STREAM_HEARTBEAT_MS,
              parsed,
            );
            const rawWrite: ResponseEventWriter = (type, payload) =>
              writeEvent(response, type, payload);
            const write = progressEventWriter(rawWrite, stream.state);
            try {
              const result = await runBridgeWebTurn(
                this.#options,
                this.#fullCoordinator,
                this.#lifecycle,
                compiled,
                route,
                abortController.signal,
                (delta) => appendTextDelta(write, stream.state, delta),
                (stage) =>
                  this.#reportProgress(rawWrite, stream.state, parsed, stage),
                (tokens) => {
                  stream.state.inputTokens = tokens;
                },
                (entry) =>
                  appendCommentaryItem(
                    rawWrite,
                    stream.state,
                    publicCommentaryOutputId(compiled.turnId!, entry.messageId),
                    entry.text,
                  ),
              );
              this.#remember(parsed, stream.state, result);
              if (abortController.signal.aborted || response.destroyed) return;
              completeBridgeResponseStream(write, stream.state, result);
            } catch (error) {
              if (abortController.signal.aborted || response.destroyed) return;
              failResponseStream(write, stream.state, error);
            } finally {
              clearInterval(stream.heartbeat);
              turnLease.release();
            }
            response.end("data: [DONE]\n\n");
            return;
          }
          const state = createResponseStreamState(route.slug, parsed);
          let result: BridgeWebTurnResult;
          try {
            result = await runBridgeWebTurn(
              this.#options,
              this.#fullCoordinator,
              this.#lifecycle,
              compiled,
              route,
              abortController.signal,
              undefined,
              undefined,
              (tokens) => {
                state.inputTokens = tokens;
              },
            );
          } finally {
            turnLease.release();
          }
          if (abortController.signal.aborted || response.destroyed) return;
          this.#remember(parsed, state, result);
          json(response, 200, bridgeResponseSnapshot(state, result));
          return;
        }
        if (isBridgeWebModel(requestedModel)) {
          json(response, 400, {
            error: {
              type: "invalid_request_error",
              code: "unsupported_bridge_web_model",
              message: `Unsupported CodexGPT Bridge Web model: ${requestedModel}`,
            },
          });
          return;
        }
      }

      await this.#forward(
        request,
        response,
        requestUrl,
        body,
        await this.#originalProviderBaseUrl(),
        parsed,
      );
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof ProviderDrainingError) {
        response.setHeader("Retry-After", "5");
        json(response, 503, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      if (error instanceof ProviderLifecycleConflictError) {
        json(response, 409, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      const failure = providerFailure(error);
      if (failure.retry_after_seconds !== undefined)
        response.setHeader("Retry-After", String(failure.retry_after_seconds));
      json(
        response,
        failure.retry_after_seconds !== undefined
          ? 429
          : failure.type === "invalid_request_error"
            ? 400
            : 500,
        {
          error: failure,
        },
      );
    } finally {
      lifecycleLease?.release();
    }
  }

  async #originalProviderBaseUrl(): Promise<string> {
    const configured =
      typeof this.#options.upstreamBaseUrl === "function"
        ? await this.#options.upstreamBaseUrl()
        : this.#options.upstreamBaseUrl;
    return (configured ?? DEFAULT_UPSTREAM).replace(/\/+$/u, "");
  }

  async #models(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    const fetchImpl = this.#options.fetchImpl ?? fetch;
    const suffix = requestUrl.pathname.replace(/^\/v1/, "");
    const headers = sanitizedHeaders(request.headers);
    const originalProvider = await fetchImpl(
      `${await this.#originalProviderBaseUrl()}${suffix}${requestUrl.search}`,
      {
        method: "GET",
        headers,
        redirect: "manual",
      },
    );
    if (!originalProvider.ok) {
      response.statusCode = originalProvider.status;
      copyResponseHeaders(originalProvider.headers, response);
      response.end(Buffer.from(await originalProvider.arrayBuffer()));
      return;
    }

    const originalProviderPayload = (await originalProvider.json()) as unknown;
    json(
      response,
      originalProvider.status,
      mergeModelsPayload(
        originalProviderPayload,
        await this.#availableWebModes(),
        await this.#options.accountContextProfile?.(),
        await this.#options.nativeModelFamilies?.(),
        (await this.#options.fullMcp?.enabled()) === true ? true : "simple",
      ),
    );
  }

  async #forward(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL,
    body: Buffer,
    upstreamBaseUrl: string,
    source?: unknown,
    stripContentEncoding = false,
  ): Promise<void> {
    const fetchImpl = this.#options.fetchImpl ?? fetch;
    const suffix = requestUrl.pathname.replace(/^\/v1/, "");
    const upstreamUrl = `${upstreamBaseUrl}${suffix}${requestUrl.search}`;
    const abortController = new AbortController();
    const turnLease = this.#ownTurn(source, abortController);
    const abort = (): void => abortController.abort(transportDisconnectError());
    request.once("aborted", abort);
    response.once("close", () => {
      if (!response.writableEnded) abort();
    });
    try {
      const upstream = await fetchImpl(upstreamUrl, {
        method: request.method ?? "GET",
        headers: sanitizedHeaders(request.headers, stripContentEncoding),
        ...(body.length === 0 ? {} : { body }),
        redirect: "manual",
        signal: abortController.signal,
      });

      response.statusCode = upstream.status;
      copyResponseHeaders(upstream.headers, response);
      if (upstream.body === null) {
        response.end();
        return;
      }
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (!response.write(Buffer.from(chunk.value))) {
            await new Promise<void>((resolvePromise) =>
              response.once("drain", resolvePromise),
            );
          }
        }
        response.end();
      } finally {
        reader.releaseLock();
      }
    } finally {
      turnLease.release();
    }
  }
}
