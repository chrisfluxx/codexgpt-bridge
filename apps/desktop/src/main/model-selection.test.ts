import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isModeOnlySelectionVerified,
  modelLabelsEqual,
  modelPreference,
  modelSelectionLabelMatches,
  nativeModelDescriptionsMatch,
  verifyModelSelection,
  type ModelUiObservation,
} from "./model-selection.js";
import { ModelReceiptStore } from "./model-receipts.js";
import type { BridgeExecutionPreflight } from "@codexgpt-bridge/responses-gateway";

const high: ModelUiObservation = {
  model: "GPT-5.6 Sol",
  mode: "high",
  modeLabel: "High",
  surface: "direct",
  availableModels: ["GPT-5.6 Sol"],
  ambiguous: false,
  disabled: false,
};

it("requires both a checked native family and the exact active version description", () => {
  const observed = {
    ...high,
    modelDescriptions: ["GPT-5.6 Sol Thinking, current effort"],
  };
  assert.equal(
    verifyModelSelection("op", "high", "bridge-native:5.6", observed)
      .confidence,
    "UI_VERIFIED",
  );
  for (const candidate of [
    { ...observed, model: "Latest" },
    { ...observed, modelDescriptions: [] },
    {
      ...observed,
      modelDescriptions: ["GPT-6 Astra Thinking, current effort"],
    },
    {
      ...observed,
      modelDescriptions: ["GPT-5.6 Sol Thinking", "GPT-6 Astra Thinking"],
    },
    { ...observed, mode: null },
  ])
    assert.equal(
      verifyModelSelection("op", "high", "bridge-native:5.6", candidate)
        .confidence,
      "REJECTED",
    );
  assert.equal(modelSelectionLabelMatches("bridge-native:6", "最新的"), true);
  assert.equal(modelSelectionLabelMatches("bridge-native:6", "GPT-7"), false);
  assert.equal(
    nativeModelDescriptionsMatch("bridge-native:6", "medium", [
      "5.6 Sol Thinking, Medium",
    ]),
    true,
  );
  assert.equal(
    nativeModelDescriptionsMatch("bridge-native:6", "pro", [
      "6 Astra Pro, max",
    ]),
    true,
  );
  assert.equal(
    nativeModelDescriptionsMatch("bridge-native:6", "pro", [
      "7 Astra Pro, max",
    ]),
    false,
  );
  assert.equal(
    nativeModelDescriptionsMatch("bridge-native:6", "pro", [
      "5.6 Sol Pro, max",
    ]),
    false,
  );
});

it("distinguishes UI evidence from backend evidence and effort-only evidence", () => {
  const receipt = verifyModelSelection("op", "high", "GPT-5.6 Sol", high);
  assert.equal(receipt.confidence, "UI_VERIFIED");
  assert.equal(receipt.backendIdentity, "NOT_OBSERVED");
  assert.equal(
    verifyModelSelection("op", "high", "", { ...high, model: null }).confidence,
    "EFFORT_VERIFIED",
  );
  assert.equal(
    verifyModelSelection("op", "high", "GPT-5.6 Sol", { ...high, model: null })
      .confidence,
    "REJECTED",
  );
});

it("attaches bounded gateway preflight evidence to the model receipt", () => {
  const execution: BridgeExecutionPreflight = {
    version: 1,
    route: "codexgpt-bridge/high",
    mode: "high",
    operationToolTransport: "full",
    toolTransport: "full",
    attempt: "initial",
    toolCount: 3,
    sourceContextTokens: 21_000,
    inputBasis: "full-context",
    inputTokens: 21_000,
    textTokens: 12_000,
    textCharacters: 48_000,
    imageCount: 0,
    imageReserveTokens: 0,
    platformReserveTokens: 8_192,
    contextWindow: 95_000,
    autoCompactTokenLimit: 90_000,
    hardInputTokenLimit: 95_000,
    remainingInputTokens: 74_000,
    status: "within-limit",
    budgetProfile: "bridge-safe-v1",
  };

  const receipt = verifyModelSelection(
    "op",
    "high",
    "GPT-5.6 Sol",
    high,
    execution,
  );
  assert.deepEqual(receipt.execution, execution);
  assert.doesNotMatch(JSON.stringify(receipt.execution), /prompt|cookie|url/i);
});

it("accepts a scoped composer effort without opening a flaky picker", () => {
  const effortOnly = { ...high, model: null, surface: "legacy" as const };
  assert.equal(isModeOnlySelectionVerified("high", "", effortOnly), true);
  assert.equal(
    isModeOnlySelectionVerified("high", "GPT-5.6 Sol", effortOnly),
    false,
  );
  assert.equal(isModeOnlySelectionVerified("medium", "", effortOnly), false);
  assert.equal(
    isModeOnlySelectionVerified("high", "", {
      ...effortOnly,
      surface: "missing",
    }),
    false,
  );
});

it("rejects wrong families, wrong effort, ambiguous controls and disabled selection", () => {
  for (const observed of [
    { ...high, model: "GPT-5.5" },
    { ...high, mode: "medium" as const },
    { ...high, ambiguous: true },
    { ...high, disabled: true },
  ])
    assert.equal(
      verifyModelSelection("op", "high", "GPT-5.6 Sol", observed).confidence,
      "REJECTED",
    );
  assert.equal(
    verifyModelSelection("op", "high", "5.6 Sol", high).confidence,
    "UI_VERIFIED",
  );
  assert.equal(
    verifyModelSelection("op", "high", "5.6", high).confidence,
    "REJECTED",
  );
});

it("validates preferences without accepting script or control text", () => {
  assert.equal(modelPreference(undefined), "");
  assert.equal(modelPreference(" GPT-6 Astra "), "GPT-6 Astra");
  for (const input of [false, "line\nline", "<script>", "x".repeat(121)])
    assert.throws(() => modelPreference(input));
});

it("serializes model evidence writes, persists across reopening, and bounds retention", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-model-receipts-"));
  try {
    const path = join(directory, "evidence.json");
    const store = new ModelReceiptStore(path);
    await Promise.all(
      Array.from({ length: 205 }, (_, i) =>
        store.record(verifyModelSelection(`op-${i}`, "high", "", high)),
      ),
    );
    const completed = {
      ...verifyModelSelection("op-204", "high", "", high),
      phase: "completed" as const,
    };
    await new ModelReceiptStore(path).record(completed);
    const text = await readFile(path, "utf8");
    const rows = JSON.parse(text) as Array<{
      operationId: string;
      phase: string;
    }>;
    assert.equal(rows.length, 200);
    assert.equal(rows.at(-1)?.phase, "completed");
    assert.equal(rows.filter((row) => row.operationId === "op-204").length, 1);
    assert.doesNotMatch(text, /prompt|cookie|authorization/i);
    const usage = await store.summary();
    assert.equal(usage.retainedOperations, 200);
    assert.equal(usage.completedOperations, 1);
    assert.equal(usage.failedOperations, 0);
    assert.equal(usage.pendingOperations, 199);
    assert.deepEqual(usage.byMode.high, { operations: 200, completed: 1 });
    assert.equal(usage.retentionLimit, 200);
    assert.equal(usage.officialQuotaObserved, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("matches model labels while stripping subtext and retirement notices", () => {
  assert.equal(
    modelLabelsEqual("GPT-5.5", "GPT-5.5\n即將於10月14日下線"),
    true,
  );
  assert.equal(modelLabelsEqual("GPT-5.6 Sol", "5.6 Sol"), true);
  assert.equal(modelLabelsEqual("最新模型", "最新模型"), true);
});

it("requires an explicit Sol 6.1 family and active version evidence before Send", () => {
  const sol61 = {
    ...high,
    model: "GPT-6.1 Sol",
    modelDescriptions: ["GPT-6.1 Sol Thinking, High"],
  };
  assert.equal(
    verifyModelSelection("op61", "high", "bridge-native:6.1", sol61).confidence,
    "UI_VERIFIED",
  );
  for (const observed of [
    { ...sol61, model: "Latest" },
    { ...sol61, modelDescriptions: ["GPT-6 Sol Thinking, High"] },
    { ...sol61, modelDescriptions: ["GPT-6.1 Astra Thinking, High"] },
    { ...sol61, modelDescriptions: [] },
    {
      ...sol61,
      mode: "pro" as const,
      modelDescriptions: ["GPT-6 Astra Pro, max"],
    },
  ])
    assert.equal(
      verifyModelSelection(
        "op61",
        observed.mode!,
        "bridge-native:6.1",
        observed,
      ).confidence,
      "REJECTED",
    );
});
