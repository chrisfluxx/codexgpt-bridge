import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LunaCheckpointStore,
  validateLunaCheckpoint,
} from "./luna-checkpoints.js";
import { compileResponsesPrompt } from "./prompt.js";
import {
  ResponsesGateway,
  buildStartupModelsPayload,
} from "./responses-server.js";
import { FullTurnBroker } from "./full-turn-broker.js";

it("binds persisted private checkpoints to the exact native prefix and completed answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-luna-checkpoint-"));
  try {
    const path = join(root, "checkpoints.json");
    const request = (input: unknown[], thread = "luna-parent") =>
      compileResponsesPrompt({
        input,
        metadata: { thread_id: thread, turn_id: "luna-turn-1" },
        instructions: "Current native instructions",
      });
    const first = request([
      { role: "user", content: "Private source question" },
    ]);
    const store = new LunaCheckpointStore(path);
    await store.commit(
      first,
      "Goal: preserve state. Next: run the next check.",
      "Completed answer",
    );
    const next = request([
      { role: "user", content: "Private source question" },
      { role: "assistant", content: "Completed answer" },
      { role: "user", content: "Continue" },
    ]);
    const reduced = await new LunaCheckpointStore(path).prepare(next);
    assert.equal(reduced.context.history.length, 1);
    assert.match(reduced.context.history[0]!, /browser_checkpoint/);
    assert.doesNotMatch(
      reduced.context.history.join("\n"),
      /Private source question/,
    );
    assert.equal(reduced.context.instructions, next.context.instructions);
    assert.equal(next.context.history.length, 2);
    assert.doesNotMatch(
      await readFile(path, "utf8"),
      /Private source question|Completed answer/,
    );
    for (const input of [
      [
        { role: "user", content: "Edited source" },
        { role: "assistant", content: "Completed answer" },
        { role: "user", content: "Continue" },
      ],
      [
        { role: "user", content: "Private source question" },
        {
          type: "function_call_output",
          call_id: "unknown",
          output: "Unverified action",
        },
        { role: "assistant", content: "Completed answer" },
        { role: "user", content: "Continue" },
      ],
      [
        { role: "user", content: "Private source question" },
        { role: "assistant", content: "Different answer" },
        { role: "user", content: "Continue" },
      ],
    ]) {
      const changed = request(input);
      assert.equal(await store.prepare(changed), changed);
    }
    const sibling = request(
      [
        { role: "user", content: "Private source question" },
        { role: "assistant", content: "Completed answer" },
        { role: "user", content: "Continue" },
      ],
      "luna-child",
    );
    assert.equal(await store.prepare(sibling), sibling);
    assert.throws(
      () => validateLunaCheckpoint(" token".repeat(4_001)),
      /oversized/,
    );
    assert.throws(
      () => validateLunaCheckpoint("turn_" + "a".repeat(44)),
      /capability/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rolls three real Full HTTP turns across a 28k browser envelope without changing canonical history", async () => {
  const broker = new FullTurnBroker();
  let normal = 0;
  let checkpoints = 0;
  const contexts: string[][] = [];
  const estimates: Array<{ source: number; actual: number }> = [];
  const gateway = new ResponsesGateway({
    port: 0,
    accountContextProfile: () => "standard",
    availableWebModes: () => ["luna", "think"],
    fullMcp: { broker, enabled: () => true, connectorName: () => "Bridge" },
    runWebTurn: async (input) => {
      assert.equal(input.allowWebNativeTools, true);
      if (input.requireRetainedConversation) {
        checkpoints++;
        assert.equal(input.forceNewConversation, undefined);
        const token = /turn_[A-Za-z0-9_-]{40,}/.exec(input.contract!)![0];
        const capability = /checkpoint_[A-Za-z0-9_-]{40,}/.exec(
          input.contract!,
        )![0];
        assert.deepEqual(
          broker.inventory(token).tools.map((tool) => tool.wireName),
          ["bridge.control.checkpoint"],
        );
        broker.submitCheckpoint(token, {
          checkpoint_token: capability,
          summary:
            "Goal: continue the task. Completed: checks passed. Next: inspect the next request.",
        });
        return "Private checkpoint accepted";
      }
      normal++;
      assert.equal(input.forceNewConversation, true);
      assert.ok(input.execution!.inputTokens <= 28_000);
      contexts.push([...input.context!.history]);
      estimates.push({
        source: input.execution!.sourceContextTokens,
        actual: input.execution!.inputTokens,
      });
      return `Reply ${normal}`;
    },
  });
  try {
    const address = await gateway.start();
    const items: Array<{ role: string; content: string }> = [];
    for (let index = 1; index <= 3; index++) {
      items.push({
        role: "user",
        content: `Request ${index}:` + " token".repeat(10_000),
      });
      const body = {
        model: "codexgpt-bridge/luna-native",
        metadata: {
          thread_id: "luna-full-http",
          turn_id: `luna-turn-${index}`,
        },
        input: items,
      };
      const post = () =>
        fetch(`${address.baseUrl}/responses`, {
          method: "POST",
          headers: {
            authorization: "Bearer test",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      const result = await post();
      assert.equal(result.status, 200, await result.text());
      if (index === 1) {
        const retry = await post();
        assert.equal(retry.status, 200);
        await retry.text();
        assert.equal(normal, 1);
        assert.equal(checkpoints, 1);
      }
      items.push({ role: "assistant", content: `Reply ${index}` });
    }
    assert.equal(normal, 3);
    assert.equal(checkpoints, 3);
    assert.equal(contexts[0]!.length, 0);
    assert.match(contexts[1]![0]!, /browser_checkpoint/);
    assert.equal(contexts[2]!.length, 1);
    assert.ok(estimates[2]!.source > 28_000);
    assert.ok(estimates[2]!.actual < 28_000);
    assert.equal(items.length, 6);
    const rows = buildStartupModelsPayload(
      { models: [] },
      ["luna"],
      "standard",
      [],
    ) as { models: Array<{ slug: string; context_window: number }> };
    assert.equal(
      rows.models.find((row) => row.slug === "codexgpt-bridge/luna-native")
        ?.context_window,
      1_050_000,
    );
  } finally {
    await gateway.close();
  }
});

it("withholds checkpoint failure without repeating the completed Full operation", async () => {
  const broker = new FullTurnBroker();
  let sends = 0;
  const gateway = new ResponsesGateway({
    port: 0,
    accountContextProfile: () => "standard",
    availableWebModes: () => ["luna"],
    fullMcp: { broker, enabled: () => true, connectorName: () => "Bridge" },
    runWebTurn: async (input) => {
      sends++;
      return input.requireRetainedConversation
        ? "No checkpoint receipt"
        : "Completed once";
    },
  });
  try {
    const address = await gateway.start();
    const post = () =>
      fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/luna-native",
          metadata: { thread_id: "luna-failure", turn_id: "luna-failed-turn" },
          input: "Hello",
        }),
      });
    const first = await post();
    assert.equal(first.status, 500);
    assert.match(await first.text(), /checkpoint receipt/);
    const retry = await post();
    assert.equal(retry.status, 500);
    await retry.text();
    assert.equal(sends, 2);
  } finally {
    await gateway.close();
  }
});
