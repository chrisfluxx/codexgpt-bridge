import assert from "node:assert/strict";
import { it } from "node:test";
import { FullTurnBroker } from "./full-turn-broker.js";
import {
  FullTurnCoordinator,
  type FullTurnRunInput,
} from "./full-turn-coordinator.js";
import { FullTurnMcpServer } from "./full-turn-mcp-server.js";
import { FULL_CHECKPOINT_TOOL } from "./full-checkpoint.js";
import { compileResponsesPrompt } from "./prompt.js";
import { responsesOperationId } from "./operation-identity.js";
import { ResponsesGateway } from "./responses-server.js";

it("obtains a read-only receipt from the exact completed source when Pro finishes the task during compaction", async () => {
  const broker = new FullTurnBroker();
  const coordinator = new FullTurnCoordinator(broker);
  const keepAlive = setTimeout(() => {}, 5_000);
  let originalToken = "";
  let sourceRuns = 0;
  let controlRuns = 0;
  let released = 0;
  const source = input(
    async (request) => {
      sourceRuns++;
      originalToken = /turn_[A-Za-z0-9_-]{40,}/u.exec(request.contract)![0];
      await broker.invoke(originalToken, "read_file", { arguments: {} });
      return "<!--codex_text-->\nFinished answer from canonical file contents.\n<!--/codex_text-->";
    },
    () => {
      released++;
    },
  );
  try {
    const first = await coordinator.run(source);
    assert.equal(first.kind, "tool_calls");
    if (first.kind !== "tool_calls") return;
    const compiled = compactInput(first.calls[0]!.callId!, "source-turn");
    const runner = {
      operationId: "completed-source-control",
      acquireToolLease: () => ({
        release() {
          released++;
        },
      }),
      runBrowser: async (
        request: Parameters<FullTurnRunInput["runBrowser"]>[0],
      ) => {
        controlRuns++;
        assert.equal(request.threadId, source.compiled.threadId);
        assert.equal(request.requireRetainedConversation, true);
        assert.equal(broker.isActive(originalToken), false);
        assert.match(request.prompt, /retained source conversation/u);
        const token = /turn_[A-Za-z0-9_-]{40,}/u.exec(request.contract)![0];
        assert.notEqual(token, originalToken);
        assert.deepEqual(
          broker.inventory(token).tools.map((tool) => tool.wireName),
          [FULL_CHECKPOINT_TOOL],
        );
        const blocked = await broker.invoke(token, "read_file", {
          arguments: {},
        });
        assert.match(JSON.stringify(blocked), /checkpoint control/u);
        assert.equal(broker.hasPending(token), false);
        assert.equal(broker.hasInvoked(token), false);
        const capability = /checkpoint_[A-Za-z0-9_-]{40,}/u.exec(
          request.contract,
        )![0];
        broker.submitCheckpoint(token, {
          checkpoint_token: capability,
          summary:
            "Completed: one canonical read and the final answer. Next: deliver the answer without repeating the read.",
        });
        return "Checkpoint submitted";
      },
    };
    const checkpoint = await coordinator.compact(
      compiled,
      source.model,
      source.requestSignal,
      runner,
    );
    assert.equal(checkpoint?.kind, "compaction");
    assert.deepEqual(
      await coordinator.compact(
        compiled,
        source.model,
        source.requestSignal,
        runner,
      ),
      checkpoint,
    );
    await assert.rejects(
      coordinator.run(source),
      /retired after its context checkpoint/u,
    );
    assert.equal(sourceRuns, 1);
    assert.equal(controlRuns, 1);
    assert.equal(released, 2);
  } finally {
    clearTimeout(keepAlive);
    coordinator.close();
  }
});

it("identifies checkpoint epochs without repeating the preserved human request", () => {
  const metadata = { thread_id: "same-thread", turn_id: "same-turn" };
  const user = { role: "user", content: "Read the file once and finish." };
  const checkpoint = {
    type: "compaction",
    id: "transport-id",
    encrypted_content:
      "cgb1:" +
      Buffer.from(
        "Completed: one read. Next: submit the internal checkpoint receipt and finish.",
      ).toString("base64"),
  };
  const compile = (items: unknown[]) =>
    compileResponsesPrompt({ metadata, input: items });
  const before = compile([user]);
  const after = compile([user, checkpoint]);
  assert.equal(before.contextEpoch, undefined);
  assert.ok(after.contextEpoch);
  assert.match(
    after.prompt,
    /Continue the current Codex task from the checkpoint/u,
  );
  assert.match(after.prompt, /checkpoint has already been accepted/u);
  assert.match(after.prompt, /requested final response format/u);
  assert.match(after.prompt, /Do not resubmit the checkpoint/u);
  assert.equal(after.context.history.length, 2);
  const rebuilt = compile([
    user,
    { ...checkpoint, id: "rebuilt-id", status: "completed" },
  ]);
  assert.equal(rebuilt.contextEpoch, after.contextEpoch);
  assert.equal(
    responsesOperationId("codexgpt-bridge/pro", rebuilt),
    responsesOperationId("codexgpt-bridge/pro", after),
  );
  const toolFollowup = compile([
    user,
    checkpoint,
    {
      type: "function_call",
      call_id: "next-read",
      name: "read_file",
      arguments: "{}",
    },
    {
      type: "function_call_output",
      call_id: "next-read",
      output: "Next result",
    },
  ]);
  assert.equal(toolFollowup.contextEpoch, after.contextEpoch);
  const steering = compile([
    user,
    checkpoint,
    { role: "user", content: "Use the new constraint." },
  ]);
  assert.equal(steering.contextEpoch, after.contextEpoch);
  assert.equal(steering.prompt, "Use the new constraint.");
  const next = compile([
    user,
    {
      ...checkpoint,
      encrypted_content:
        "cgb1:" + Buffer.from("Second checkpoint").toString("base64"),
    },
  ]);
  assert.notEqual(next.contextEpoch, after.contextEpoch);
});

it("continues two Full checkpoints under the same native turn and replays each epoch without repeating tools", async () => {
  const broker = new FullTurnBroker();
  const coordinator = new FullTurnCoordinator(broker);
  const keepAlive = setTimeout(() => {}, 5_000);
  const metadata = { thread_id: "checkpoint-thread", turn_id: "source-turn" };
  const user = {
    role: "user",
    content: "Read each remaining file once, then finish.",
  };
  const tool = {
    type: "function",
    name: "read_file",
    parameters: { type: "object" },
  };
  let history: unknown[] = [user];
  let runs = 0;
  let reads = 0;
  let released = 0;
  const tokens: string[] = [];
  const runBrowser: FullTurnRunInput["runBrowser"] = async (request) => {
    const token = /turn_[A-Za-z0-9_-]{40,}/u.exec(request.contract)![0];
    tokens.push(token);
    runs++;
    if (runs === 3)
      return "<!--codex_text-->\nAll files read once.\n<!--/codex_text-->";
    reads++;
    const result = await broker.invoke(token, "read_file", { arguments: {} });
    assert.match(JSON.stringify(result), /Canonical result/u);
    const capability = /checkpoint_[A-Za-z0-9_-]{40,}/u.exec(
      JSON.stringify(broker.checkpointInstruction(token)),
    )![0];
    broker.submitCheckpoint(token, {
      checkpoint_token: capability,
      summary: `Completed: ${reads} canonical reads. Next: continue without repeating them.`,
    });
    return "Checkpoint accepted";
  };
  const base = input(runBrowser, () => {
    released++;
  });
  try {
    for (let epoch = 0; epoch < 2; epoch++) {
      const source = {
        ...base,
        compiled: compileResponsesPrompt({
          metadata,
          input: history,
          tools: [tool],
        }),
      };
      const first = await coordinator.run(source);
      assert.equal(first.kind, "tool_calls");
      if (first.kind !== "tool_calls") return;
      assert.equal(first.calls.length, 1);
      const call = first.calls[0]!;
      const compact = compileResponsesPrompt({
        metadata,
        bridge_compaction: true,
        input: [
          ...history,
          {
            type: "function_call",
            call_id: call.callId,
            name: "read_file",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: call.callId,
            output: "Canonical result",
          },
        ],
      });
      const result = await coordinator.compact(
        compact,
        base.model,
        base.requestSignal,
      );
      assert.equal(result?.kind, "compaction");
      if (result?.kind !== "compaction") return;
      assert.deepEqual(
        await coordinator.compact(compact, base.model, base.requestSignal),
        result,
      );
      await assert.rejects(
        coordinator.run(source),
        /retired after its context checkpoint/u,
      );
      assert.equal(runs, epoch + 1);
      assert.equal(broker.isActive(tokens[epoch]!), false);
      history = [
        user,
        {
          type: "compaction",
          encrypted_content:
            "cgb1:" + Buffer.from(result.summary).toString("base64"),
        },
      ];
    }
    const resumed = {
      ...base,
      compiled: compileResponsesPrompt({ metadata, input: history, tools: [] }),
    };
    const answer = { kind: "text", text: "All files read once." };
    assert.deepEqual(
      await Promise.all([coordinator.run(resumed), coordinator.run(resumed)]),
      [answer, answer],
    );
    assert.deepEqual(await coordinator.run(resumed), answer);
    assert.equal(runs, 3);
    assert.equal(reads, 2);
    assert.equal(new Set(tokens).size, 3);
    assert.equal(released, 3);
  } finally {
    clearTimeout(keepAlive);
    coordinator.close();
  }
});

it("returns the final SSE response after /responses/compact preserves the native turn ID", async () => {
  const broker = new FullTurnBroker();
  let browserRuns = 0;
  let toolReads = 0;
  const gateway = new ResponsesGateway({
    port: 0,
    fullMcp: { broker, enabled: () => true, connectorName: () => "Bridge" },
    runWebTurn: async (request) => {
      browserRuns++;
      const token = /turn_[A-Za-z0-9_-]{40,}/u.exec(request.contract!)![0];
      if (browserRuns === 2) {
        assert.match(
          request.prompt,
          /Continue the current Codex task from the checkpoint/u,
        );
        return "<!--codex_text-->\nBRIDGE_SAME_TURN_CHECKPOINT_OK\n<!--/codex_text-->";
      }
      toolReads++;
      await broker.invoke(token, "read_file", { arguments: {} });
      const capability = /checkpoint_[A-Za-z0-9_-]{40,}/u.exec(
        JSON.stringify(broker.checkpointInstruction(token)),
      )![0];
      broker.submitCheckpoint(token, {
        checkpoint_token: capability,
        summary:
          "Completed: read_file once. Next: return BRIDGE_SAME_TURN_CHECKPOINT_OK.",
      });
      return "Checkpoint submitted";
    },
  });
  try {
    const address = await gateway.start();
    const metadata = {
      thread_id: "http-checkpoint-thread",
      turn_id: "http-same-turn",
    };
    const user = { role: "user", content: "Read the file once, then finish." };
    const post = (path: string, body: Record<string, unknown>) =>
      fetch(`${address.baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/pro",
          metadata,
          ...body,
        }),
        signal: AbortSignal.timeout(5_000),
      });
    const first = await post("/responses", {
      input: [user],
      tools: [
        { type: "function", name: "read_file", parameters: { type: "object" } },
      ],
    });
    const firstBody = (await first.json()) as {
      output: Array<{ type: string; call_id?: string }>;
    };
    assert.equal(first.status, 200);
    const call = firstBody.output.find(
      (item) => item.type === "function_call",
    )!;
    const compact = await post("/responses/compact", {
      input: [
        user,
        call,
        {
          type: "function_call_output",
          call_id: call.call_id,
          output: "Canonical result",
        },
      ],
    });
    const compactBody = (await compact.json()) as { output: unknown[] };
    assert.equal(compact.status, 200);
    const resumedBody = {
      input: [user, ...compactBody.output],
      tools: [],
      stream: true,
    };
    for (let retry = 0; retry < 2; retry++) {
      const response = await post("/responses", resumedBody);
      const stream = await response.text();
      assert.equal(response.status, 200);
      assert.match(stream, /event: response.completed/u);
      assert.match(stream, /BRIDGE_SAME_TURN_CHECKPOINT_OK/u);
      assert.doesNotMatch(stream, /event: (?:error|response.failed)/u);
    }
    assert.equal(browserRuns, 2);
    assert.equal(toolReads, 1);
  } finally {
    await gateway.close();
    broker.close();
  }
});

it("keeps an active Pro checkpoint and reconnect alive beyond the former 90-second deadline", async (context) => {
  const broker = new FullTurnBroker();
  const coordinator = new FullTurnCoordinator(broker);
  const keepAlive = setTimeout(() => {}, 5_000);
  let token = "";
  let finishBrowser!: (text: string) => void;
  let released = 0;
  const source = {
    ...input(
      async (request) => {
        token = /turn_[A-Za-z0-9_-]{40,}/u.exec(request.contract)![0];
        await broker.invoke(token, "read_file", { arguments: {} });
        return new Promise<string>((resolve) => {
          finishBrowser = resolve;
        });
      },
      () => {
        released++;
      },
    ),
    model: "codexgpt-bridge/pro",
    mode: "pro" as const,
  };
  try {
    const first = await coordinator.run(source);
    assert.equal(first.kind, "tool_calls");
    if (first.kind !== "tool_calls") return;
    context.mock.timers.enable({
      apis: ["Date", "setTimeout"],
      now: Date.now(),
    });
    const compiled = compactInput(first.calls[0]!.callId!);
    const pending = coordinator.compact(
      compiled,
      source.model,
      source.requestSignal,
    );
    // Attach an observer before advancing time so a regression is not an
    // unhandled rejection. Pro may spend several minutes creating this receipt.
    void pending.catch(() => {});
    await Promise.resolve();
    context.mock.timers.tick(7 * 60_000);
    assert.equal(broker.isActive(token), true);
    const reconnect = coordinator.compact(
      compiled,
      source.model,
      source.requestSignal,
    );
    void reconnect.catch(() => {});
    assert.deepEqual(
      broker.inventory(token).tools.map((tool) => tool.wireName),
      [FULL_CHECKPOINT_TOOL],
    );
    const instruction = broker.checkpointInstruction(token)!;
    const capability = /checkpoint_[A-Za-z0-9_-]{40,}/u.exec(
      JSON.stringify(instruction),
    )![0];
    broker.submitCheckpoint(token, {
      checkpoint_token: capability,
      summary:
        "Goal: finish the task. Completed: one canonical read. Next: continue.",
    });
    finishBrowser("Checkpoint accepted");
    const checkpoint = await pending;
    assert.equal(checkpoint?.kind, "compaction");
    assert.deepEqual(await reconnect, checkpoint);
    assert.equal(released, 1);
    assert.equal(broker.isActive(token), false);
  } finally {
    context.mock.timers.reset();
    clearTimeout(keepAlive);
    coordinator.close();
  }
});

for (const complete of [true, false]) {
  it(`a retained Pro checkpoint ${complete ? "survives slow reasoning and reconnect" : "still expires without a receipt and releases its lease"}`, async (context) => {
    const broker = new FullTurnBroker();
    const coordinator = new FullTurnCoordinator(broker);
    const source = {
      ...input(async () => "Original Full answer"),
      compiled: compileResponsesPrompt({
        metadata: {
          thread_id: "checkpoint-thread",
          turn_id: "completed-source",
        },
        input: "Hello",
      }),
      model: "codexgpt-bridge/pro",
      mode: "pro" as const,
    };
    let token = "";
    let contract = "";
    let finishBrowser!: (text: string) => void;
    let released = 0;
    let runs = 0;
    try {
      await coordinator.run(source);
      context.mock.timers.enable({
        apis: ["Date", "setTimeout"],
        now: Date.now(),
      });
      const compiled = compileResponsesPrompt({
        metadata: {
          thread_id: "checkpoint-thread",
          turn_id: "retained-compact",
        },
        bridge_compaction: true,
        input: "Hello",
      });
      const runner = {
        operationId: "slow-retained-pro-checkpoint",
        acquireToolLease: () => ({
          release() {
            released++;
          },
        }),
        runBrowser: (
          request: Parameters<FullTurnRunInput["runBrowser"]>[0],
        ) => {
          runs++;
          contract = request.contract;
          token = /turn_[A-Za-z0-9_-]{40,}/u.exec(contract)![0];
          return new Promise<string>((resolve, reject) => {
            finishBrowser = resolve;
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            );
          });
        },
      };
      const pending = coordinator.compact(
        compiled,
        source.model,
        source.requestSignal,
        runner,
      );
      void pending.catch(() => {});
      context.mock.timers.tick(7 * 60_000);
      assert.equal(broker.isActive(token), true);
      const reconnect = coordinator.compact(
        compiled,
        source.model,
        source.requestSignal,
        runner,
      );
      void reconnect.catch(() => {});
      assert.equal(runs, 1);
      if (complete) {
        const capability = /checkpoint_[A-Za-z0-9_-]{40,}/u.exec(contract)![0];
        broker.submitCheckpoint(token, {
          checkpoint_token: capability,
          summary: "Goal: Hello. Completed: original answer. Next: continue.",
        });
        finishBrowser("Checkpoint accepted");
        const checkpoint = await pending;
        assert.equal(checkpoint?.kind, "compaction");
        assert.deepEqual(await reconnect, checkpoint);
      } else {
        context.mock.timers.tick(8 * 60_000 + 1);
        await assert.rejects(
          pending,
          /timed out; canonical history was retained/u,
        );
        await assert.rejects(
          reconnect,
          /timed out; canonical history was retained/u,
        );
      }
      assert.equal(released, 1);
      assert.equal(broker.isActive(token), false);
    } finally {
      context.mock.timers.reset();
      coordinator.close();
    }
  });
}

function input(
  runBrowser: FullTurnRunInput["runBrowser"],
  release = () => {},
): FullTurnRunInput {
  return {
    compiled: compileResponsesPrompt({
      metadata: { thread_id: "checkpoint-thread", turn_id: "source-turn" },
      input: "Read the file, then continue the task.",
      tools: [
        { type: "function", name: "read_file", parameters: { type: "object" } },
      ],
    }),
    model: "codexgpt-bridge/high",
    mode: "high",
    connectorName: "Bridge",
    operationId: "source",
    requestSignal: AbortSignal.timeout(5_000),
    acquireToolLease: () => ({ release }),
    runBrowser,
  };
}

function compactInput(callId: string, turnId = "compact-turn") {
  return compileResponsesPrompt({
    metadata: { thread_id: "checkpoint-thread", turn_id: turnId },
    bridge_compaction: true,
    input: [
      { role: "user", content: "Read the file, then continue the task." },
      {
        type: "function_call",
        name: "read_file",
        call_id: callId,
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: callId,
        output: "Canonical file contents",
      },
      { type: "compaction_trigger" },
    ],
  });
}

it("hands off an exact active Full source through a one-shot read-only checkpoint receipt", async () => {
  const broker = new FullTurnBroker();
  const coordinator = new FullTurnCoordinator(broker);
  const mcp = new FullTurnMcpServer(broker);
  const timer = setTimeout(() => {}, 5_000);
  let released = 0;
  let token = "";
  let runs = 0;
  const deltas: string[] = [];
  try {
    const address = await mcp.start();
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
    const call = async (name: string, args: Record<string, unknown>) => {
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
          params: { name, arguments: args },
        }),
      });
      return (
        (await response.json()) as {
          result: {
            isError?: boolean;
            content: Array<{ text: string }>;
            structuredContent?: {
              accepted?: boolean;
              tools?: Array<{ wireName: string }>;
            };
          };
        }
      ).result;
    };
    const source = input(
      async (request) => {
        runs++;
        token = /turn_[A-Za-z0-9_-]{40,}/u.exec(request.contract)![0];
        const read = await call("codex_tool_call", {
          turn_token: token,
          wire_name: "read_file",
          arguments: {},
        });
        assert.equal(read.content[0]!.text, "Canonical file contents");
        const instruction = read.content[1]!.text;
        const capability = /checkpoint_[A-Za-z0-9_-]{40,}/u.exec(
          instruction,
        )![0];
        assert.match(instruction, /Stop ordinary tool execution/u);
        const blocked = await call("codex_exec", {
          turn_token: token,
          cmd: "must never execute",
        });
        assert.match(JSON.stringify(blocked), /checkpoint control/u);
        assert.equal(broker.hasPending(token), false);
        const inventory = await call("codex_tool_inventory", {
          turn_token: token,
        });
        assert.deepEqual(
          inventory.structuredContent?.tools?.map((tool) => tool.wireName),
          [FULL_CHECKPOINT_TOOL],
        );
        const wrong = await call("codex_tool_call", {
          turn_token: token,
          wire_name: FULL_CHECKPOINT_TOOL,
          arguments: {
            checkpoint_token: "other-source",
            summary: "Must not be accepted",
          },
        });
        assert.equal(wrong.isError, true);
        const accepted = await call("codex_tool_call", {
          turn_token: token,
          wire_name: FULL_CHECKPOINT_TOOL,
          arguments: {
            checkpoint_token: capability,
            summary:
              "Goal: continue the task. Completed: read the file. Evidence: canonical file contents. Next: implement the remaining work.",
          },
        });
        assert.equal(accepted.structuredContent?.accepted, true);
        const repeated = await call("codex_tool_call", {
          turn_token: token,
          wire_name: FULL_CHECKPOINT_TOOL,
          arguments: {
            checkpoint_token: capability,
            summary: "A replacement summary",
          },
        });
        assert.equal(repeated.isError, true);
        request.onStreamSnapshot?.("<!--codex_text-->\nCheckpoint submitted");
        return "Checkpoint submitted";
      },
      () => {
        released++;
      },
    );
    const first = await coordinator.run({
      ...source,
      onDelta: (delta) => deltas.push(delta),
    });
    assert.equal(first.kind, "tool_calls");
    if (first.kind !== "tool_calls") return;
    const compiled = compactInput(first.calls[0]!.callId!);
    assert.equal(compiled.toolResults.length, 0);
    assert.equal(compiled.compactionToolResults?.length, 1);
    const checkpoint = await coordinator.compact(
      compiled,
      source.model,
      AbortSignal.timeout(5_000),
    );
    assert.equal(checkpoint?.kind, "compaction");
    if (checkpoint?.kind === "compaction")
      assert.match(checkpoint.summary, /Next: implement/u);
    assert.deepEqual(deltas, []);
    assert.equal(broker.isActive(token), false);
    assert.equal(released, 1);
    assert.equal(runs, 1);
    assert.deepEqual(
      await coordinator.compact(
        compiled,
        source.model,
        AbortSignal.timeout(5_000),
      ),
      checkpoint,
    );
    await assert.rejects(
      coordinator.run(source),
      /retired after its context checkpoint/u,
    );
    assert.equal(runs, 1);
  } finally {
    clearTimeout(timer);
    coordinator.close();
    await mcp.close();
  }
});

it("keeps canonical history intact when the exact source does not submit a checkpoint receipt", async () => {
  const broker = new FullTurnBroker();
  const coordinator = new FullTurnCoordinator(broker);
  const timer = setTimeout(() => {}, 5_000);
  let token = "";
  let runs = 0;
  const source = input(async (request) => {
    runs++;
    token = /turn_[A-Za-z0-9_-]{40,}/u.exec(request.contract)![0];
    await broker.invoke(token, "read_file", { arguments: {} });
    return "A plain answer without a structured checkpoint receipt";
  });
  try {
    const first = await coordinator.run(source);
    assert.equal(first.kind, "tool_calls");
    if (first.kind !== "tool_calls") return;
    const compact = compactInput(first.calls[0]!.callId!);
    const missing = {
      ...compact,
      turnId: "source-turn",
      compactionToolResults: [],
    };
    await assert.rejects(
      coordinator.compact(missing, source.model, AbortSignal.timeout(5_000)),
      /missing canonical results/u,
    );
    assert.equal(broker.checkpointInstruction(token), undefined);
    assert.equal(broker.hasPending(token), true);
    const sibling = { ...compact, threadId: "sibling-thread" };
    assert.equal(
      await coordinator.compact(
        sibling,
        source.model,
        AbortSignal.timeout(5_000),
      ),
      undefined,
    );
    assert.equal(broker.checkpointInstruction(token), undefined);
    await assert.rejects(
      coordinator.compact(compact, source.model, AbortSignal.timeout(5_000)),
      /without its checkpoint receipt/u,
    );
    assert.equal(broker.isActive(token), false);
    await assert.rejects(
      coordinator.run(source),
      /without its checkpoint receipt/u,
    );
    assert.equal(runs, 1);
  } finally {
    clearTimeout(timer);
    coordinator.close();
  }
});

it("reuses a completed Full conversation for a checkpoint with no ordinary tool capability", async () => {
  const broker = new FullTurnBroker();
  const coordinator = new FullTurnCoordinator(broker);
  const timer = setTimeout(() => {}, 5_000);
  let controlRuns = 0;
  let controlReleased = 0;
  let token = "";
  try {
    const source = {
      ...input(async () => "Original Full answer"),
      compiled: compileResponsesPrompt({
        metadata: {
          thread_id: "checkpoint-thread",
          turn_id: "completed-source",
        },
        input: "Hello",
      }),
    };
    assert.deepEqual(await coordinator.run(source), {
      kind: "text",
      text: "Original Full answer",
    });
    const compact = compileResponsesPrompt({
      metadata: { thread_id: "checkpoint-thread", turn_id: "retained-compact" },
      bridge_compaction: true,
      input: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Original Full answer" },
      ],
    });
    const runner = {
      operationId: "retained-control",
      acquireToolLease: () => ({
        release() {
          controlReleased++;
        },
      }),
      runBrowser: async (
        request: Parameters<FullTurnRunInput["runBrowser"]>[0],
      ) => {
        controlRuns++;
        assert.equal(request.requireRetainedConversation, true);
        assert.equal(request.allowWebNativeTools, true);
        assert.equal(request.threadId, "checkpoint-thread");
        assert.equal(request.mode, source.mode);
        assert.equal(request.connectorName, "Bridge");
        token = /turn_[A-Za-z0-9_-]{40,}/u.exec(request.contract)![0];
        const capability = /checkpoint_[A-Za-z0-9_-]{40,}/u.exec(
          request.contract,
        )![0];
        assert.deepEqual(
          broker.inventory(token).tools.map((tool) => tool.wireName),
          [FULL_CHECKPOINT_TOOL],
        );
        assert.match(
          JSON.stringify(
            await broker.invoke(token, "any_workspace_tool", { arguments: {} }),
          ),
          /Stop ordinary tool execution/u,
        );
        assert.equal(broker.hasPending(token), false);
        broker.submitCheckpoint(token, {
          checkpoint_token: capability,
          summary:
            "Goal: Hello. Completed: original Full answer. Next: continue from the current constraints.",
        });
        return "Checkpoint submitted";
      },
    };
    const checkpoint = await coordinator.compact(
      compact,
      source.model,
      AbortSignal.timeout(5_000),
      runner,
    );
    assert.equal(checkpoint?.kind, "compaction");
    assert.equal(controlRuns, 1);
    assert.equal(controlReleased, 1);
    assert.equal(broker.isActive(token), false);
    assert.deepEqual(
      await coordinator.compact(
        compact,
        source.model,
        AbortSignal.timeout(5_000),
        runner,
      ),
      checkpoint,
    );
    assert.equal(controlRuns, 1);
    assert.deepEqual(await coordinator.run(source), {
      kind: "text",
      text: "Original Full answer",
    });
  } finally {
    clearTimeout(timer);
    coordinator.close();
  }
});

it("interrupts only the matching retained checkpoint control and releases its lease", async () => {
  const broker = new FullTurnBroker();
  const coordinator = new FullTurnCoordinator(broker);
  const timer = setTimeout(() => {}, 5_000);
  let released = 0;
  try {
    const source = {
      ...input(async () => "Original Full answer"),
      compiled: compileResponsesPrompt({
        metadata: {
          thread_id: "checkpoint-thread",
          turn_id: "completed-source",
        },
        input: "Hello",
      }),
    };
    await coordinator.run(source);
    const compact = compileResponsesPrompt({
      metadata: { thread_id: "checkpoint-thread", turn_id: "compact-control" },
      bridge_compaction: true,
      input: "Hello",
    });
    const pending = coordinator.compact(
      compact,
      source.model,
      AbortSignal.timeout(5_000),
      {
        operationId: "interrupt-checkpoint",
        acquireToolLease: () => ({
          release() {
            released++;
          },
        }),
        runBrowser: (request) =>
          new Promise<string>((_resolve, reject) =>
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            ),
          ),
      },
    );
    assert.equal(
      coordinator.interrupt(
        "sibling-thread",
        "compact-control",
        new Error("Wrong turn"),
      ),
      0,
    );
    assert.equal(
      coordinator.interrupt(
        "checkpoint-thread",
        "compact-control",
        new Error("User interrupted the checkpoint"),
      ),
      1,
    );
    await assert.rejects(pending, /User interrupted/u);
    assert.equal(released, 1);
  } finally {
    clearTimeout(timer);
    coordinator.close();
  }
});
