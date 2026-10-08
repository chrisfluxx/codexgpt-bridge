import type { FullTurnToolResult } from "./full-turn-broker.js";

export const NATIVE_AGENT_AUDIT_START = "BRIDGE_NATIVE_AGENT_AUDIT_V1\n";
export const NATIVE_AGENT_AUDIT_END = "\nBRIDGE_NATIVE_AGENT_AUDIT_END";

export interface NativeAgentAuditPolicy {
  readonly nonce: string;
  readonly spawnAllowance?: number;
  readonly replacementAllowance: number;
  readonly rejectionAllowance: number;
  readonly knownFailures: readonly string[];
  readonly ownedAgentIds: readonly string[];
}

export interface NativeAgentAudit {
  readonly version: 1;
  readonly nonce: string;
  readonly spawns: number;
  readonly rejectedSpawns: number;
  readonly finished: boolean;
  readonly agentIds: readonly string[];
  readonly failures: readonly string[];
  readonly completedIds: readonly string[];
  readonly pendingIds: readonly string[];
}

/** The observed V1/V2 capacity response confirms that no child was created. */
export function isNativeAgentCapacityRejection(
  name: string,
  value: unknown,
): boolean {
  const nativeNames = [
    "multi_agent_v1__spawn_agent",
    "collaboration__spawn_agent",
  ];
  if (
    !nativeNames.some(
      (nativeName) => name === nativeName || name.endsWith("__" + nativeName),
    )
  )
    return false;
  const message = "collab spawn failed: agent thread limit reached";
  if (typeof value === "string") return value === message;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (
    result.structuredContent !== undefined ||
    "agent_id" in result ||
    "task_name" in result ||
    !Array.isArray(result.content) ||
    result.content.length !== 1
  )
    return false;
  const block = result.content[0] as Record<string, unknown> | null;
  return (
    !!block &&
    typeof block === "object" &&
    block.type === "text" &&
    block.text === message
  );
}

/** Standalone so the same observer can be injected into the native JS runtime. */
export function inspectNativeAgentResult(value: unknown): {
  agentIds: string[];
  failures: string[];
  completedIds: string[];
  pendingIds: string[];
} {
  const agentIds = new Set<string>();
  const failures = new Set<string>();
  const completedIds = new Set<string>();
  const pendingIds = new Set<string>();
  const record = (input: unknown): Record<string, unknown> | undefined =>
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const state = (input: unknown, id?: string): void => {
    const item = record(input);
    const identity =
      id ??
      (typeof item?.agent_id === "string"
        ? item.agent_id
        : typeof item?.task_name === "string"
          ? item.task_name
          : typeof item?.agent_name === "string"
            ? item.agent_name
            : undefined);
    if (identity && identity.length > 0 && identity.length <= 1000) {
      const completed =
        input === "completed" ||
        (item &&
          (typeof item.completed === "string" ||
            item.completed === null ||
            item.status === "completed" ||
            item.state === "completed"));
      if (completed) {
        completedIds.add(identity);
        pendingIds.delete(identity);
      } else if (typeof input === "string" || item) {
        pendingIds.add(identity);
        completedIds.delete(identity);
      }
    }
    if (!item) return;
    if (typeof item.agent_id === "string" && item.agent_id.length <= 1000)
      agentIds.add(item.agent_id);
    if (typeof item.task_name === "string" && item.task_name.length <= 1000)
      agentIds.add(item.task_name);
    if (
      typeof item.completed === "string" ||
      item.completed === null ||
      item.status === "completed" ||
      item.state === "completed"
    )
      return;
    if (
      identity &&
      identity.length <= 1000 &&
      ((item.errored !== undefined && item.errored !== false) ||
        (item.failed !== undefined && item.failed !== false) ||
        item.status === "errored" ||
        item.status === "failed" ||
        item.state === "errored" ||
        item.state === "failed")
    )
      failures.add(identity);
  };
  const inspect = (input: unknown, depth: number): void => {
    if (depth > 8) return;
    const item = record(input);
    if (!item) return;
    state(item);
    for (const field of ["status", "agents_states", "agent_states"]) {
      const states = record(item[field]);
      if (states)
        for (const [id, entry] of Object.entries(states).slice(0, 4096))
          state(entry, id);
    }
    if (Array.isArray(item.agents)) {
      for (const entry of item.agents.slice(0, 4096)) {
        const agent = record(entry);
        if (agent && typeof agent.agent_name === "string")
          state(agent.agent_status, agent.agent_name);
      }
    }
    if (item.structuredContent !== undefined)
      inspect(item.structuredContent, depth + 1);
    if (Array.isArray(item.content)) {
      for (const block of item.content.slice(0, 4096)) {
        const text = record(block)?.text;
        if (typeof text !== "string" || text.length > 1024 * 1024) continue;
        try {
          inspect(JSON.parse(text), depth + 1);
        } catch {
          /* child prose is data */
        }
      }
    }
  };
  if (typeof value === "string" && value.length <= 1024 * 1024) {
    try {
      inspect(JSON.parse(value), 0);
    } catch {
      /* plain text */
    }
  } else inspect(value, 0);
  return {
    agentIds: [...agentIds],
    failures: [...failures],
    completedIds: [...completedIds],
    pendingIds: [...pendingIds],
  };
}

/** Native V2 also accepts a relative task name for a previously spawned child. */
export function nativeAgentTargetIds(
  target: unknown,
  ownedIds: readonly string[],
): string[] {
  if (typeof target !== "string" || target.length === 0 || target.length > 1000)
    return [];
  return ownedIds.filter(
    (id) =>
      id === target || (!target.startsWith("/") && id.endsWith("/" + target)),
  );
}

/** Consume a call-bound receipt without exposing it in the connector's tool result. */
export function consumeNativeAgentAudit(
  result: FullTurnToolResult,
  policy: NativeAgentAuditPolicy,
  previous?: NativeAgentAudit,
): { result: FullTurnToolResult; audit?: NativeAgentAudit; error?: string } {
  const receipts: unknown[] = [];
  let malformed = false;
  const content = result.content.flatMap((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block))
      return [block];
    const item = block as Record<string, unknown>;
    if (
      typeof item.text !== "string" ||
      !item.text.includes(NATIVE_AGENT_AUDIT_START)
    )
      return [block];
    let rest = item.text;
    let visible = "";
    while (rest.includes(NATIVE_AGENT_AUDIT_START)) {
      const start = rest.indexOf(NATIVE_AGENT_AUDIT_START);
      visible += rest.slice(0, start);
      const end = rest.indexOf(
        NATIVE_AGENT_AUDIT_END,
        start + NATIVE_AGENT_AUDIT_START.length,
      );
      if (end < 0 || end - start > 1024 * 1024) {
        malformed = true;
        rest = "";
        break;
      }
      try {
        receipts.push(
          JSON.parse(rest.slice(start + NATIVE_AGENT_AUDIT_START.length, end)),
        );
      } catch {
        malformed = true;
      }
      rest = rest.slice(end + NATIVE_AGENT_AUDIT_END.length);
    }
    visible += rest;
    return visible.trim().length ? [{ ...item, text: visible }] : [];
  });
  const clean: FullTurnToolResult = { ...result, content };
  const fail = (): { result: FullTurnToolResult; error: string } => ({
    result: {
      ...clean,
      isError: true,
      content: [
        ...content,
        {
          type: "text",
          text: "Native code execution did not return a valid call-bound agent receipt. Its effects are uncertain; do not repeat this program or infer that an agent completed.",
        },
      ],
    },
    error: "Native agent execution receipt is missing or invalid.",
  });
  if (malformed || receipts.length < 1 || receipts.length > 16384)
    return fail();
  const strings = (input: unknown): input is string[] =>
    Array.isArray(input) &&
    input.length <= 4096 &&
    input.every(
      (entry) =>
        typeof entry === "string" && entry.length > 0 && entry.length <= 1000,
    ) &&
    new Set(input).size === input.length;
  let latest = previous;
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
      return fail();
    const audit = receipt as NativeAgentAudit;
    if (
      audit.version !== 1 ||
      audit.nonce !== policy.nonce ||
      !Number.isSafeInteger(audit.spawns) ||
      audit.spawns < 0 ||
      !Number.isSafeInteger(audit.rejectedSpawns) ||
      audit.rejectedSpawns < 0 ||
      audit.rejectedSpawns > policy.rejectionAllowance ||
      typeof audit.finished !== "boolean" ||
      !strings(audit.agentIds) ||
      !strings(audit.failures) ||
      !strings(audit.completedIds) ||
      !strings(audit.pendingIds) ||
      audit.agentIds.length > audit.spawns - audit.rejectedSpawns ||
      audit.failures.length > policy.replacementAllowance ||
      (policy.spawnAllowance !== undefined &&
        audit.spawns >
          policy.spawnAllowance + audit.failures.length + audit.rejectedSpawns)
    )
      return fail();
    const owned = new Set([...policy.ownedAgentIds, ...audit.agentIds]);
    if (
      audit.failures.some(
        (id) => !owned.has(id) || policy.knownFailures.includes(id),
      ) ||
      audit.completedIds.some(
        (id) => !owned.has(id) || audit.pendingIds.includes(id),
      ) ||
      audit.pendingIds.some((id) => !owned.has(id))
    )
      return fail();
    if (
      latest &&
      (latest.finished ||
        audit.spawns < latest.spawns ||
        audit.rejectedSpawns < latest.rejectedSpawns ||
        latest.agentIds.some((id) => !audit.agentIds.includes(id)) ||
        latest.failures.some((id) => !audit.failures.includes(id)) ||
        latest.completedIds.some(
          (id) =>
            !audit.completedIds.includes(id) && !audit.pendingIds.includes(id),
        ) ||
        latest.pendingIds.some(
          (id) =>
            !audit.pendingIds.includes(id) && !audit.completedIds.includes(id),
        ))
    )
      return fail();
    latest = audit;
  }
  return { result: clean, audit: latest! };
}

export function runningNativeCell(
  result: FullTurnToolResult,
): string | undefined {
  const ids = result.content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const text = (block as Record<string, unknown>).text;
    return typeof text === "string"
      ? [
          ...text.matchAll(
            /\bScript running with cell ID ([A-Za-z0-9_-]{1,100})\b/gu,
          ),
        ].map((match) => match[1]!)
      : [];
  });
  return ids.length === 1 ? ids[0] : undefined;
}
