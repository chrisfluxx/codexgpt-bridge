import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  normalizeResponsesTools,
  type BridgeToolCall,
  type BridgeToolDefinition,
} from "./tool-protocol.js";
import { canonicalJson } from "./operation-identity.js";
import { validateToolArguments } from "./tool-validation.js";
import { BRIDGE_FULL_TURN_TIMEOUT_MS } from "./full-turn-limits.js";
import {
  createFullCheckpoint,
  checkpointSummary,
  fullCheckpointTool,
  type FullCheckpoint,
} from "./full-checkpoint.js";
import {
  isNativeAgentSpawn,
  isNativeAgentWait,
  isNativeAgentResume,
  isNativeAgentStatus,
  fullTransportExec,
  NATIVE_AGENT_SPAWN_NAMES,
  NATIVE_AGENT_WAIT_NAMES,
} from "./full-native-transport.js";
import {
  consumeNativeAgentAudit,
  inspectNativeAgentResult,
  isNativeAgentCapacityRejection,
  nativeAgentTargetIds,
  runningNativeCell,
  type NativeAgentAudit,
  type NativeAgentAuditPolicy,
} from "./full-native-agent-audit.js";

export interface FullTurnToolResult {
  readonly content: readonly unknown[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
  readonly _meta?: unknown;
}

export interface FullTurnToolRequest extends BridgeToolCall {
  readonly callId: string;
}

interface Invocation {
  request: FullTurnToolRequest;
  subagentSpawnCount: number;
  readonly deferredSpawnCount?: number;
  readonly nativeCellId?: string;
  readonly nativeRuntime?: {
    readonly input: string;
    readonly nonce: string;
    policy?: NativeAgentAuditPolicy;
    audit?: NativeAgentAudit;
    uncertain?: boolean;
    replayKey?: string;
  };
  readonly resolve: (result: FullTurnToolResult) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

interface BatchWaiter {
  readonly resolve: (requests: readonly FullTurnToolRequest[]) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

interface ReplayableInvocation {
  readonly promise: Promise<FullTurnToolResult>;
}

interface TurnChannel {
  readonly key: string;
  readonly token: string;
  tools: readonly BridgeToolDefinition[];
  readonly toolsHash: string;
  readonly parallelToolCalls: boolean;
  readonly subagentLimit?: number;
  readonly invocations: Map<string, Invocation>;
  readonly completedResults: Map<string, string>;
  readonly queued: string[];
  readonly delivered: Set<string>;
  readonly replayableInvocations: Map<string, ReplayableInvocation>;
  readonly waiters: Set<BatchWaiter>;
  readonly expiresAt: number;
  completionCommitted: boolean;
  invocationCount: number;
  subagentSpawnCount: number;
  subagentReplacementCredits: number;
  subagentRejectedSpawns: number;
  uncertainSubagentSpawns: number;
  nativeRuntimeLease?: string;
  readonly ownedAgentIds: Set<string>;
  readonly completedAgentIds: Set<string>;
  readonly nativeCells: Map<
    string,
    {
      readonly runtime: NonNullable<Invocation["nativeRuntime"]>;
      readonly sourceCallId: string;
    }
  >;
  readonly creditedSubagentFailures: Set<string>;
  batchTimer?: NodeJS.Timeout;
  checkpoint?: FullCheckpoint;
  contextStaging?: boolean;
}

const MAX_CALLS_PER_BATCH = 8;
const DEFAULT_TTL_MS = BRIDGE_FULL_TURN_TIMEOUT_MS;
const BATCH_WINDOW_MS = 20;
const MAX_REPLACEMENTS_PER_SUBAGENT = 2;

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function toolsHash(tools: readonly BridgeToolDefinition[]): string {
  return createHash("sha256").update(JSON.stringify(tools)).digest("hex");
}

/** Only a delivered native tool search can extend its own turn's capabilities. */
function discoveredTools(
  channel: TurnChannel,
  request: FullTurnToolRequest,
  result: FullTurnToolResult,
): readonly BridgeToolDefinition[] {
  if (request.kind !== "tool_search" || result.isError) return channel.tools;
  const discovery = resultRecord(result.structuredContent);
  if (
    !discovery ||
    !Array.isArray(discovery.tools) ||
    (discovery.status !== undefined && discovery.status !== "completed")
  )
    return channel.tools;
  const tools = new Map(channel.tools.map((tool) => [tool.wireName, tool]));
  for (const tool of normalizeResponsesTools(discovery.tools)) {
    const previous = tools.get(tool.wireName);
    if (previous && canonicalJson(previous) !== canonicalJson(tool))
      throw new Error(
        `Native tool discovery cannot replace an active tool definition: ${tool.wireName}`,
      );
    tools.set(tool.wireName, tool);
  }
  if (tools.size > 4096)
    throw new Error("Native tool discovery exceeded the turn's tool limit.");
  return [...tools.values()];
}

function token(): string {
  return `turn_${randomBytes(32).toString("base64url")}`;
}

function abortError(): DOMException {
  return new DOMException("Full MCP request was cancelled.", "AbortError");
}

function matchingCallStarts(source: string, name: string): number[] {
  const pattern = new RegExp(String.raw`\btools\s*\.\s*${name}\s*\(`, "gu");
  const matches = [...source.matchAll(pattern)];
  const candidates = new Set(matches.map((match) => match.index));
  const executable = new Set<number>();
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false,
    lineComment = false,
    blockComment = false;
  for (let index = 0; index <= (matches.at(-1)?.index ?? -1); index++) {
    const character = source[index],
      next = source[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index++;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (candidates.has(index)) executable.add(index);
  }
  return matches
    .filter((match) => executable.has(match.index))
    .map((match) => match.index + match[0].lastIndexOf("("));
}

function callArgument(
  source: string,
  openingParenthesis: number,
): string | undefined {
  let depth = 0;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openingParenthesis; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character !== ")") continue;
    depth -= 1;
    if (depth === 0) return source.slice(openingParenthesis + 1, index);
  }
  return undefined;
}

function compactCode(value: string): string {
  let compact = "";
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      compact += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      compact += character;
      continue;
    }
    if (!/\s/u.test(character)) compact += character;
  }
  return compact;
}

function replayableSubagentKey(call: BridgeToolCall): string | undefined {
  if (call.kind !== "custom" || typeof call.input !== "string")
    return undefined;
  const spawnStarts = NATIVE_AGENT_SPAWN_NAMES.flatMap((name) =>
    matchingCallStarts(call.input!, name),
  );
  if (
    spawnStarts.length !== 1 ||
    !NATIVE_AGENT_WAIT_NAMES.some(
      (name) => matchingCallStarts(call.input!, name).length > 0,
    )
  ) {
    return undefined;
  }
  const spawnArgument = callArgument(call.input, spawnStarts[0]!);
  if (spawnArgument === undefined) return undefined;
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        wireName: call.wireName,
        spawnArgument: compactCode(spawnArgument),
      }),
    )
    .digest("hex");
}

function subagentSpawnCalls(call: BridgeToolCall): number {
  if (isNativeAgentSpawn(call.wireName)) return 1;
  if (call.kind !== "custom" || typeof call.input !== "string") return 0;
  return NATIVE_AGENT_SPAWN_NAMES.reduce(
    (count, name) => count + matchingCallStarts(call.input!, name).length,
    0,
  );
}

function terminalSubagentFailureKeys(
  invocation: Pick<Invocation, "request" | "subagentSpawnCount">,
  result: FullTurnToolResult,
  ownedAgentIds?: ReadonlySet<string>,
): readonly string[] {
  const input =
    invocation.request.kind === "custom"
      ? (invocation.request.input ?? "")
      : "";
  const related =
    invocation.subagentSpawnCount > 0 ||
    isNativeAgentSpawn(invocation.request.wireName) ||
    isNativeAgentWait(invocation.request.wireName) ||
    isNativeAgentStatus(invocation.request.wireName) ||
    NATIVE_AGENT_WAIT_NAMES.some(
      (name) => matchingCallStarts(input, name).length > 0,
    );
  if (!related) return [];
  const keys = new Set<string>();
  let completed = false;
  const inspectState = (state: unknown, id?: string): void => {
    const record = resultRecord(state);
    if (!record) return;
    if (
      record.completed !== undefined ||
      record.status === "completed" ||
      record.state === "completed"
    ) {
      completed = true;
      return;
    }
    if (
      (record.errored !== undefined && record.errored !== false) ||
      (record.failed !== undefined && record.failed !== false) ||
      record.status === "errored" ||
      record.status === "failed" ||
      record.state === "errored" ||
      record.state === "failed"
    )
      keys.add(
        id ??
          (typeof record.agent_id === "string"
            ? record.agent_id
            : `call:${invocation.request.callId}`),
      );
  };
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) inspect(entry);
      return;
    }
    const record = resultRecord(value);
    if (!record) return;
    if (typeof record.status === "string" || typeof record.state === "string")
      inspectState(record);
    for (const field of ["status", "agents_states", "agent_states"]) {
      const states = resultRecord(record[field]);
      if (states)
        for (const [id, state] of Object.entries(states))
          inspectState(state, id);
    }
    for (const [field, entry] of Object.entries(record)) {
      // Child prose is data, even when it mentions failed tests or rate limits.
      if (field === "completed" || field === "text" || field === "data")
        continue;
      if (entry && typeof entry === "object") inspect(entry);
    }
  };
  inspect(result.structuredContent);
  for (const block of result.content) {
    const text = resultRecord(block)?.text;
    if (typeof text !== "string") continue;
    try {
      inspect(JSON.parse(text));
    } catch {
      /* prose is not agent state */
    }
  }
  if (keys.size > 0)
    return [...keys].filter(
      (id) => invocation.subagentSpawnCount > 0 || ownedAgentIds?.has(id),
    );
  if (completed || !result.isError) return [];

  if (invocation.subagentSpawnCount === 0) return [];
  const count = Math.max(1, invocation.subagentSpawnCount);
  return Array.from(
    { length: count },
    (_, index) => `call:${invocation.request.callId}:${index}`,
  );
}

function subagentLimitResult(limit: number): FullTurnToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Bridge blocked this subagent spawn because the user requested exactly ${limit} successful subagent result${limit === 1 ? "" : "s"}. Extra attempts require an owned terminally failed child or a confirmed capacity rejection. Wait for pending children and use their completed results.`,
      },
    ],
  };
}

function duplicateSubagentResult(
  result: FullTurnToolResult,
): FullTurnToolResult {
  if (result.isError) return structuredClone(result);
  const running = runningNativeCell(result);
  return {
    ...structuredClone(result),
    content: [
      {
        type: "text",
        text:
          "Bridge blocked a duplicate subagent spawn in this Codex turn. " +
          (running
            ? `The identical native program is still running in cell ${running}. Wait for that owned cell; do not resubmit the program.`
            : "The identical spawn-and-wait workflow already completed. Use the cached result below and continue the parent task now; do not create another identical subagent."),
      },
      ...structuredClone(result.content),
    ],
  };
}

export class FullTurnBroker {
  readonly #channels = new Map<string, TurnChannel>();
  readonly #tokensByKey = new Map<string, string>();

  register(
    key: string,
    tools: readonly BridgeToolDefinition[],
    parallelToolCalls: boolean,
    options: {
      readonly ttlMs?: number;
      readonly subagentLimit?: number;
    } = {},
  ): string {
    this.#prune();
    const existingToken = this.#tokensByKey.get(key);
    const existing = existingToken
      ? this.#channels.get(existingToken)
      : undefined;
    const hash = toolsHash(tools);
    if (existing) {
      if (
        existing.toolsHash !== hash ||
        existing.parallelToolCalls !== parallelToolCalls ||
        existing.subagentLimit !== options.subagentLimit
      ) {
        throw new Error(
          "Codex tool definitions changed during an active Full MCP turn.",
        );
      }
      return existing.token;
    }
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("Full MCP turn TTL must be positive.");
    }
    if (
      options.subagentLimit !== undefined &&
      (!Number.isSafeInteger(options.subagentLimit) ||
        options.subagentLimit <= 0)
    ) {
      throw new Error("Full MCP subagent limit must be a positive integer.");
    }
    const turnToken = token();
    const channel: TurnChannel = {
      key,
      token: turnToken,
      tools: structuredClone(tools),
      toolsHash: hash,
      parallelToolCalls,
      ...(options.subagentLimit === undefined
        ? {}
        : { subagentLimit: options.subagentLimit }),
      invocations: new Map(),
      completedResults: new Map(),
      queued: [],
      delivered: new Set(),
      replayableInvocations: new Map(),
      waiters: new Set(),
      expiresAt: Date.now() + ttlMs,
      completionCommitted: false,
      invocationCount: 0,
      subagentSpawnCount: 0,
      subagentReplacementCredits: 0,
      subagentRejectedSpawns: 0,
      uncertainSubagentSpawns: 0,
      ownedAgentIds: new Set(),
      completedAgentIds: new Set(),
      nativeCells: new Map(),
      creditedSubagentFailures: new Set(),
    };
    this.#channels.set(turnToken, channel);
    this.#tokensByKey.set(key, turnToken);
    return turnToken;
  }

  status() {
    this.#prune();
    const channels = [...this.#channels.values()].filter(
      (channel) => !channel.completionCommitted,
    );
    return {
      activeTurns: channels.length,
      pendingTools: channels.reduce(
        (sum, channel) => sum + channel.invocations.size,
        0,
      ),
      ownedAgents: channels.reduce(
        (sum, channel) => sum + channel.ownedAgentIds.size,
        0,
      ),
      completedAgents: channels.reduce(
        (sum, channel) => sum + channel.completedAgentIds.size,
        0,
      ),
      failedAgents: channels.reduce(
        (sum, channel) => sum + channel.creditedSubagentFailures.size,
        0,
      ),
    };
  }

  inventory(
    turnToken: string,
    query = "",
    offset = 0,
    limit = 50,
  ): {
    readonly tools: readonly BridgeToolDefinition[];
    readonly total: number;
    readonly nextOffset: number | null;
  } {
    const channel = this.#channel(turnToken);
    const normalized = query.trim().toLocaleLowerCase();
    const matches = (
      channel.checkpoint
        ? [fullCheckpointTool]
        : channel.contextStaging
          ? []
          : channel.tools
    ).filter((tool) =>
      normalized.length === 0
        ? true
        : `${tool.wireName}\n${tool.description}`
            .toLocaleLowerCase()
            .includes(normalized),
    );
    const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    const size =
      Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50;
    const page = matches.slice(start, start + size);
    return {
      tools: page,
      total: matches.length,
      nextOffset:
        start + page.length < matches.length ? start + page.length : null,
    };
  }

  invoke(
    turnToken: string,
    wireName: string,
    payload: { readonly arguments?: unknown; readonly input?: unknown },
    signal?: AbortSignal,
    options: {
      readonly nativeExec?: boolean;
      readonly nativeCellId?: string;
    } = {},
  ): Promise<FullTurnToolResult> {
    const channel = this.#channel(turnToken);
    const staging = this.contextStagingInstruction(turnToken);
    if (staging) return Promise.resolve(staging);
    if (channel.checkpoint)
      return Promise.resolve(structuredClone(channel.checkpoint.instruction));
    const tool = channel.tools.find(
      (candidate) => candidate.wireName === wireName,
    );
    if (!tool)
      throw new Error(
        `Codex did not advertise tool ${wireName} for this turn.`,
      );
    let call: FullTurnToolRequest;
    if (tool.kind === "custom") {
      if (typeof payload.input !== "string") {
        throw new Error(`Custom Codex tool ${wireName} requires string input.`);
      }
      if (payload.arguments !== undefined) {
        throw new Error(
          `Custom Codex tool ${wireName} does not accept arguments.`,
        );
      }
      call = {
        callId: `call_${randomUUID().replaceAll("-", "")}`,
        kind: tool.kind,
        wireName: tool.wireName,
        name: tool.name,
        ...(tool.namespace ? { namespace: tool.namespace } : {}),
        arguments: { input: payload.input },
        input: payload.input,
      };
    } else {
      if (payload.input !== undefined) {
        throw new Error(
          `Codex tool ${wireName} does not accept freeform input.`,
        );
      }
      const args =
        payload.arguments !== null &&
        typeof payload.arguments === "object" &&
        !Array.isArray(payload.arguments)
          ? (payload.arguments as Record<string, unknown>)
          : {};
      validateToolArguments(tool.wireName, tool.parameters, args);
      call = {
        callId: `call_${randomUUID().replaceAll("-", "")}`,
        kind: tool.kind,
        wireName: tool.wireName,
        name: tool.name,
        ...(tool.namespace ? { namespace: tool.namespace } : {}),
        arguments: args,
      };
    }

    if (options.nativeExec && (tool.kind !== "custom" || tool.name !== "exec"))
      throw new Error(
        "Native code audit requires the active freeform exec gateway.",
      );
    if (options.nativeCellId && !channel.nativeCells.has(options.nativeCellId))
      throw new Error(
        "The native execution cell does not belong to this Full turn.",
      );
    const runtime = options.nativeExec
      ? ({
          input: call.input!,
          nonce: randomBytes(24).toString("base64url"),
        } as NonNullable<Invocation["nativeRuntime"]>)
      : undefined;
    const replayKey = runtime
      ? channel.subagentLimit === undefined || channel.subagentLimit === 1
        ? createHash("sha256")
            .update(JSON.stringify([wireName, runtime.input]))
            .digest("hex")
        : undefined
      : replayableSubagentKey(call);
    const replay =
      replayKey === undefined
        ? undefined
        : channel.replayableInvocations.get(replayKey);
    if (runtime && replayKey) runtime.replayKey = replayKey;
    if (replay !== undefined) {
      return replay.promise.then(duplicateSubagentResult);
    }
    const desiredSpawns = runtime ? 0 : subagentSpawnCalls(call);
    const deferredSpawns =
      channel.nativeRuntimeLease && isNativeAgentSpawn(wireName)
        ? desiredSpawns
        : 0;
    const spawnCount = deferredSpawns ? 0 : desiredSpawns;
    if (
      spawnCount > 0 &&
      channel.subagentLimit !== undefined &&
      channel.subagentSpawnCount +
        channel.uncertainSubagentSpawns +
        spawnCount >
        channel.subagentLimit +
          channel.subagentReplacementCredits +
          channel.subagentRejectedSpawns
    ) {
      return Promise.resolve(subagentLimitResult(channel.subagentLimit));
    }
    if (
      channel.invocations.size >=
      (channel.parallelToolCalls ? MAX_CALLS_PER_BATCH : 1)
    ) {
      throw new Error(
        "The Full MCP turn already has its maximum pending tool calls.",
      );
    }

    if (signal?.aborted) return Promise.reject(abortError());
    const promise = new Promise<FullTurnToolResult>(
      (resolvePromise, rejectPromise) => {
        const invocation: Invocation = {
          request: call,
          subagentSpawnCount: spawnCount,
          ...(runtime ? { nativeRuntime: runtime } : {}),
          ...(deferredSpawns ? { deferredSpawnCount: deferredSpawns } : {}),
          ...(options.nativeCellId
            ? { nativeCellId: options.nativeCellId }
            : {}),
          resolve: resolvePromise,
          reject: rejectPromise,
          ...(signal ? { signal } : {}),
        };
        if (signal) {
          const onAbort = (): void => {
            this.#cancelInvocation(channel, call.callId, abortError());
          };
          Object.assign(invocation, { onAbort });
          signal.addEventListener("abort", onAbort, { once: true });
        }
        channel.invocations.set(call.callId, invocation);
        channel.invocationCount += 1;
        channel.subagentSpawnCount += spawnCount;
        channel.queued.push(call.callId);
        this.#scheduleBatch(channel);
      },
    );
    if (replayKey === undefined) return promise;
    const tracked = promise.then(
      (result) => {
        if (
          (runtime
            ? !runtime.uncertain &&
              runtime.audit?.finished &&
              (runtime.audit.spawns === 0 ||
                runtime.audit.spawns === runtime.audit.rejectedSpawns ||
                (runtime.audit?.failures.length ?? 0) > 0)
            : isNativeAgentCapacityRejection(wireName, result) ||
              terminalSubagentFailureKeys(
                {
                  request: call,
                  subagentSpawnCount: spawnCount,
                },
                result,
              ).length > 0) &&
          channel.replayableInvocations.get(replayKey)?.promise === tracked
        ) {
          channel.replayableInvocations.delete(replayKey);
        }
        return result;
      },
      (error: unknown) => {
        if (
          !runtime?.uncertain &&
          channel.replayableInvocations.get(replayKey)?.promise === tracked
        ) {
          channel.replayableInvocations.delete(replayKey);
        }
        throw error;
      },
    );
    channel.replayableInvocations.set(replayKey, { promise: tracked });
    return tracked;
  }

  nextBatch(
    turnToken: string,
    signal?: AbortSignal,
  ): Promise<readonly FullTurnToolRequest[]> {
    const channel = this.#channel(turnToken);
    const delivered = [...channel.delivered]
      .map((callId) => channel.invocations.get(callId)?.request)
      .filter(
        (request): request is FullTurnToolRequest => request !== undefined,
      );
    if (delivered.length > 0) return Promise.resolve(delivered);
    const queued = this.#takeQueued(channel);
    if (queued.length > 0) return Promise.resolve(queued);
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<readonly FullTurnToolRequest[]>(
      (resolvePromise, rejectPromise) => {
        const waiter: BatchWaiter = {
          resolve: resolvePromise,
          reject: rejectPromise,
          ...(signal ? { signal } : {}),
        };
        if (signal) {
          const onAbort = (): void => {
            channel.waiters.delete(waiter);
            rejectPromise(abortError());
          };
          Object.assign(waiter, { onAbort });
          signal.addEventListener("abort", onAbort, { once: true });
        }
        channel.waiters.add(waiter);
      },
    );
  }

  complete(
    turnToken: string,
    callId: string,
    result: FullTurnToolResult,
  ): void {
    const channel = this.#channel(turnToken, true);
    const invocation = channel.invocations.get(callId);
    const resultHash = createHash("sha256")
      .update(JSON.stringify(result))
      .digest("hex");
    if (!invocation) {
      const completedHash = channel.completedResults.get(callId);
      if (completedHash === resultHash) return;
      if (completedHash !== undefined) {
        throw new Error(
          `Full MCP tool call was completed with a different result: ${callId}`,
        );
      }
      throw new Error(`Full MCP tool call is not pending: ${callId}`);
    }
    if (!channel.delivered.has(callId)) {
      throw new Error(
        `Full MCP tool call was not delivered to Codex: ${callId}`,
      );
    }
    // Register discoveries before resolving the connector's waiting search call,
    // so its next inventory/call observes the same native tools Codex just loaded.
    // The original toolsHash remains the startup contract for reconnect checks.
    let deliveredResult = result;
    try {
      channel.tools = discoveredTools(channel, invocation.request, result);
    } catch (error) {
      deliveredResult = fullTurnError(error);
    }
    channel.delivered.delete(callId);
    channel.invocations.delete(callId);
    channel.completedResults.set(callId, resultHash);
    let runtimeFailures: readonly string[] | undefined;
    const cell = invocation.nativeCellId
      ? channel.nativeCells.get(invocation.nativeCellId)
      : undefined;
    const runtime = invocation.nativeRuntime ?? cell?.runtime;
    if (runtime?.policy) {
      const unwrapped = {
        ...fullTurnResultFromCodex("", result.content),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent }),
        ...(result._meta === undefined ? {} : { _meta: result._meta }),
      };
      const liveCell = runningNativeCell(unwrapped);
      const previous = runtime.audit;
      const consumed = consumeNativeAgentAudit(
        unwrapped,
        runtime.policy,
        previous,
      );
      deliveredResult = consumed.result;
      const stillRunning =
        liveCell &&
        (!invocation.nativeCellId || liveCell === invocation.nativeCellId);
      if (
        cell &&
        !consumed.audit &&
        stillRunning &&
        !unwrapped.isError &&
        !JSON.stringify(unwrapped.content).includes(
          "BRIDGE_NATIVE_AGENT_AUDIT_V1",
        )
      ) {
        deliveredResult = unwrapped;
        runtimeFailures = [];
      } else if (consumed.audit && (consumed.audit.finished || stillRunning)) {
        runtime.audit = consumed.audit;
        channel.subagentSpawnCount +=
          consumed.audit.spawns - (previous?.spawns ?? 0);
        channel.subagentRejectedSpawns +=
          consumed.audit.rejectedSpawns - (previous?.rejectedSpawns ?? 0);
        for (const id of consumed.audit.agentIds) channel.ownedAgentIds.add(id);
        for (const id of consumed.audit.pendingIds)
          channel.completedAgentIds.delete(id);
        for (const id of consumed.audit.completedIds)
          channel.completedAgentIds.add(id);
        runtimeFailures = consumed.audit.failures;
        if (!consumed.error) {
          const clean = consumed.result;
          deliveredResult = {
            ...fullTurnResultFromCodex("", clean.content),
            ...(clean.isError === undefined ? {} : { isError: clean.isError }),
            ...(clean.structuredContent === undefined
              ? {}
              : { structuredContent: clean.structuredContent }),
            ...(clean._meta === undefined ? {} : { _meta: clean._meta }),
          };
        }
        if (!consumed.audit.finished && liveCell) {
          const existing = channel.nativeCells.get(liveCell);
          if (existing && existing.runtime !== runtime)
            throw new Error("Native execution cell ownership changed.");
          channel.nativeCells.set(liveCell, {
            runtime,
            sourceCallId: cell?.sourceCallId ?? callId,
          });
        }
      } else {
        this.#uncertainNativeRuntime(channel, runtime);
        deliveredResult = consumed.audit
          ? fullTurnError(
              new Error(
                "Native program returned an unfinished receipt without its owned running cell. Do not repeat its uncertain effects.",
              ),
            )
          : consumed.result;
        runtimeFailures = [];
      }
      if (runtime.uncertain || runtime.audit?.finished) {
        for (const [id, owner] of channel.nativeCells)
          if (owner.runtime === runtime) channel.nativeCells.delete(id);
        if (channel.nativeRuntimeLease === (cell?.sourceCallId ?? callId))
          delete channel.nativeRuntimeLease;
      }
    } else if (
      isNativeAgentSpawn(invocation.request.wireName) ||
      isNativeAgentWait(invocation.request.wireName) ||
      isNativeAgentStatus(invocation.request.wireName)
    ) {
      const state = inspectNativeAgentResult(result);
      if (
        isNativeAgentCapacityRejection(invocation.request.wireName, result) &&
        channel.subagentRejectedSpawns <
          (channel.subagentLimit === undefined
            ? 4096
            : channel.subagentLimit * MAX_REPLACEMENTS_PER_SUBAGENT)
      )
        channel.subagentRejectedSpawns += 1;
      if (isNativeAgentSpawn(invocation.request.wireName) && !result.isError)
        for (const id of state.agentIds) channel.ownedAgentIds.add(id);
      for (const id of state.pendingIds)
        if (channel.ownedAgentIds.has(id)) channel.completedAgentIds.delete(id);
      if (!result.isError)
        for (const id of state.completedIds)
          if (channel.ownedAgentIds.has(id)) channel.completedAgentIds.add(id);
    } else if (isNativeAgentResume(invocation.request.wireName)) {
      const args = invocation.request.arguments;
      const id = args?.target ?? args?.id;
      for (const target of nativeAgentTargetIds(id, [...channel.ownedAgentIds]))
        channel.completedAgentIds.delete(target);
    }
    if (channel.subagentLimit !== undefined) {
      const maximumCredits =
        channel.subagentLimit * MAX_REPLACEMENTS_PER_SUBAGENT;
      for (const key of runtimeFailures ??
        (isNativeAgentSpawn(invocation.request.wireName) ||
        isNativeAgentWait(invocation.request.wireName) ||
        isNativeAgentStatus(invocation.request.wireName)
          ? inspectNativeAgentResult(result).failures.filter((id) =>
              channel.ownedAgentIds.has(id),
            )
          : terminalSubagentFailureKeys(
              invocation,
              result,
              channel.ownedAgentIds,
            ))) {
        if (channel.subagentReplacementCredits >= maximumCredits) break;
        if (channel.creditedSubagentFailures.has(key)) continue;
        channel.creditedSubagentFailures.add(key);
        channel.subagentReplacementCredits += 1;
      }
    }
    if (invocation.signal && invocation.onAbort) {
      invocation.signal.removeEventListener("abort", invocation.onAbort);
    }
    if (runtime?.replayKey && runtime.audit?.finished) {
      if (
        runtime.audit.spawns === 0 ||
        runtime.audit.spawns === runtime.audit.rejectedSpawns ||
        runtime.audit.failures.length > 0
      )
        channel.replayableInvocations.delete(runtime.replayKey);
      else
        channel.replayableInvocations.set(runtime.replayKey, {
          promise: Promise.resolve(structuredClone(deliveredResult)),
        });
    }
    invocation.resolve(
      channel.checkpoint
        ? {
            ...structuredClone(deliveredResult),
            content: [
              ...structuredClone(deliveredResult.content),
              ...structuredClone(channel.checkpoint.instruction.content),
            ],
          }
        : structuredClone(deliveredResult),
    );
    this.#scheduleBatch(channel);
  }

  outstanding(turnToken: string): readonly FullTurnToolRequest[] {
    const channel = this.#channel(turnToken, true);
    return [...channel.delivered].flatMap((id) => {
      const request = channel.invocations.get(id)?.request;
      return request ? [request] : [];
    });
  }

  beginCheckpoint(turnToken: string): Promise<string> {
    const channel = this.#channel(turnToken);
    if (channel.checkpoint) return channel.checkpoint.result;
    if (channel.nativeCells.size > 0)
      throw new Error(
        "Wait for the owned native code cell before starting read-only context compaction.",
      );
    const checkpoint = createFullCheckpoint();
    channel.checkpoint = checkpoint;
    if (channel.batchTimer) {
      clearTimeout(channel.batchTimer);
      delete channel.batchTimer;
    }
    // Undelivered actions have no effects. Delivered actions retain their real
    // Codex result; complete() appends the control instruction to that result.
    for (const id of channel.queued.splice(0)) {
      const invocation = channel.invocations.get(id);
      if (!invocation) continue;
      channel.invocations.delete(id);
      channel.subagentSpawnCount -= invocation.subagentSpawnCount;
      if (invocation.signal && invocation.onAbort)
        invocation.signal.removeEventListener("abort", invocation.onAbort);
      invocation.resolve(structuredClone(checkpoint.instruction));
    }
    return checkpoint.result;
  }

  beginContextStaging(turnToken: string): void {
    const channel = this.#channel(turnToken);
    if (
      channel.checkpoint ||
      channel.invocationCount ||
      channel.invocations.size ||
      channel.completionCommitted
    )
      throw new Error(
        "Full context staging cannot start after tool execution or checkpoint control.",
      );
    channel.contextStaging = true;
  }

  commitContextStaging(turnToken: string): void {
    const channel = this.#channel(turnToken);
    if (!channel.contextStaging)
      throw new Error("Full context commit has no staged owner.");
    channel.contextStaging = false;
  }

  contextStagingInstruction(turnToken: string): FullTurnToolResult | undefined {
    return this.#channel(turnToken).contextStaging
      ? {
          isError: true,
          content: [
            {
              type: "text",
              text: "Full context transport is still staging. No tools are available. Return only the exact acknowledgement from the current stage; wait for the final commit.",
            },
          ],
        }
      : undefined;
  }

  checkpointInstruction(turnToken: string): FullTurnToolResult | undefined {
    const checkpoint = this.#channel(turnToken).checkpoint;
    return checkpoint ? structuredClone(checkpoint.instruction) : undefined;
  }

  submitCheckpoint(
    turnToken: string,
    args: Record<string, unknown>,
  ): FullTurnToolResult {
    const checkpoint = this.#channel(turnToken).checkpoint;
    if (!checkpoint)
      throw new Error("This turn has no pending checkpoint control.");
    const summary = checkpointSummary(args, checkpoint);
    checkpoint.submitted = true;
    checkpoint.resolve(summary);
    return {
      content: [
        {
          type: "text",
          text: "Context checkpoint accepted. Finish this read-only response.",
        },
      ],
      structuredContent: { accepted: true },
    };
  }

  hasPending(turnToken: string): boolean {
    const channel = this.#channel(turnToken, true);
    return channel.invocations.size > 0;
  }

  isActive(turnToken: string): boolean {
    this.#prune();
    const channel = this.#channels.get(turnToken);
    return channel !== undefined && !channel.completionCommitted;
  }

  hasInvoked(turnToken: string): boolean {
    return this.#channel(turnToken, true).invocationCount > 0;
  }

  subagentSpawns(turnToken: string): number {
    return this.#channel(turnToken, true).subagentSpawnCount;
  }

  subagentsCreated(turnToken: string): number {
    return this.#channel(turnToken, true).ownedAgentIds.size;
  }

  subagentsCompleted(turnToken: string): number {
    return this.#channel(turnToken, true).completedAgentIds.size;
  }

  ownsNativeCell(turnToken: string, cellId: string): boolean {
    return this.#channel(turnToken).nativeCells.has(cellId);
  }

  hasRunningNativePrograms(turnToken: string): boolean {
    return this.#channel(turnToken, true).nativeCells.size > 0;
  }

  commitCompletion(turnToken: string): boolean {
    const channel = this.#channel(turnToken, true);
    if (channel.completionCommitted) return true;
    if (
      channel.invocations.size > 0 ||
      channel.queued.length > 0 ||
      channel.nativeCells.size > 0
    )
      return false;
    channel.completionCommitted = true;
    return true;
  }

  revoke(turnToken: string, reason = new Error("Full MCP turn ended.")): void {
    const channel = this.#channels.get(turnToken);
    if (!channel) return;
    this.#channels.delete(turnToken);
    if (this.#tokensByKey.get(channel.key) === turnToken) {
      this.#tokensByKey.delete(channel.key);
    }
    if (channel.batchTimer) clearTimeout(channel.batchTimer);
    channel.checkpoint?.reject(reason);
    for (const waiter of channel.waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(reason);
    }
    channel.waiters.clear();
    for (const invocation of channel.invocations.values()) {
      if (invocation.signal && invocation.onAbort) {
        invocation.signal.removeEventListener("abort", invocation.onAbort);
      }
      invocation.reject(reason);
    }
    channel.invocations.clear();
  }

  close(): void {
    for (const turnToken of [...this.#channels.keys()]) this.revoke(turnToken);
  }

  #channel(turnToken: string, allowCommitted = false): TurnChannel {
    this.#prune();
    const channel = this.#channels.get(turnToken);
    if (!channel) throw new Error("Full MCP turn token is invalid or expired.");
    if (!allowCommitted && channel.completionCommitted) {
      throw new Error("Full MCP turn has already completed.");
    }
    return channel;
  }

  #scheduleBatch(channel: TurnChannel): void {
    if (channel.batchTimer) return;
    channel.batchTimer = setTimeout(() => {
      delete channel.batchTimer;
      if (channel.waiters.size === 0) return;
      const requests = this.#takeQueued(channel);
      if (requests.length === 0) return;
      for (const waiter of channel.waiters) {
        channel.waiters.delete(waiter);
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        waiter.resolve(requests);
        break;
      }
    }, BATCH_WINDOW_MS);
    channel.batchTimer.unref?.();
  }

  #takeQueued(channel: TurnChannel): readonly FullTurnToolRequest[] {
    const requests: FullTurnToolRequest[] = [];
    for (const id of [...channel.queued]) {
      if (
        requests.length >= (channel.parallelToolCalls ? MAX_CALLS_PER_BATCH : 1)
      )
        break;
      const invocation = channel.invocations.get(id);
      if (!invocation) {
        channel.queued.splice(channel.queued.indexOf(id), 1);
        continue;
      }
      if (
        channel.nativeRuntimeLease &&
        (invocation.nativeRuntime || invocation.deferredSpawnCount)
      )
        continue;
      channel.queued.splice(channel.queued.indexOf(id), 1);
      if (invocation.deferredSpawnCount) {
        if (
          channel.subagentLimit !== undefined &&
          channel.subagentSpawnCount +
            channel.uncertainSubagentSpawns +
            invocation.deferredSpawnCount >
            channel.subagentLimit +
              channel.subagentReplacementCredits +
              channel.subagentRejectedSpawns
        ) {
          channel.invocations.delete(id);
          if (invocation.signal && invocation.onAbort)
            invocation.signal.removeEventListener("abort", invocation.onAbort);
          invocation.resolve(subagentLimitResult(channel.subagentLimit));
          continue;
        }
        invocation.subagentSpawnCount = invocation.deferredSpawnCount;
        channel.subagentSpawnCount += invocation.subagentSpawnCount;
      }
      const runtime = invocation.nativeRuntime;
      if (runtime) {
        const policy: NativeAgentAuditPolicy = {
          nonce: runtime.nonce,
          ...(channel.subagentLimit === undefined
            ? {}
            : {
                spawnAllowance: Math.max(
                  0,
                  channel.subagentLimit +
                    channel.subagentReplacementCredits +
                    channel.subagentRejectedSpawns -
                    channel.subagentSpawnCount -
                    channel.uncertainSubagentSpawns,
                ),
              }),
          replacementAllowance:
            channel.subagentLimit === undefined
              ? 4096
              : Math.max(
                  0,
                  channel.subagentLimit * MAX_REPLACEMENTS_PER_SUBAGENT -
                    channel.subagentReplacementCredits,
                ),
          rejectionAllowance:
            channel.subagentLimit === undefined
              ? Math.max(0, 4096 - channel.subagentRejectedSpawns)
              : Math.max(
                  0,
                  channel.subagentLimit * MAX_REPLACEMENTS_PER_SUBAGENT -
                    channel.subagentRejectedSpawns,
                ),
          knownFailures: [...channel.creditedSubagentFailures],
          ownedAgentIds: [...channel.ownedAgentIds],
        };
        runtime.policy = policy;
        const input = fullTransportExec(
          runtime.input,
          invocation.request.wireName,
          policy,
        );
        invocation.request = {
          ...invocation.request,
          input,
          arguments: { input },
        };
        if (channel.subagentLimit !== undefined)
          channel.nativeRuntimeLease = id;
      }
      requests.push(invocation.request);
    }
    for (const request of requests) channel.delivered.add(request.callId);
    return requests;
  }

  #cancelInvocation(channel: TurnChannel, callId: string, reason: Error): void {
    const invocation = channel.invocations.get(callId);
    if (!invocation) return;
    const wasDelivered = channel.delivered.has(callId);
    channel.invocations.delete(callId);
    channel.delivered.delete(callId);
    const queuedIndex = channel.queued.indexOf(callId);
    if (queuedIndex >= 0) channel.queued.splice(queuedIndex, 1);
    if (!wasDelivered) {
      channel.subagentSpawnCount -= invocation.subagentSpawnCount;
    } else if (invocation.nativeRuntime) {
      this.#uncertainNativeRuntime(channel, invocation.nativeRuntime);
    }
    if (channel.nativeRuntimeLease === callId)
      delete channel.nativeRuntimeLease;
    invocation.reject(reason);
    this.#scheduleBatch(channel);
  }

  #uncertainNativeRuntime(
    channel: TurnChannel,
    runtime: NonNullable<Invocation["nativeRuntime"]>,
  ): void {
    if (runtime.uncertain) return;
    runtime.uncertain = true;
    if (runtime.policy?.spawnAllowance !== undefined)
      channel.uncertainSubagentSpawns +=
        runtime.policy.spawnAllowance + runtime.policy.replacementAllowance;
  }

  #prune(): void {
    const now = Date.now();
    for (const [turnToken, channel] of this.#channels) {
      if (channel.expiresAt <= now) {
        this.revoke(turnToken, new Error("Full MCP turn token expired."));
      }
    }
  }
}

function resultRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Preserve native MCP blocks and convert Responses content parts to MCP media. */
function fullResultContent(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const content: unknown[] = [];
  for (const part of value) {
    const record = resultRecord(part);
    if (!record) return undefined;
    if (
      ["text", "input_text", "output_text"].includes(String(record.type)) &&
      typeof record.text === "string"
    ) {
      content.push({ ...structuredClone(record), type: "text" });
    } else if (
      (record.type === "image" || record.type === "audio") &&
      typeof record.data === "string" &&
      typeof record.mimeType === "string"
    ) {
      content.push(structuredClone(record));
    } else if (
      (record.type === "resource" && resultRecord(record.resource)) ||
      (record.type === "resource_link" &&
        typeof record.uri === "string" &&
        typeof record.name === "string")
    ) {
      content.push(structuredClone(record));
    } else if (
      (record.type === "input_image" || record.type === "output_image") &&
      typeof record.image_url === "string"
    ) {
      const image =
        /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(
          record.image_url,
        );
      if (!image) {
        // Never fetch a tool-supplied URL or insert data bytes as prompt text.
        content.push({
          type: "text",
          text: "The native tool returned an image reference that cannot be represented as MCP image bytes.",
        });
      } else {
        content.push({ type: "image", mimeType: image[1], data: image[2] });
      }
    } else return undefined;
  }
  return content;
}

export function fullTurnResultFromCodex(
  output: string,
  nativeOutput?: unknown,
): FullTurnToolResult {
  let native: unknown = nativeOutput;
  if (native === undefined || typeof native === "string") {
    try {
      native = JSON.parse(
        typeof native === "string" ? native : output,
      ) as unknown;
    } catch {
      native = undefined;
    }
  }
  const result = resultRecord(native);
  const content = fullResultContent(result ? result.content : native);
  if (!result && content?.length === 1) {
    const block = resultRecord(content[0]);
    if (block?.type === "text" && typeof block.text === "string") {
      let nested: Record<string, unknown> | undefined;
      try {
        nested = resultRecord(JSON.parse(block.text));
      } catch {
        /* ordinary text */
      }
      if (nested && fullResultContent(nested.content) !== undefined)
        return fullTurnResultFromCodex(block.text, nested);
    }
  }
  if (content !== undefined) {
    return {
      content,
      ...(result?.structuredContent === undefined
        ? {}
        : { structuredContent: structuredClone(result.structuredContent) }),
      ...(typeof result?.isError === "boolean"
        ? { isError: result.isError }
        : {}),
      ...(result?._meta === undefined
        ? {}
        : { _meta: structuredClone(result._meta) }),
    };
  }
  let structuredContent: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(output) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      structuredContent = parsed as Record<string, unknown>;
    }
  } catch {
    // Native text tool results remain text-only MCP content.
  }
  return {
    content: [{ type: "text", text: output }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

export function fullTurnError(value: unknown): FullTurnToolResult {
  const error = errorOf(value);
  return {
    isError: true,
    content: [{ type: "text", text: error.message }],
  };
}
