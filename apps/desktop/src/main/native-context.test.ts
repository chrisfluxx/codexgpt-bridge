import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileResponsesPrompt } from "@codexgpt-bridge/responses-gateway";
import { planContextSync } from "./context-sync.js";
import { ChatGptConversations } from "./chatgpt-conversations.js";
import { TurnPool } from "./turn-pool.js";

it("reports FIFO queue positions and updates them when a waiting task cancels", async () => {
  const pool = new TurnPool(1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = pool.run(new AbortController().signal, () => gate);
  const controller = new AbortController();
  const second = pool.run(controller.signal, async () =>
    assert.fail("cancelled waiter executed"),
  );
  const positions: number[] = [];
  const third = pool.run(
    new AbortController().signal,
    async () => "third",
    (ahead) => positions.push(ahead),
  );
  assert.equal(positions.at(-1), 2);
  const rejected = assert.rejects(second, { name: "AbortError" });
  controller.abort();
  assert.equal(positions.at(-1), 1);
  release();
  await Promise.all([first, rejected]);
  assert.equal(await third, "third");
  assert.equal(positions.at(-1), 0);
});

it("retains the conversation when replay reorders keys and omits empty annotations", () => {
  const first = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "test" }],
  };
  const reply = {
    type: "message",
    role: "assistant",
    phase: "final_answer",
    content: [{ type: "output_text", annotations: [], text: "test OK" }],
  };
  const before = compileResponsesPrompt({
    input: [first, reply, { role: "user", content: "test2" }],
  }).context;
  const receipt = planContextSync(before, "contract").receipt;
  const reordered = {
    role: "assistant",
    content: [{ text: "test OK", type: "output_text" }],
    phase: "final_answer",
    type: "message",
  };
  const progress = {
    type: "message",
    role: "assistant",
    phase: "commentary",
    content: [{ type: "output_text", text: "Bridge：正在準備 ChatGPT 對話。" }],
  };
  const rebuilt = compileResponsesPrompt({
    input: [first, reordered, { role: "user", content: "test2" }, progress],
  }).context;
  const sync = planContextSync(rebuilt, "contract", receipt);
  assert.deepEqual(rebuilt.ledger, before.ledger);
  assert.equal(sync.reset, false);
  assert.equal(sync.text, "");
  const changed = compileResponsesPrompt({
    input: [
      first,
      { ...reply, content: [{ type: "output_text", text: "different reply" }] },
      { role: "user", content: "test2" },
    ],
  }).context;
  assert.equal(planContextSync(changed, "contract", receipt).reset, true);
  const annotated = compileResponsesPrompt({
    input: [
      first,
      {
        ...reply,
        content: [
          {
            type: "output_text",
            text: "test OK",
            annotations: [{ type: "citation", source: "new-source" }],
          },
        ],
      },
      { role: "user", content: "test2" },
    ],
  }).context;
  assert.equal(planContextSync(annotated, "contract", receipt).reset, true);
});

it("synchronizes rules once, appends history, and rebuilds divergent contexts", () => {
  const first = compileResponsesPrompt({
    instructions: "Use project conventions",
    input: [{ role: "user", content: "hello" }],
  }).context;
  const initial = planContextSync(first, "contract");
  assert.equal(initial.reset, true);
  assert.match(initial.text, /project conventions/);
  const next = compileResponsesPrompt({
    instructions: "Use project conventions",
    input: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "ready" },
      { role: "user", content: "continue" },
    ],
  }).context;
  const followup = planContextSync(next, "contract", initial.receipt);
  assert.equal(followup.reset, false);
  assert.doesNotMatch(followup.text, /project conventions|hello/);
  assert.match(followup.text, /ready/);
  assert.doesNotMatch(followup.text, /continue/);
  const changed = planContextSync(
    { ...next, instructions: "New project rules" },
    "new contract",
    followup.receipt,
  );
  assert.equal(changed.reset, false);
  assert.match(changed.text, /New project rules|new contract/);
  assert.equal(
    planContextSync(first, "contract", followup.receipt).reset,
    true,
  );
});

it("keeps old images structured and transfers them only with their history", () => {
  const context = compileResponsesPrompt({
    input: [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,YWJj" },
        ],
      },
      { role: "user", content: "describe earlier image" },
    ],
  }).context;
  const first = planContextSync(context, "contract");
  assert.equal(first.images.length, 1);
  assert.doesNotMatch(first.text, /base64/);
  assert.equal(
    planContextSync(context, "contract", first.receipt).images.length,
    0,
  );
});

it("replays generated images across turns without putting base64 in the composer", () => {
  for (const format of ["png", "jpeg", "webp"] as const) {
    const bytes = "YWJj".repeat(400_000);
    const initial = compileResponsesPrompt({
      input: [{ role: "user", content: "draw" }],
    });
    const receipt = planContextSync(initial.context, "contract").receipt;
    const input = [
      { role: "user", content: "draw" },
      { type: "image_generation_call", result: bytes, output_format: format },
      { role: "user", content: "describe the characters" },
    ];
    const next = compileResponsesPrompt({ input });
    const sync = planContextSync(next.context, "contract", receipt);
    assert.equal(sync.reset, false);
    assert.ok(sync.text.length < 1000);
    assert.doesNotMatch(sync.text, /YWJj|base64/);
    assert.equal(sync.images.length, 1);
    assert.equal(
      sync.images[0]?.imageUrl,
      `data:image/${format};base64,${bytes}`,
    );
    const later = compileResponsesPrompt({
      input: [
        ...input,
        { role: "assistant", content: "description" },
        { role: "user", content: "continue" },
      ],
    });
    const followup = planContextSync(later.context, "contract", sync.receipt);
    assert.equal(followup.reset, false);
    assert.equal(followup.images.length, 0);
    assert.doesNotMatch(followup.text, /YWJj/);
    const restored = planContextSync(later.context, "contract");
    assert.equal(restored.images.length, 1);
    assert.ok(restored.text.length < 1500);
  }
});

it("persists acknowledgements across restart without overwriting parallel task mappings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-context-"));
  try {
    const file = join(directory, "contexts.json");
    const store = new ChatGptConversations("https://chatgpt.com/", file);
    const receipt = planContextSync(
      compileResponsesPrompt({ input: [{ role: "user", content: "hello" }] })
        .context,
      "tools",
    ).receipt;
    await Promise.all([
      store.remember("thread-one", "https://chatgpt.com/c/chat-one", receipt),
      store.remember("thread-two", "https://chatgpt.com/c/chat-two", receipt),
    ]);
    const restarted = new ChatGptConversations("https://chatgpt.com/", file);
    assert.equal(
      await restarted.get("thread-one"),
      "https://chatgpt.com/c/chat-one",
    );
    assert.equal(
      await restarted.get("thread-two"),
      "https://chatgpt.com/c/chat-two",
    );
    assert.deepEqual(await restarted.receipt("thread-one"), receipt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("runs three tasks concurrently, queues the fourth and cancels only its waiter", async () => {
  const pool = new TurnPool(3);
  const releases: Array<() => void> = [];
  const started: number[] = [];
  const run = (id: number, signal: AbortSignal) =>
    pool.run(signal, async () => {
      started.push(id);
      await new Promise<void>((resolve) => releases.push(resolve));
      return id;
    });
  const active = [1, 2, 3].map((id) => run(id, new AbortController().signal));
  const cancel = new AbortController();
  const fourth = run(4, cancel.signal);
  const rejection = assert.rejects(fourth, { name: "AbortError" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2, 3]);
  cancel.abort();
  await rejection;
  const fifth = run(5, new AbortController().signal);
  releases.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2, 3, 5]);
  releases.splice(0).forEach((release) => release());
  assert.deepEqual(await Promise.all(active), [1, 2, 3]);
  assert.equal(await fifth, 5);
});
