import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import {
  compileResponsesPrompt,
  prepareBridgeWebTurn,
  FullTurnBroker,
  FullTurnMcpServer,
  MANUAL_COMPLETION_TOOL,
  type BridgeExecutionPreflight,
} from "@codexgpt-bridge/responses-gateway";
import { planContextSync } from "./context-sync.js";
import { parseAdvancedSettings, SilenceWatchdog } from "./advanced-settings.js";
import { ManualTurns } from "./manual-turns.js";

it("preserves verbosity in Simple and Full output contracts and rejects invalid values", () => {
  const compile = (verbosity: string) =>
    compileResponsesPrompt({
      input: "Explain the change",
      text: { verbosity },
    });
  const low = prepareBridgeWebTurn(compile("low"));
  const high = prepareBridgeWebTurn(compile("high"));
  assert.match(low.contract!, /Keep the final answer concise/);
  assert.match(high.outputContract!, /thorough final answer/);
  assert.notEqual(low.contract, high.contract);
  assert.throws(() => compile("extreme"), /text.verbosity/);
});

it("keeps the newest ten attachments and the canonical ledger during a history rebuild", () => {
  const input = Array.from({ length: 12 }, (_, index) => ({
    role: "user",
    content: [
      {
        type: "input_image",
        image_url: `data:image/png;base64,image${index}`,
        detail: index === 8 ? "original" : "high",
      },
      { type: "input_text", text: `Image ${index}` },
    ],
  }));
  const compiled = compileResponsesPrompt({ input });
  const ledger = [...compiled.context.ledger];
  const sync = planContextSync(
    compiled.context,
    "contract",
    undefined,
    compiled.images,
  );
  const all = [...sync.images, ...compiled.images];
  assert.equal(new Set(all.map((image) => image.imageUrl)).size, 10);
  assert.equal(
    all.some((image) => image.imageUrl.endsWith("image0")),
    false,
  );
  assert.equal(
    all.find((image) => image.imageUrl.endsWith("image8"))?.detail,
    "original",
  );
  assert.match(sync.text, /older attachment omitted/);
  assert.deepEqual(compiled.context.ledger, ledger);
  const next = compileResponsesPrompt({
    input: [
      ...input,
      { role: "assistant", content: "done" },
      { role: "user", content: "Continue" },
    ],
  });
  assert.equal(
    planContextSync(next.context, "contract", sync.receipt).reset,
    false,
  );
});

it("rejects an oversized current image request instead of silently losing its images", () => {
  const current = Array.from({ length: 11 }, (_, index) => ({
    ref: `${index}`,
    imageUrl: `data:image/png;base64,${index}`,
  }));
  assert.throws(
    () =>
      planContextSync(
        { ledger: [], history: [], instructions: "", images: [] },
        "",
        undefined,
        current,
      ),
    /10 distinct/,
  );
});

it("silence watchdog ignores repeated observations and resets on real progress", () => {
  const watch = new SilenceWatchdog(2, 0);
  watch.observe("first", 10);
  watch.observe("first", 1000);
  assert.throws(() => watch.observe("first", 2010), /no observable progress/);
  watch.observe("changed", 3000);
  watch.observe("changed", 4500);
  assert.throws(
    () => parseAdvancedSettings({ silenceTimeoutSeconds: -1 }),
    /timeout/,
  );
  assert.throws(
    () => parseAdvancedSettings({ autoApproveToolCalls: "true" }),
    /boolean/,
  );
});

async function pending(host: ManualTurns) {
  for (let index = 0; index < 100; index++) {
    if (host.tasks()[0]) return host.tasks()[0]!;
    await delay(5);
  }
  throw new Error("Manual task did not appear.");
}

it("manual completion binds the original token, blocks before Sent and retains source context", async () => {
  const broker = new FullTurnBroker();
  const host = new ManualTurns(broker);
  const compiled = compileResponsesPrompt({ input: "Do the task" });
  const token = broker.register("manual-test", [], true);
  const abort = new AbortController();
  const work = host.runTurn({
    turnToken: token,
    threadId: "thread-manual",
    turnId: "turn-manual",
    mode: "high",
    prompt: compiled.prompt,
    context: compiled.context,
    contract: "Use Bridge",
    images: [],
    signal: abort.signal,
    allowWebNativeTools: true,
    onContextStaging: () => broker.beginContextStaging(token),
    onContextCommit: () => broker.commitContextStaging(token),
  });
  try {
    const task = await pending(host);
    assert.equal(task.retained, false);
    assert.throws(() => host.complete(token, "premature"), /No sent/);
    assert.throws(() => host.assertSent(token), /Confirm Sent/);
    host.sent(task.id);
    assert.throws(
      () => host.complete("another-token", "wrong task"),
      /owns this token/,
    );
    host.complete(token, "Actual answer");
    assert.equal(await work, "Actual answer");
    assert.equal(host.tasks().length, 0);
    const checkpointToken = broker.register("checkpoint-test", [], true);
    const checkpoint = broker.beginCheckpoint(checkpointToken);
    const capability = /checkpoint_[A-Za-z0-9_-]{40,}/u.exec(
      JSON.stringify(broker.checkpointInstruction(checkpointToken)),
    )![0];
    const retained = host.runTurn({
      turnToken: checkpointToken,
      threadId: "thread-manual",
      turnId: "checkpoint-manual",
      mode: "high",
      prompt: "Submit checkpoint",
      context: compiled.context,
      contract: "Checkpoint",
      images: [],
      signal: abort.signal,
      allowWebNativeTools: true,
      requireRetainedConversation: true,
    });
    const server = new FullTurnMcpServer(
      broker,
      (token, text) => host.complete(token, text),
      (token) => host.assertSent(token),
    );
    try {
      const task = await pending(host);
      assert.equal(task.retained, true);
      const address = await server.start();
      const init = await fetch(address.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        }),
      });
      const session = init.headers.get("mcp-session-id")!;
      const call = async (id: number) =>
        (await (
          await fetch(address.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "mcp-session-id": session,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: {
                name: "codex_tool_call",
                arguments: {
                  turn_token: checkpointToken,
                  wire_name: "bridge.control.checkpoint",
                  arguments: {
                    checkpoint_token: capability,
                    summary: "Retained actual checkpoint",
                  },
                },
              },
            }),
          })
        ).json()) as { result: { isError?: boolean } };
      assert.equal((await call(2)).result.isError, true);
      host.sent(task.id);
      assert.equal((await call(3)).result.isError, undefined);
      assert.equal(await checkpoint, "Retained actual checkpoint");
      assert.equal(await retained, "Retained actual checkpoint");
    } finally {
      await server.close();
    }
  } finally {
    abort.abort();
    host.close();
    broker.close();
  }
});

it("returns manual answers through the existing generic connector tools without native execution", async () => {
  const broker = new FullTurnBroker();
  const host = new ManualTurns(broker);
  const server = new FullTurnMcpServer(
    broker,
    (token, text) => host.complete(token, text),
    (token) => host.assertSent(token),
  );
  const abort = new AbortController();
  const token = broker.register(
    "manual-generic",
    [
      {
        kind: "function",
        wireName: "native_test",
        name: "native_test",
        description: "Test pending native work",
        parameters: { type: "object" },
      },
    ],
    true,
  );
  const work = host.runTurn({
    turnToken: token,
    threadId: "manual-generic",
    mode: "medium",
    prompt: "Only reply with success",
    images: [],
    signal: abort.signal,
    allowWebNativeTools: true,
  });
  void work.catch(() => {});
  try {
    const task = await pending(host);
    const address = await server.start();
    const init = await fetch(address.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });
    const session = init.headers.get("mcp-session-id")!;
    let id = 1;
    const call = async (name: string, arguments_: Record<string, unknown>) => {
      const response = await fetch(address.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-session-id": session,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name, arguments: arguments_ },
        }),
      });
      const rpc = (await response.json()) as {
        result: {
          isError?: boolean;
          structuredContent?: { tools: { wireName: string }[] };
        };
      };
      return rpc.result;
    };
    const completion = (text: unknown, capability = token) =>
      call("codex_tool_call", {
        turn_token: capability,
        wire_name: MANUAL_COMPLETION_TOOL,
        arguments: { text },
      });
    assert.match(task.prompt, /plain ChatGPT reply alone does not complete/);
    assert.equal((await completion("too soon")).isError, true);
    assert.throws(() => host.completeFromUser(task.id, "too soon"), /No sent/);
    host.sent(task.id);
    const inventory = await call("codex_tool_inventory", {
      turn_token: token,
      query: MANUAL_COMPLETION_TOOL,
    });
    assert.equal(
      inventory.structuredContent?.tools[0]?.wireName,
      MANUAL_COMPLETION_TOOL,
    );
    assert.equal(broker.hasPending(token), false);
    assert.equal(
      (await completion("wrong owner", "unknown-token")).isError,
      true,
    );
    assert.equal((await completion(42)).isError, true);
    assert.equal((await completion(" ")).isError, true);
    const native = broker.invoke(token, "native_test", { arguments: {} });
    const [request] = await broker.nextBatch(token);
    assert.equal((await completion("too early")).isError, true);
    assert.throws(
      () => host.completeFromUser(task.id, "too early"),
      /pending Codex tools/,
    );
    broker.complete(token, request!.callId, {
      content: [{ type: "text", text: "done" }],
    });
    await native;
    assert.equal((await completion("actual final answer")).isError, undefined);
    assert.equal(await work, "actual final answer");
    assert.equal(host.tasks().length, 0);
  } finally {
    abort.abort();
    host.close();
    broker.close();
    await server.close();
  }
});

it("accepts an operator-pasted final answer only for its sent manual task", async () => {
  const broker = new FullTurnBroker();
  const host = new ManualTurns(broker);
  const abort = new AbortController();
  const token = broker.register("manual-paste", [], true);
  const work = host.runTurn({
    turnToken: token,
    mode: "medium",
    prompt: "Test",
    images: [],
    signal: abort.signal,
    allowWebNativeTools: true,
  });
  void work.catch(() => {});
  try {
    const task = await pending(host);
    assert.throws(
      () => host.completeFromUser("unrelated-task", "answer"),
      /ended/,
    );
    host.sent(task.id);
    assert.throws(() => host.completeFromUser(task.id, ""), /1–2000000/);
    host.completeFromUser(task.id, "  Verified ChatGPT answer\n");
    assert.equal(await work, "  Verified ChatGPT answer\n");
  } finally {
    abort.abort();
    host.close();
    broker.close();
  }
});

it("manual cancellation and missing Sent timeouts release their queue slots", async () => {
  const broker = new FullTurnBroker();
  const host = new ManualTurns(broker, 40);
  const token = broker.register("cancel-test", [], true);
  const abort = new AbortController();
  const work = host.runTurn({
    turnToken: token,
    threadId: "thread-cancel",
    mode: "high",
    prompt: "task",
    images: [],
    signal: abort.signal,
    allowWebNativeTools: true,
  });
  const rejected = assert.rejects(work, /cancelled/);
  await pending(host);
  abort.abort();
  await rejected;
  assert.equal(host.pool.status().active, 0);
  const next = host.runTurn({
    turnToken: token,
    threadId: "thread-timeout",
    mode: "high",
    prompt: "task",
    images: [],
    signal: new AbortController().signal,
    allowWebNativeTools: true,
  });
  await Promise.all([assert.rejects(next, /before Sent/), delay(60)]);
  assert.equal(host.tasks().length, 0);
  assert.equal(host.pool.status().active, 0);
  host.close();
  broker.close();
});

it("manual 3x context requires exact staged acknowledgements and commits tools only after the final send", async () => {
  const broker = new FullTurnBroker();
  const host = new ManualTurns(broker);
  const token = broker.register("manual-3x", [], true);
  const abort = new AbortController();
  const compiled = compileResponsesPrompt({
    input: "alpha beta gamma ".repeat(1600),
  });
  const execution: BridgeExecutionPreflight = {
    version: 1,
    route: "codexgpt-bridge/gpt-6.1-sol-3x",
    mode: "high",
    operationToolTransport: "full",
    toolTransport: "full",
    attempt: "initial",
    toolCount: 0,
    sourceContextTokens: 0,
    inputBasis: "full-context",
    inputTokens: 0,
    textTokens: 0,
    textCharacters: 0,
    imageCount: 0,
    imageReserveTokens: 0,
    platformReserveTokens: 8192,
    contextWindow: 30000,
    hardInputTokenLimit: 30000,
    autoCompactTokenLimit: 27000,
    browserMessageTokenLimit: 2000,
    remainingInputTokens: 30000,
    status: "within-limit",
    budgetProfile: "test",
    contextMultiplier: 3,
  };
  let committed = false;
  const work = host.runTurn({
    turnToken: token,
    threadId: "thread-3x",
    mode: "high",
    prompt: compiled.prompt,
    context: compiled.context,
    contract: "Use the connector",
    images: [],
    signal: abort.signal,
    allowWebNativeTools: true,
    execution,
    onContextStaging: () => broker.beginContextStaging(token),
    onContextCommit: () => {
      broker.commitContextStaging(token);
      committed = true;
    },
  });
  try {
    let task = await pending(host);
    assert.ok(task.total > 1);
    while (task.acknowledgement) {
      assert.match(task.prompt, /bridge_context_stage/);
      assert.equal(committed, false);
      host.sent(task.id);
      assert.throws(() => host.assertSent(token), /Confirm Sent/);
      assert.throws(
        () => host.acknowledge(task.id, "wrong acknowledgement"),
        /exact acknowledgement/,
      );
      host.acknowledge(task.id, task.acknowledgement);
      task = host.tasks()[0]!;
    }
    assert.match(task.prompt, /bridge_context_commit/);
    assert.equal(committed, false);
    host.sent(task.id);
    assert.equal(committed, true);
    host.complete(token, "Completed staged task");
    assert.equal(await work, "Completed staged task");
  } finally {
    abort.abort();
    host.close();
    broker.close();
  }
});
