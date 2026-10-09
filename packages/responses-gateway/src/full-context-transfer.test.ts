import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { planFullContextTransfer } from "./full-context-transfer.js";
import { estimateBridgeTextTokens } from "./input-tokens.js";
import { FullTurnBroker } from "./full-turn-broker.js";
import { buildStartupModelsPayload } from "./responses-server.js";
import { prepareBridgeWebTurn } from "./tool-protocol.js";
import { compileResponsesPrompt } from "./prompt.js";

const operation = "a".repeat(64);

it("keeps a queued invocation undelivered until a Codex observer consumes it", async () => {
  const broker = new FullTurnBroker();
  const tools = prepareBridgeWebTurn(
    compileResponsesPrompt({
      input: "work",
      tools: [
        {
          type: "function",
          name: "read_file",
          parameters: { type: "object", properties: {} },
        },
      ],
    }),
  ).tools;
  const token = broker.register("queued-delivery-proof", tools, false);
  try {
    const pending = broker.invoke(token, "read_file", { arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(broker.outstanding(token), []);
    const delivered = await broker.nextBatch(token);
    assert.equal(delivered.length, 1);
    assert.equal(broker.outstanding(token).length, 1);
    broker.complete(token, delivered[0]!.callId, {
      content: [{ type: "text", text: "read" }],
    });
    await pending;
  } finally {
    broker.revoke(token);
  }
});
const contract = `Execution contract. Call tools with turn_${"b".repeat(43)} only after commit.`;
const chunkOf = (text: string): string =>
  JSON.parse(text.split("\n").find((line) => line.startsWith('{"version":1'))!)
    .chunk as string;

it("preserves Unicode, record order, exact acknowledgements and final-only capabilities", () => {
  const source =
    "[Instructions]\n" +
    '甲乙丙丁😀"\\\n'.repeat(600) +
    "[Current request] execute this last";
  const limits = {
    messageTokens: 2_048,
    messageCharacters: 5_000,
    transactionTokens: 30_000,
    imageTokens: 200,
    platformTokens: 8_192,
  };
  const transfer = planFullContextTransfer(source, contract, operation, limits);
  assert.ok(transfer.total >= 2 && transfer.total <= 6);
  assert.equal(
    [...transfer.stages, transfer.commit]
      .map((part) => chunkOf(part.text))
      .join(""),
    source,
  );
  for (let index = 0; index < transfer.stages.length; index++) {
    const stage = transfer.stages[index]!;
    assert.equal(
      stage.digest,
      createHash("sha256").update(chunkOf(stage.text)).digest("hex"),
    );
    assert.equal(
      stage.acknowledgement,
      `BRIDGE_CONTEXT_ACK ${transfer.transactionId} ${index + 1}/${transfer.total} ${stage.digest}`,
    );
    assert.doesNotMatch(stage.text, /turn_b+/);
    assert.ok(estimateBridgeTextTokens(stage.text) <= limits.messageTokens);
    assert.ok(stage.text.length <= limits.messageCharacters);
    assert.doesNotMatch(chunkOf(stage.text), /[\uD800-\uDBFF]$/);
  }
  assert.match(transfer.commit.text, /turn_b+/);
  assert.ok(
    estimateBridgeTextTokens(transfer.commit.text) + limits.imageTokens <=
      limits.messageTokens,
  );
  assert.ok(transfer.transactionTokens <= limits.transactionTokens);
  assert.deepEqual(
    planFullContextTransfer(source, contract, operation, limits),
    transfer,
  );
});

it("fails before any send for too many parts, oversized final contract, images or transaction", () => {
  const limits = {
    messageTokens: 2_048,
    messageCharacters: 3_000,
    transactionTokens: 30_000,
    imageTokens: 0,
    platformTokens: 8_192,
  };
  assert.throws(
    () =>
      planFullContextTransfer("q".repeat(20_000), contract, operation, {
        ...limits,
        messageCharacters: 1_000,
      }),
    /more than six|cannot fit/,
  );
  assert.throws(
    () =>
      planFullContextTransfer(
        "q".repeat(7_000),
        "contract".repeat(1_000),
        operation,
        limits,
      ),
    /more than six|cannot fit/,
  );
  assert.throws(
    () =>
      planFullContextTransfer("q".repeat(7_000), contract, operation, {
        ...limits,
        imageTokens: 2_048,
      }),
    /more than six|cannot fit/,
  );
  assert.throws(
    () =>
      planFullContextTransfer("q".repeat(7_000), contract, operation, {
        ...limits,
        transactionTokens: 100,
      }),
    /context budget/,
  );
});

it("withholds the actual broker tool surface through staging and opens it only for commit", async () => {
  const broker = new FullTurnBroker();
  const compiled = compileResponsesPrompt({
    model: "codexgpt-bridge/high",
    input: "test",
    tools: [
      {
        type: "function",
        name: "write_file",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  });
  const tools = prepareBridgeWebTurn(compiled).tools;
  const token = broker.register("context-transfer-owner", tools, false);
  broker.beginContextStaging(token);
  assert.equal(broker.inventory(token).total, 0);
  assert.equal(
    (await broker.invoke(token, "write_file", { arguments: {} })).isError,
    true,
  );
  assert.deepEqual(broker.outstanding(token), []);
  broker.commitContextStaging(token);
  assert.equal(broker.inventory(token).total, 1);
  const effect = broker.invoke(token, "write_file", { arguments: {} });
  const batch = await broker.nextBatch(token);
  assert.equal(batch.length, 1);
  broker.complete(token, batch[0]!.callId, {
    content: [{ type: "text", text: "done" }],
  });
  assert.equal((await effect).isError, undefined);
  assert.throws(
    () => broker.beginContextStaging(token),
    /cannot start after tool execution/,
  );
  broker.revoke(token);
});

it("advertises a real threefold transaction while leaving per-message boundaries unchanged", () => {
  const result = buildStartupModelsPayload(
    { models: [{ slug: "native", base_instructions: "native instructions" }] },
    ["medium", "high", "extra-high", "pro"],
    "pro",
    ["5.6", "6"],
  ) as { models: Array<Record<string, unknown>> };
  const base = result.models.find(
    (row) => row.slug === "codexgpt-bridge/gpt-6-pro",
  )!;
  const bigger = result.models.find(
    (row) => row.slug === "codexgpt-bridge/gpt-6-pro-3x",
  )!;
  assert.equal(bigger.context_window, (base.context_window as number) * 3);
  assert.equal(
    bigger.auto_compact_token_limit,
    (base.auto_compact_token_limit as number) * 3,
  );
  assert.equal(bigger.default_reasoning_level, "max");
});
