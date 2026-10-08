import {
  inspectNativeAgentResult,
  isNativeAgentCapacityRejection,
  nativeAgentTargetIds,
  NATIVE_AGENT_AUDIT_START,
  NATIVE_AGENT_AUDIT_END,
  type NativeAgentAuditPolicy,
} from "./full-native-agent-audit.js";

/** Keep agent waits shorter than the shared connector's invocation deadline. */
export const FULL_AGENT_WAIT_POLL_MS = 30_000;
export const NATIVE_AGENT_FAMILIES = [
  "multi_agent_v1",
  "multi_agent_v2",
  "collaboration",
] as const;

export const NATIVE_AGENT_SPAWN_NAMES = NATIVE_AGENT_FAMILIES.map(
  (family) => `${family}__spawn_agent`,
);
export const NATIVE_AGENT_WAIT_NAMES = NATIVE_AGENT_FAMILIES.map(
  (family) => `${family}__wait_agent`,
);

export const NATIVE_AGENT_STATUS_NAMES = NATIVE_AGENT_FAMILIES.map(
  (family) => `${family}__list_agents`,
);

export function isNativeAgentStatus(name: string): boolean {
  return NATIVE_AGENT_STATUS_NAMES.some(
    (candidate) => name === candidate || name.endsWith(`__${candidate}`),
  );
}

export const NATIVE_AGENT_RESUME_NAMES = NATIVE_AGENT_FAMILIES.flatMap(
  (family) =>
    ["send_input", "followup_task", "resume_agent"].map(
      (action) => `${family}__${action}`,
    ),
);

export function isNativeAgentResume(name: string): boolean {
  return NATIVE_AGENT_RESUME_NAMES.some(
    (candidate) => name === candidate || name.endsWith(`__${candidate}`),
  );
}

export function isNativeAgentSpawn(name: string): boolean {
  return NATIVE_AGENT_SPAWN_NAMES.some(
    (candidate) => name === candidate || name.endsWith(`__${candidate}`),
  );
}

export function isNativeAgentWait(name: string): boolean {
  return NATIVE_AGENT_WAIT_NAMES.some(
    (candidate) => name === candidate || name.endsWith(`__${candidate}`),
  );
}

export function assertFullAgentWait(name: string, args: unknown): void {
  if (!isNativeAgentWait(name)) return;
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    (args as Record<string, unknown>).timeout_ms !== FULL_AGENT_WAIT_POLL_MS
  )
    throw new Error(
      `Full agent waits require timeout_ms=${FULL_AGENT_WAIT_POLL_MS}. A timed-out wait is not completion; poll again so child agents can use the shared connector.`,
    );
}

/** Validate at dispatch, including bracket access and aliases inside freeform code. */
export function fullTransportExec(
  input: string,
  gatewayName: string,
  audit?: NativeAgentAuditPolicy,
): string {
  if (audit)
    return nativeExecPragma(input) + auditedExec(input, gatewayName, audit);
  return (
    nativeExecPragma(input) +
    [
      "await (async (tools) => {",
      input,
      "})(new Proxy(Object.create(null), (() => {",
      "  const native = tools;",
      `  const waits = ${JSON.stringify(NATIVE_AGENT_WAIT_NAMES)};`,
      `  const gateway = ${JSON.stringify(gatewayName)};`,
      "  const wrappers = new Map();",
      "  const lookup = name => {",
      "    if (wrappers.has(name)) return wrappers.get(name);",
      "    const original = Reflect.get(native, name);",
      "    if (typeof original !== 'function') return original;",
      "    const wrapped = (...args) => {",
      "      if (name === gateway || name === 'exec') throw new Error('Recursive native exec is unavailable in Full code mode');",
      "      if (typeof name === 'string' && waits.some(wait => name === wait || name.endsWith('__' + wait))) {",
      "        const payload = args[0];",
      `        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.timeout_ms !== ${FULL_AGENT_WAIT_POLL_MS}) throw new Error('Full agent waits require timeout_ms=${FULL_AGENT_WAIT_POLL_MS}; a timed-out wait is not task completion');`,
      "      }",
      "      return Reflect.apply(original, native, args);",
      "    };",
      "    wrappers.set(name, wrapped);",
      "    return wrapped;",
      "  };",
      "  const names = () => [...new Set([...Reflect.ownKeys(native), ...(typeof ALL_TOOLS !== 'undefined' && Array.isArray(ALL_TOOLS) ? ALL_TOOLS.map(tool => tool.name) : [])])];",
      "  return {",
      "    get: (_target, name) => lookup(name),",
      "    ownKeys: names,",
      "    has: (_target, name) => names().includes(name),",
      "    getOwnPropertyDescriptor: (_target, name) => names().includes(name) ? { configurable: true, enumerable: true, value: lookup(name) } : undefined,",
      "    set: () => false, defineProperty: () => false, deleteProperty: () => false,",
      "  };",
      "})()));",
    ].join("\n")
  );
}

function nativeExecPragma(input: string): string {
  const match = /^[\t ]*\/\/ @exec:[^\r\n]*(?:\r?\n|$)/u.exec(input);
  return match ? match[0].trimEnd() + "\n" : "";
}

/** A dispatch contract for native code, not a JavaScript security sandbox. */
function auditedExec(
  input: string,
  gatewayName: string,
  policy: NativeAgentAuditPolicy,
): string {
  return [
    "await (async (native, emit, run) => {",
    `  const policy = ${JSON.stringify(policy)};`,
    `  const spawns = ${JSON.stringify(NATIVE_AGENT_SPAWN_NAMES)};`,
    `  const waits = ${JSON.stringify(NATIVE_AGENT_WAIT_NAMES)};`,
    `  const resumes = ${JSON.stringify(NATIVE_AGENT_RESUME_NAMES)};`,
    `  const statuses = ${JSON.stringify(NATIVE_AGENT_STATUS_NAMES)};`,
    `  const gateway = ${JSON.stringify(gatewayName)};`,
    `  const inspect = ${inspectNativeAgentResult.toString()};`,
    `  const isRejection = ${isNativeAgentCapacityRejection.toString()};`,
    `  const targets = ${nativeAgentTargetIds.toString()};`,
    "  let spawnCount = 0, rejectedSpawns = 0, finished = false;",
    "  const failures = new Set(), ids = new Set(), known = new Set(policy.ownedAgentIds);",
    "  const completed = new Set(), pendingIds = new Set();",
    "  const credited = new Set(policy.knownFailures), wrappers = new Map(), pending = new Set();",
    `  const snapshot = done => emit(${JSON.stringify(NATIVE_AGENT_AUDIT_START)} + JSON.stringify({ version: 1, nonce: policy.nonce, spawns: spawnCount, rejectedSpawns, finished: done, agentIds: [...ids], failures: [...failures], completedIds: [...completed], pendingIds: [...pendingIds] }) + ${JSON.stringify(NATIVE_AGENT_AUDIT_END)});`,
    "  const matches = (name, names) => typeof name === 'string' && names.some(item => name === item || name.endsWith('__' + item));",
    "  const observe = (result, spawn, name) => {",
    "    const state = inspect(result);",
    "    if (spawn && rejectedSpawns < policy.rejectionAllowance && isRejection(name, result)) rejectedSpawns++;",
    "    if (spawn && result?.isError !== true) for (const id of state.agentIds) { ids.add(id); known.add(id); }",
    "    for (const id of state.pendingIds) if (known.has(id)) { pendingIds.add(id); completed.delete(id); }",
    "    if (result?.isError !== true) for (const id of state.completedIds) if (known.has(id)) { completed.add(id); pendingIds.delete(id); }",
    "    for (const id of state.failures) if (known.has(id) && !credited.has(id) && failures.size < policy.replacementAllowance) { credited.add(id); failures.add(id); }",
    "    snapshot(false);",
    "  };",
    "  const lookup = name => {",
    "    if (wrappers.has(name)) return wrappers.get(name);",
    "    const original = Reflect.get(native, name);",
    "    if (typeof original !== 'function') return original;",
    "    const wrapped = (...args) => {",
    "      if (finished) throw new Error('Full native program already finished');",
    "      if (name === gateway || name === 'exec') throw new Error('Recursive native exec is unavailable in Full code mode');",
    "      const spawn = matches(name, spawns), wait = matches(name, waits);",
    "      if (matches(name, resumes)) { for (const id of targets(args[0]?.target ?? args[0]?.id, [...known])) { pendingIds.add(id); completed.delete(id); } snapshot(false); }",
    `      if (wait && (!args[0] || typeof args[0] !== 'object' || Array.isArray(args[0]) || args[0].timeout_ms !== ${FULL_AGENT_WAIT_POLL_MS})) throw new Error('Full agent waits require timeout_ms=${FULL_AGENT_WAIT_POLL_MS}; a timed-out wait is not task completion');`,
    "      if (spawn && policy.spawnAllowance !== undefined && spawnCount >= policy.spawnAllowance + failures.size + rejectedSpawns) throw new Error('Bridge blocked this subagent spawn: the requested successful count is already reserved; replacements require an owned terminally failed child or a confirmed capacity rejection');",
    "      if (spawn) { spawnCount++; snapshot(false); }",
    "      let promise;",
    "      promise = Promise.resolve().then(() => Reflect.apply(original, native, args)).then(result => { if (spawn || wait || matches(name, statuses)) observe(result, spawn, name); return result; }, error => { if (spawn && isRejection(name, error)) observe(error, spawn, name); throw error; }).finally(() => pending.delete(promise));",
    "      pending.add(promise);",
    "      return promise;",
    "    };",
    "    wrappers.set(name, wrapped); return wrapped;",
    "  };",
    "  const names = () => [...new Set([...Reflect.ownKeys(native), ...(typeof ALL_TOOLS !== 'undefined' && Array.isArray(ALL_TOOLS) ? ALL_TOOLS.map(tool => tool.name) : [])])];",
    "  const proxy = new Proxy(Object.create(null), {",
    "    get: (_target, name) => lookup(name), ownKeys: names, has: (_target, name) => names().includes(name),",
    "    getOwnPropertyDescriptor: (_target, name) => names().includes(name) ? { configurable: true, enumerable: true, value: lookup(name) } : undefined,",
    "    set: () => false, defineProperty: () => false, deleteProperty: () => false, setPrototypeOf: () => false, getPrototypeOf: () => null,",
    "  });",
    "  snapshot(false);",
    "  try { return await run(proxy); } finally {",
    "    finished = true;",
    "    await Promise.allSettled([...pending]);",
    "    snapshot(true);",
    "  }",
    "})(tools, text, async (tools) => {",
    input,
    "});",
  ].join("\n");
}
