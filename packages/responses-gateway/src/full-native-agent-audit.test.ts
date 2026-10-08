import assert from "node:assert/strict";
import { it } from "node:test";
import { Script } from "node:vm";
import {
  FullTurnBroker,
  fullTurnResultFromCodex,
  type FullTurnToolRequest,
} from "./full-turn-broker.js";
import { FullNativeRegistry } from "./full-native-registry.js";
import { NATIVE_AGENT_FAMILIES } from "./full-native-transport.js";
import {
  consumeNativeAgentAudit,
  inspectNativeAgentResult,
  isNativeAgentCapacityRejection,
  NATIVE_AGENT_AUDIT_START,
  NATIVE_AGENT_AUDIT_END,
  type NativeAgentAudit,
} from "./full-native-agent-audit.js";

const gateway = {
  kind: "custom" as const,
  wireName: "functions__exec",
  name: "exec",
  description: "Native code",
  parameters: {},
};
type NativeTools = Record<string, (args: Record<string, unknown>) => unknown>;

const capacityMessage = "collab spawn failed: agent thread limit reached";
const capacityResult = {
  content: [{ type: "text", text: capacityMessage }],
};

it("recognizes only the observed native V1/V2 capacity rejection, without inferring effects from prose or generic errors", () => {
  const name = "collaboration__spawn_agent";
  assert.equal(isNativeAgentCapacityRejection(name, capacityMessage), true);
  assert.equal(isNativeAgentCapacityRejection(name, capacityResult), true);
  assert.equal(
    isNativeAgentCapacityRejection(
      "multi_agent_v1__spawn_agent",
      capacityMessage,
    ),
    true,
  );
  assert.equal(
    isNativeAgentCapacityRejection(
      "multi_agent_v1__spawn_agent",
      capacityResult,
    ),
    true,
  );
  for (const result of [
    "Other error: " + capacityMessage,
    {
      isError: true,
      content: [{ type: "text", text: "Network disconnected" }],
    },
    { ...capacityResult, structuredContent: { task_name: "/root/created" } },
    { ...capacityResult, agent_id: "created" },
    {
      content: [...capacityResult.content, { type: "text", text: "More data" }],
    },
    {
      content: [
        { type: "text", text: JSON.stringify({ message: capacityMessage }) },
      ],
    },
  ])
    assert.equal(isNativeAgentCapacityRejection(name, result), false);
  for (const name of [
    "read_file",
    "collaboration__wait_agent",
    "multi_agent_v2__spawn_agent",
  ])
    assert.equal(isNativeAgentCapacityRejection(name, capacityResult), false);
});

it("bounds capacity rejection receipts and rejects counter rollback or a rejected attempt claiming a child", () => {
  const policy = {
    nonce: "call-bound",
    spawnAllowance: 1,
    replacementAllowance: 2,
    rejectionAllowance: 2,
    knownFailures: [],
    ownedAgentIds: [],
  };
  const audit: NativeAgentAudit = {
    version: 1,
    nonce: policy.nonce,
    spawns: 1,
    rejectedSpawns: 1,
    finished: false,
    agentIds: [],
    failures: [],
    completedIds: [],
    pendingIds: [],
  };
  const result = (value: NativeAgentAudit) => ({
    content: [
      {
        type: "text",
        text:
          NATIVE_AGENT_AUDIT_START +
          JSON.stringify(value) +
          NATIVE_AGENT_AUDIT_END,
      },
    ],
  });
  assert.equal(consumeNativeAgentAudit(result(audit), policy).error, undefined);
  for (const invalid of [
    { ...audit, rejectedSpawns: -1 },
    { ...audit, rejectedSpawns: 0.5 },
    { ...audit, spawns: 3, rejectedSpawns: 3 },
    { ...audit, agentIds: ["/root/created"] },
    { ...audit, rejectedSpawns: 0 },
  ])
    assert.ok(consumeNativeAgentAudit(result(invalid), policy, audit).error);
});

it("a direct capacity rejection can be retried explicitly, while duplicate result delivery does not grant another allowance", async () => {
  const broker = new FullTurnBroker();
  const native = new FullNativeRegistry(broker);
  const name = "collaboration__spawn_agent";
  const token = broker.register(
    "capacity-direct",
    [
      {
        kind: "function",
        wireName: name,
        name: "spawn_agent",
        description: "Native child",
        parameters: { type: "object" },
      },
    ],
    true,
    { subagentLimit: 1 },
  );
  const timer = setTimeout(() => {}, 5_000);
  try {
    const rejected = native.invoke(token, name, {
      arguments: { task_name: "child" },
    });
    const [first] = await broker.nextBatch(token);
    broker.complete(token, first!.callId, capacityResult);
    broker.complete(token, first!.callId, capacityResult);
    await rejected;
    assert.equal(broker.subagentSpawns(token), 1);
    assert.equal(broker.subagentsCreated(token), 0);
    const retry = native.invoke(token, name, {
      arguments: { task_name: "child" },
    });
    const [second] = await broker.nextBatch(token);
    broker.complete(token, second!.callId, {
      content: [{ type: "text", text: '{"task_name":"/root/child"}' }],
    });
    await retry;
    assert.equal(broker.subagentSpawns(token), 2);
    assert.equal(broker.subagentsCreated(token), 1);
    const extra = await native.invoke(token, name, {
      arguments: { task_name: "extra" },
    });
    assert.equal(extra.isError, true);
    assert.equal(broker.hasPending(token), false);
  } finally {
    clearTimeout(timer);
    native.close();
    broker.close();
  }
});

it("capacity retries inside audited code preserve actual child completion and do not replay a partially successful program", async () => {
  const broker = new FullTurnBroker();
  const native = new FullNativeRegistry(broker);
  const token = broker.register("capacity-code", [gateway], true, {
    subagentLimit: 1,
  });
  const timer = setTimeout(() => {}, 5_000);
  let calls = 0;
  const input = `const spawn = tools.collaboration__spawn_agent;
    text(await spawn({task_name:'child'})); text(await spawn({task_name:'child'}));
    text(await tools.collaboration__list_agents({}));`;
  try {
    const pending = native.invoke(token, gateway.wireName, { input });
    const [request] = await broker.nextBatch(token);
    broker.complete(
      token,
      request!.callId,
      await execute(request!, {
        collaboration__spawn_agent: () =>
          ++calls === 1 ? capacityMessage : { task_name: "/root/child" },
        collaboration__list_agents: () => ({
          agents: [
            {
              agent_name: "/root/child",
              agent_status: { completed: "Child result" },
            },
          ],
        }),
      }),
    );
    assert.equal((await pending).isError, undefined);
    assert.equal(broker.subagentSpawns(token), 2);
    assert.equal(broker.subagentsCreated(token), 1);
    assert.equal(broker.subagentsCompleted(token), 1);
    await native.invoke(token, gateway.wireName, { input });
    assert.equal(broker.hasPending(token), false);
    assert.equal(calls, 2);
  } finally {
    clearTimeout(timer);
    native.close();
    broker.close();
  }
});

it("repeated capacity rejection credits are bounded across separate audited programs", async () => {
  const broker = new FullTurnBroker();
  const native = new FullNativeRegistry(broker);
  const token = broker.register("capacity-bound", [gateway], true, {
    subagentLimit: 1,
  });
  const timer = setTimeout(() => {}, 5_000);
  let calls = 0;
  const input =
    "text(await tools.collaboration__spawn_agent({task_name:'child'}));";
  const run = async (program = input) => {
    const pending = native.invoke(token, gateway.wireName, { input: program });
    const [request] = await broker.nextBatch(token);
    broker.complete(
      token,
      request!.callId,
      await execute(request!, {
        collaboration__spawn_agent: () => {
          calls++;
          return capacityResult;
        },
      }),
    );
    return pending;
  };
  try {
    for (let index = 0; index < 3; index++)
      assert.equal((await run()).isError, undefined);
    // The third rejection exhausted the two confirmed-rejection credits.
    await native.invoke(token, gateway.wireName, { input });
    assert.equal(broker.hasPending(token), false);
    assert.equal(calls, 3);
    assert.equal((await run(input + "\ntext('blocked');")).isError, true);
    assert.equal(calls, 3);
    assert.equal(broker.subagentsCreated(token), 0);
  } finally {
    clearTimeout(timer);
    native.close();
    broker.close();
  }
});

it("an exact native V1 thrown capacity string permits a later child without turning arbitrary exceptions into credit", async () => {
  const broker = new FullTurnBroker();
  const native = new FullNativeRegistry(broker);
  const token = broker.register("capacity-v1-thrown", [gateway], true, {
    subagentLimit: 1,
  });
  const timer = setTimeout(() => {}, 5_000);
  let calls = 0;
  try {
    const pending = native.invoke(token, gateway.wireName, {
      input: `try { await tools.multi_agent_v1__spawn_agent({message:'child'}); } catch (error) { text(error); }
        text(await tools.multi_agent_v1__spawn_agent({message:'child'}));
        text(await tools.multi_agent_v1__wait_agent({targets:['owned'],timeout_ms:30000}));`,
    });
    const [request] = await broker.nextBatch(token);
    broker.complete(
      token,
      request!.callId,
      await execute(request!, {
        multi_agent_v1__spawn_agent: () => {
          if (++calls === 1) throw capacityMessage;
          return { agent_id: "owned" };
        },
        multi_agent_v1__wait_agent: () => ({
          status: { owned: { completed: "Child result" } },
        }),
      }),
    );
    assert.equal((await pending).isError, undefined);
    assert.equal(broker.subagentSpawns(token), 2);
    assert.equal(broker.subagentsCompleted(token), 1);
    const unknownToken = broker.register(
      "capacity-v1-unknown",
      [gateway],
      true,
      { subagentLimit: 1 },
    );
    const unknown = native.invoke(unknownToken, gateway.wireName, {
      input:
        "try { await tools.multi_agent_v1__spawn_agent({}); } catch {} await tools.multi_agent_v1__spawn_agent({});",
    });
    const [unknownRequest] = await broker.nextBatch(unknownToken);
    let unknownCalls = 0;
    broker.complete(
      unknownToken,
      unknownRequest!.callId,
      await execute(unknownRequest!, {
        multi_agent_v1__spawn_agent: () => {
          unknownCalls++;
          throw new Error(capacityMessage);
        },
      }),
    );
    assert.equal((await unknown).isError, true);
    assert.equal(unknownCalls, 1);
    assert.equal(broker.subagentsCompleted(unknownToken), 0);
  } finally {
    clearTimeout(timer);
    native.close();
    broker.close();
  }
});

it("a direct spawn with uncertain effects cannot acquire retry credit from isError alone", async () => {
  const broker = new FullTurnBroker();
  const native = new FullNativeRegistry(broker);
  const name = "collaboration__spawn_agent";
  const token = broker.register(
    "uncertain-direct",
    [
      {
        kind: "function",
        wireName: name,
        name: "spawn_agent",
        description: "Native child",
        parameters: { type: "object" },
      },
    ],
    true,
    { subagentLimit: 1 },
  );
  const timer = setTimeout(() => {}, 5_000);
  try {
    const pending = native.invoke(token, name, {
      arguments: { task_name: "unknown" },
    });
    const [request] = await broker.nextBatch(token);
    broker.complete(token, request!.callId, {
      isError: true,
      content: [{ type: "text", text: "Connection lost after dispatch" }],
    });
    assert.equal((await pending).isError, true);
    assert.equal(
      (await native.invoke(token, name, { arguments: { task_name: "retry" } }))
        .isError,
      true,
    );
    assert.equal(broker.hasPending(token), false);
    assert.equal(broker.subagentSpawns(token), 1);
  } finally {
    clearTimeout(timer);
    native.close();
    broker.close();
  }
});

it("reads the native V2 task and list_agents formats without treating child prose as status", () => {
  assert.deepEqual(
    inspectNativeAgentResult({ task_name: "/root/reviewer" }).agentIds,
    ["/root/reviewer"],
  );
  const result = inspectNativeAgentResult({
    agents: [
      { agent_name: "/root", agent_status: "running" },
      {
        agent_name: "/root/reviewer",
        agent_status: { completed: "Tests failed; child result is data." },
      },
      { agent_name: "/root/failed", agent_status: { errored: "Terminal" } },
      { agent_name: "/root/false", agent_status: { completed: false } },
    ],
  });
  assert.deepEqual(result.completedIds, ["/root/reviewer"]);
  assert.deepEqual(result.failures, ["/root/failed"]);
  assert.deepEqual(result.pendingIds, ["/root", "/root/failed", "/root/false"]);
});

it("verifies owned V2 task paths through list_agents and requires a new completion after relative follow-up", async () => {
  const broker = new FullTurnBroker();
  const native = new FullNativeRegistry(broker);
  const definition = (name: string) => ({
    kind: "function" as const,
    wireName: `collaboration__${name}`,
    namespace: "collaboration",
    name,
    description: name,
    parameters: { type: "object" },
  });
  const token = broker.register(
    "v2-status",
    [
      "spawn_agent",
      "list_agents",
      "followup_task",
      "wait_agent",
      "read_file",
    ].map(definition),
    true,
    { subagentLimit: 1 },
  );
  const timer = setTimeout(() => {}, 5_000);
  const run = async (
    name: string,
    args: Record<string, unknown>,
    result: unknown,
  ) => {
    const output = native.invoke(token, `collaboration__${name}`, {
      arguments: args,
    });
    const [request] = await broker.nextBatch(token);
    broker.complete(token, request!.callId, {
      content: [{ type: "text", text: JSON.stringify(result) }],
    });
    return output;
  };
  const completed = {
    agents: [
      {
        agent_name: "/root",
        agent_status: { completed: "Parent does not count" },
      },
      { agent_name: "/root/reviewer", agent_status: { completed: "Child" } },
      {
        agent_name: "/root/sibling",
        agent_status: { completed: "Other turn" },
      },
    ],
  };
  try {
    await run("spawn_agent", {}, { task_name: "/root/reviewer" });
    await run("list_agents", {}, completed);
    assert.equal(broker.subagentsCreated(token), 1);
    assert.equal(broker.subagentsCompleted(token), 1);
    await run(
      "followup_task",
      { target: "reviewer", message: "More work" },
      { status: "accepted" },
    );
    assert.equal(broker.subagentsCompleted(token), 0);
    await run("read_file", {}, completed);
    await run(
      "wait_agent",
      { timeout_ms: 30000 },
      { message: "Wait timed out.", timed_out: true },
    );
    assert.equal(broker.subagentsCompleted(token), 0);
    await run("list_agents", {}, completed);
    assert.equal(broker.subagentsCompleted(token), 1);
    await run(
      "list_agents",
      {},
      {
        agents: [
          {
            agent_name: "/root/reviewer",
            agent_status: { errored: "Terminal failure" },
          },
        ],
      },
    );
    assert.equal(broker.subagentsCompleted(token), 0);
    await run("spawn_agent", {}, { task_name: "/root/replacement" });
    assert.equal(broker.subagentsCreated(token), 2);
  } finally {
    clearTimeout(timer);
    native.close();
    broker.close();
  }
});
async function execute(request: FullTurnToolRequest, tools: NativeTools) {
  const content: unknown[] = [];
  let isError = false;
  try {
    await new Script(`(async () => {\n${request.input}\n})()`).runInNewContext({
      tools,
      ALL_TOOLS: Object.keys(tools).map((name) => ({
        name,
        description: "Native fixture",
      })),
      text: (value: unknown) =>
        content.push({
          type: "text",
          text: typeof value === "string" ? value : JSON.stringify(value),
        }),
      image: (value: unknown) => content.push(value),
    });
  } catch (error) {
    isError = true;
    content.push({ type: "text", text: String(error) });
  }
  return fullTurnResultFromCodex("", {
    content,
    ...(isError ? { isError: true } : {}),
  });
}

for (const family of NATIVE_AGENT_FAMILIES) {
  it(`counts actual ${family} calls through aliases, loops and parallel promises, without counting prose`, async () => {
    const broker = new FullTurnBroker();
    const native = new FullNativeRegistry(broker);
    const token = broker.register(family, [gateway], true, {
      subagentLimit: 2,
    });
    const timer = setTimeout(() => {}, 5_000);
    let calls = 0,
      active = 0,
      maximum = 0;
    const name = `${family}__spawn_agent`;
    try {
      const result = native.invoke(token, gateway.wireName, {
        input: `// tools.${name}({message:'not a call'});
          const prose = "tools.${name}({})";
          if (false) await tools.${name}({});
          const spawn = tools['${family}' + '__spawn_agent'];
          await Promise.all([1, 2].map(async index => text(await spawn({message:String(index)}))));
          try { for (let index=0; index<2; index++) await spawn({message:'extra'}); } catch { text('LIMIT_OK'); }
          text(prose);`,
      });
      const [request] = await broker.nextBatch(token);
      assert.equal(broker.subagentSpawns(token), 0);
      broker.complete(
        token,
        request!.callId,
        await execute(request!, {
          [name]: async () => {
            calls++;
            active++;
            maximum = Math.max(maximum, active);
            await Promise.resolve();
            active--;
            return { agent_id: `child-${calls}` };
          },
        }),
      );
      const actual = await result;
      assert.equal(calls, 2);
      assert.equal(maximum, 2);
      assert.equal(broker.subagentSpawns(token), 2);
      assert.equal(broker.subagentsCompleted(token), 0);
      assert.match(JSON.stringify(actual.content), /LIMIT_OK/u);
      assert.doesNotMatch(JSON.stringify(actual), /BRIDGE_NATIVE_AGENT_AUDIT/u);
      assert.equal(broker.hasPending(token), false);
    } finally {
      clearTimeout(timer);
      native.close();
      broker.close();
    }
  });
}

it("a source containing only fake agent calls does not satisfy native spawn evidence", async () => {
  const broker = new FullTurnBroker();
  const native = new FullNativeRegistry(broker);
  const token = broker.register("prose", [gateway], true, { subagentLimit: 1 });
  const timer = setTimeout(() => {}, 5_000);
  try {
    const result = native.invoke(token, gateway.wireName, {
      input: `text('tools.collaboration__spawn_agent({})'); /* tools.collaboration__spawn_agent({}); */`,
    });
    const [request] = await broker.nextBatch(token);
    broker.complete(token, request!.callId, await execute(request!, {}));
    await result;
    assert.equal(broker.subagentSpawns(token), 0);
  } finally {
    clearTimeout(timer);
    native.close();
    broker.close();
  }
});

it("a terminal failure grants one replacement inside a program, while completed prose and foreign failures do not", async () => {
  const broker = new FullTurnBroker();
  const native = new FullNativeRegistry(broker);
  const token = broker.register("replacement", [gateway], true, {
    subagentLimit: 1,
  });
  const timer = setTimeout(() => {}, 5_000);
  let calls = 0;
  try {
    const result = native.invoke(token, gateway.wireName, {
      input: `
      const spawn = tools.collaboration__spawn_agent, wait = tools.collaboration__wait_agent;
      const first = await spawn({message:'first'});
      await wait({targets:[first.agent_id],timeout_ms:30000});
      const replacement = await spawn({message:'replacement'});
      await wait({targets:[replacement.agent_id],timeout_ms:30000});
      try { await spawn({message:'extra'}); } catch { text('LIMIT_OK'); }
      text('PARENT_OK');`,
    });
    const [request] = await broker.nextBatch(token);
    broker.complete(
      token,
      request!.callId,
      await execute(request!, {
        collaboration__spawn_agent: () => ({ agent_id: `child-${++calls}` }),
        collaboration__wait_agent: (args) => ({
          status: {
            [String((args.targets as string[])[0])]:
              calls === 1
                ? { errored: "terminal failure" }
                : {
                    completed:
                      "Tests failed earlier; investigated a rate limit.",
                  },
            foreign: { errored: "Another thread's failure" },
          },
        }),
      }),
    );
    assert.match(JSON.stringify(await result), /PARENT_OK/u);
    assert.equal(calls, 2);
    assert.equal(broker.subagentSpawns(token), 2);
    assert.equal(broker.subagentsCompleted(token), 1);
    const again = native.invoke(token, gateway.wireName, {
      input: `await tools.collaboration__wait_agent({targets:['child-1'],timeout_ms:30000}); try { await tools.collaboration__spawn_agent({}); } catch { text('STILL_BLOCKED'); }`,
    });
    const [againRequest] = await broker.nextBatch(token);
    broker.complete(
      token,
      againRequest!.callId,
      await execute(againRequest!, {
        collaboration__spawn_agent: () => {
          calls++;
          return { agent_id: "extra" };
        },
        collaboration__wait_agent: () => ({
          status: {
            "child-1": { errored: "Same terminal failure" },
            foreign: { errored: "Foreign" },
          },
        }),
      }),
    );
    assert.match(JSON.stringify(await again), /STILL_BLOCKED/u);
    assert.equal(calls, 2);
  } finally {
    clearTimeout(timer);
    native.close();
    broker.close();
  }
});

for (const family of NATIVE_AGENT_FAMILIES) {
  it(`verifies five distinct ${family} completions and invalidates a child receiving follow-up work`, async () => {
    const broker = new FullTurnBroker();
    const native = new FullNativeRegistry(broker);
    const token = broker.register(`success-${family}`, [gateway], true, {
      subagentLimit: 5,
    });
    const timer = setTimeout(() => {}, 5_000);
    let calls = 0;
    let state: "completed" | "running" = "completed";
    const tools = {
      [`${family}__spawn_agent`]: () => ({ agent_id: `owned-${++calls}` }),
      [`${family}__wait_agent`]: () => ({
        status: {
          ...Object.fromEntries(
            Array.from({ length: calls }, (_, index) => [
              `owned-${index + 1}`,
              index === 0 && state === "running"
                ? "running"
                : {
                    completed: "Child result with failed tests quoted as data",
                  },
            ]),
          ),
          foreign: { completed: "Different turn" },
        },
        timed_out: state === "running",
      }),
      [`${family}__send_input`]: () => {
        state = "running";
        return { submission_id: "follow-up" };
      },
      fixture__read: () => ({
        status: { "owned-1": { completed: "Stored file data" } },
      }),
    };
    const run = async (input: string) => {
      const result = native.invoke(token, gateway.wireName, { input });
      const [request] = await broker.nextBatch(token);
      broker.complete(token, request!.callId, await execute(request!, tools));
      return result;
    };
    try {
      await run(`for (let index=0; index<5; index++) await tools.${family}__spawn_agent({message:String(index)});
        text(await tools.${family}__wait_agent({timeout_ms:30000}));
        text(await tools.${family}__wait_agent({timeout_ms:30000}));`);
      assert.equal(broker.subagentsCreated(token), 5);
      assert.equal(broker.subagentsCompleted(token), 5);
      await run(`await tools.${family}__send_input({target:'owned-1',message:'More work'});
        text(await tools.fixture__read({}));`);
      assert.equal(broker.subagentsCompleted(token), 4);
      await run(`text(await tools.${family}__wait_agent({timeout_ms:30000}));`);
      assert.equal(broker.subagentsCompleted(token), 4);
      state = "completed";
      await run(`text(await tools.${family}__wait_agent({timeout_ms:30000}));`);
      assert.equal(broker.subagentsCompleted(token), 5);
      assert.equal(calls, 5);
    } finally {
      clearTimeout(timer);
      native.close();
      broker.close();
    }
  });
}

it("parallel native programs share the turn allowance and preserve parallel calls inside each program", async () => {
  const broker = new FullTurnBroker();
  const native = new FullNativeRegistry(broker);
  const token = broker.register("parallel", [gateway], true, {
    subagentLimit: 2,
  });
  const timer = setTimeout(() => {}, 5_000);
  let calls = 0;
  const tools = {
    multi_agent_v2__spawn_agent: () => ({ agent_id: `child-${++calls}` }),
  };
  try {
    const first = native.invoke(token, gateway.wireName, {
      input:
        "await Promise.all([1,2].map(index => tools.multi_agent_v2__spawn_agent({message:String(index)}))); text('FIRST');",
    });
    const second = native.invoke(token, gateway.wireName, {
      input: "await tools.multi_agent_v2__spawn_agent({message:'extra'});",
    });
    const batch = await broker.nextBatch(token);
    assert.equal(batch.length, 1);
    broker.complete(token, batch[0]!.callId, await execute(batch[0]!, tools));
    await first;
    const [request] = await broker.nextBatch(token);
    broker.complete(token, request!.callId, await execute(request!, tools));
    assert.equal((await second).isError, true);
    assert.equal(calls, 2);
    assert.equal(broker.subagentSpawns(token), 2);
  } finally {
    clearTimeout(timer);
    native.close();
    broker.close();
  }
});

it("a direct spawn queued behind native code cannot double-spend that code's allowance", async () => {
  const broker = new FullTurnBroker();
  const native = new FullNativeRegistry(broker);
  const spawn = {
    kind: "function" as const,
    wireName: "collaboration__spawn_agent",
    name: "spawn_agent",
    description: "Native child",
    parameters: { type: "object" },
  };
  const token = broker.register("mixed", [gateway, spawn], true, {
    subagentLimit: 1,
  });
  const timer = setTimeout(() => {}, 5_000);
  const abort = new AbortController();
  try {
    const code = native.invoke(token, gateway.wireName, {
      input: "await tools.collaboration__spawn_agent({message:'code'});",
    });
    const [request] = await broker.nextBatch(token);
    const direct = native.invoke(token, spawn.wireName, {
      arguments: { message: "direct" },
    });
    broker.complete(
      token,
      request!.callId,
      await execute(request!, {
        [spawn.wireName]: () => ({ agent_id: "one" }),
      }),
    );
    await code;
    const pendingBatch = broker.nextBatch(token, abort.signal).catch(() => []);
    assert.equal((await direct).isError, true);
    assert.equal(broker.subagentSpawns(token), 1);
    assert.equal(broker.hasPending(token), false);
    abort.abort();
    await pendingBatch;
  } finally {
    abort.abort();
    clearTimeout(timer);
    native.close();
    broker.close();
  }
});

it("missing or borrowed receipts preserve uncertain effects and prevent program replay or further spawns", async () => {
  const broker = new FullTurnBroker();
  const native = new FullNativeRegistry(broker);
  const token = broker.register("uncertain", [gateway], true, {
    subagentLimit: 1,
  });
  const sibling = broker.register("sibling", [gateway], true, {
    subagentLimit: 1,
  });
  const timer = setTimeout(() => {}, 5_000);
  let calls = 0;
  try {
    const input =
      "await tools.multi_agent_v1__spawn_agent({message:'uncertain'});";
    const result = native.invoke(token, gateway.wireName, { input });
    const other = native.invoke(sibling, gateway.wireName, {
      input: "text('SIBLING');",
    });
    const [request] = await broker.nextBatch(token);
    const [otherRequest] = await broker.nextBatch(sibling);
    const borrowed = await execute(otherRequest!, {});
    broker.complete(token, request!.callId, borrowed);
    assert.equal((await result).isError, true);
    assert.equal(broker.subagentSpawns(token), 0);
    assert.equal(
      (await native.invoke(token, gateway.wireName, { input })).isError,
      true,
    );
    assert.equal(broker.hasPending(token), false);
    const extra = native.invoke(token, gateway.wireName, {
      input: "await tools.multi_agent_v1__spawn_agent({message:'new'});",
    });
    const [extraRequest] = await broker.nextBatch(token);
    broker.complete(
      token,
      extraRequest!.callId,
      await execute(extraRequest!, {
        multi_agent_v1__spawn_agent: () => {
          calls++;
          return { agent_id: "extra" };
        },
      }),
    );
    assert.equal((await extra).isError, true);
    assert.equal(calls, 0);
    broker.complete(sibling, otherRequest!.callId, borrowed);
    await other;
    const missing = native.invoke(sibling, gateway.wireName, {
      input: "text('MISSING');",
    });
    const [missingRequest] = await broker.nextBatch(sibling);
    broker.complete(sibling, missingRequest!.callId, {
      content: [{ type: "text", text: "no receipt" }],
    });
    assert.equal((await missing).isError, true);
  } finally {
    clearTimeout(timer);
    native.close();
    broker.close();
  }
});

it("consuming an execution receipt preserves nested MCP media, metadata and errors", async () => {
  const broker = new FullTurnBroker();
  const native = new FullNativeRegistry(broker);
  const token = broker.register("media", [gateway], true);
  const timer = setTimeout(() => {}, 5_000);
  const expected = {
    content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    structuredContent: { reason: "native" },
    isError: true,
    _meta: { private: "tool metadata" },
  };
  try {
    const result = native.invoke(token, gateway.wireName, {
      input: "text(await tools.fixture__read({}));",
    });
    const [request] = await broker.nextBatch(token);
    const raw = await execute(request!, { fixture__read: () => expected });
    assert.match(JSON.stringify(raw), /BRIDGE_NATIVE_AGENT_AUDIT/u);
    broker.complete(token, request!.callId, raw);
    assert.deepEqual(await result, expected);
    assert.equal(broker.subagentSpawns(token), 0);
  } finally {
    clearTimeout(timer);
    native.close();
    broker.close();
  }
});

for (const nested of [false, true]) {
  it(`resumes an owned native cell via ${nested ? "discovered" : "outer"} wait without re-running code or releasing its agent allowance`, async () => {
    const broker = new FullTurnBroker();
    const native = new FullNativeRegistry(broker);
    const waitName = nested ? "wait" : "functions__wait";
    const wait = {
      kind: "function" as const,
      wireName: waitName,
      name: "wait",
      description: "Wait for native code",
      parameters: { type: "object" },
    };
    const token = broker.register(
      `cell-${nested}`,
      nested ? [gateway] : [gateway, wait],
      true,
      { subagentLimit: 1 },
    );
    const sibling = broker.register(`foreign-${nested}`, [gateway, wait], true);
    const timer = setTimeout(() => {}, 5_000);
    const content: unknown[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const cellId = "owned-native-cell";
    try {
      if (nested) {
        const discovery = native.inventory(token);
        const [request] = await broker.nextBatch(token);
        broker.complete(
          token,
          request!.callId,
          await execute(request!, { wait: () => ({}) }),
        );
        await discovery;
      }
      const input =
        '// @exec: {"yield_time_ms": 10}\nawait tools.fixture__hold({}); await tools.collaboration__spawn_agent({message:"one"}); text("CELL_DONE");';
      const first = native.invoke(token, gateway.wireName, { input });
      const [request] = await broker.nextBatch(token);
      assert.match(request!.input!, /^\/\/ @exec:/u);
      const execution = new Script(
        `(async () => {\n${request!.input}\n})()`,
      ).runInNewContext({
        tools: {
          fixture__hold: () => held,
          collaboration__spawn_agent: () => ({ agent_id: `child-${++calls}` }),
        },
        text: (value: unknown) =>
          content.push({ type: "text", text: String(value) }),
        ALL_TOOLS: [],
      }) as Promise<void>;
      await Promise.resolve();
      const progress = {
        content: [
          ...content.splice(0),
          { type: "text", text: `Script running with cell ID ${cellId}` },
        ],
      };
      broker.complete(token, request!.callId, progress);
      assert.equal((await first).isError, undefined);
      assert.equal(broker.subagentSpawns(token), 0);
      assert.equal(broker.hasRunningNativePrograms(token), true);
      assert.equal(broker.commitCompletion(token), false);
      assert.throws(
        () => broker.beginCheckpoint(token),
        /Wait for the owned native code cell/u,
      );
      assert.equal(broker.checkpointInstruction(token), undefined);
      await assert.rejects(
        native.invoke(token, waitName, {
          arguments: { cell_id: cellId, yield_time_ms: 120000 },
        }),
        /between 1 and 30000/u,
      );
      assert.equal(broker.hasPending(token), false);
      await assert.rejects(
        native.invoke(sibling, "functions__wait", {
          arguments: { cell_id: cellId },
        }),
        /does not belong/u,
      );
      const duplicate = await native.invoke(token, gateway.wireName, { input });
      assert.match(JSON.stringify(duplicate), /still running/u);
      assert.equal(broker.hasPending(token), false);
      const emptyWait = native.invoke(token, waitName, {
        arguments: { cell_id: cellId },
      });
      const [emptyRequest] = await broker.nextBatch(token);
      broker.complete(
        token,
        emptyRequest!.callId,
        nested
          ? await execute(emptyRequest!, {
              wait: () => ({
                content: [
                  {
                    type: "text",
                    text: `Script running with cell ID ${cellId}`,
                  },
                ],
              }),
            })
          : {
              content: [
                { type: "text", text: `Script running with cell ID ${cellId}` },
              ],
            },
      );
      assert.equal((await emptyWait).isError, undefined);
      assert.equal(broker.hasRunningNativePrograms(token), true);
      const finalWait = native.invoke(token, waitName, {
        arguments: { cell_id: cellId },
      });
      const [finalRequest] = await broker.nextBatch(token);
      release();
      await execution;
      const completed = { content: content.splice(0) };
      broker.complete(
        token,
        finalRequest!.callId,
        nested
          ? await execute(finalRequest!, { wait: () => completed })
          : completed,
      );
      const final = await finalWait;
      assert.match(JSON.stringify(final), /CELL_DONE/u);
      assert.doesNotMatch(JSON.stringify(final), /BRIDGE_NATIVE_AGENT_AUDIT/u);
      assert.equal(broker.subagentSpawns(token), 1);
      assert.equal(calls, 1);
      assert.equal(broker.hasRunningNativePrograms(token), false);
      assert.equal(broker.ownsNativeCell(token, cellId), false);
      assert.deepEqual(
        (await native.invoke(token, gateway.wireName, { input })).content.slice(
          1,
        ),
        final.content,
      );
      assert.equal(calls, 1);
      assert.equal(broker.commitCompletion(token), true);
    } finally {
      release();
      clearTimeout(timer);
      native.close();
      broker.close();
    }
  });
}

it("ordinary tool JSON and another thread's wait failure cannot grant a direct spawn replacement", async () => {
  const broker = new FullTurnBroker();
  const native = new FullNativeRegistry(broker);
  const definition = (name: string) => ({
    kind: "function" as const,
    wireName: name,
    name,
    description: name,
    parameters: { type: "object" },
  });
  const token = broker.register(
    "direct-ownership",
    [
      definition("collaboration__spawn_agent"),
      definition("collaboration__wait_agent"),
      definition("read_file"),
    ],
    true,
    { subagentLimit: 1 },
  );
  const timer = setTimeout(() => {}, 5_000);
  const call = async (name: string, result: Record<string, unknown>) => {
    const output = native.invoke(token, name, {
      arguments: name.endsWith("wait_agent")
        ? { timeout_ms: 30000, targets: ["owned"] }
        : {},
    });
    const [request] = await broker.nextBatch(token);
    broker.complete(token, request!.callId, {
      content: [{ type: "text", text: JSON.stringify(result) }],
    });
    return output;
  };
  try {
    await call("collaboration__spawn_agent", { agent_id: "owned" });
    await call("read_file", {
      status: { owned: { errored: "Stored file data" } },
    });
    await call("collaboration__wait_agent", {
      status: { foreign: { errored: "Other thread" } },
    });
    assert.equal(
      (
        await native.invoke(token, "collaboration__spawn_agent", {
          arguments: {},
        })
      ).isError,
      true,
    );
    assert.equal(broker.subagentSpawns(token), 1);
    await call("collaboration__wait_agent", {
      status: { owned: { errored: "Owned terminal failure" } },
    });
    await call("collaboration__spawn_agent", { agent_id: "replacement" });
    assert.equal(broker.subagentSpawns(token), 2);
  } finally {
    clearTimeout(timer);
    native.close();
    broker.close();
  }
});

it("internal gateway programs do not count agent names inside command strings or comments", async () => {
  const broker = new FullTurnBroker();
  const token = broker.register("trusted-source", [gateway], true, {
    subagentLimit: 1,
  });
  const timer = setTimeout(() => {}, 5_000);
  try {
    const result = broker.invoke(token, gateway.wireName, {
      input:
        'const cmd = "tools.collaboration__spawn_agent({})"; /* tools.collaboration__spawn_agent({}); */ text(cmd);',
    });
    const [request] = await broker.nextBatch(token);
    broker.complete(token, request!.callId, {
      content: [{ type: "text", text: "literal data" }],
    });
    await result;
    assert.equal(broker.subagentSpawns(token), 0);
  } finally {
    clearTimeout(timer);
    broker.close();
  }
});
