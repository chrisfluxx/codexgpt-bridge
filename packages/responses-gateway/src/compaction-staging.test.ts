import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BRIDGE_MAX_COMPACTION_STAGES,
  BridgeCompactionStagingError,
  planBridgeCompactionStages,
} from "./compaction-staging.js";
import type { BridgeContext } from "./prompt.js";

function context(records: readonly string[]): BridgeContext {
  return {
    instructions: "Keep exact identifiers.",
    history: records,
    ledger: records.map((_record, index) => `hash-${index}`),
    images: [],
  };
}

describe("rolling compaction staging", () => {
  it("respects composer characters independently of the context token target", () => {
    const stages = planBridgeCompactionStages(
      context(["x".repeat(1_500), "y".repeat(1_500)]),
      "contract",
      95_000,
      2_400,
    );
    assert.equal(stages.length, 2);
    assert.ok(stages.every((stage) => stage.estimate.textCharacters <= 2_400));
    assert.throws(
      () =>
        planBridgeCompactionStages(
          context(["x".repeat(3_000)]),
          "contract",
          95_000,
          2_400,
        ),
      /character composer limit/,
    );
  });
  it("splits only at records and grows a cumulative receipt context", () => {
    const records = Array.from(
      { length: 9 },
      (_value, index) => `record-${index}:` + " token".repeat(2_500),
    );
    const stages = planBridgeCompactionStages(
      context(records),
      "compaction contract",
      20_000,
    );

    assert.ok(stages.length > 1);
    assert.ok(stages.length <= BRIDGE_MAX_COMPACTION_STAGES);
    assert.deepEqual(stages.at(-1)?.context.history, records);
    for (const [index, stage] of stages.entries()) {
      assert.equal(stage.index, index + 1);
      assert.equal(stage.count, stages.length);
      assert.ok(stage.estimate.total <= 20_000);
      if (index > 0) {
        assert.ok(
          stage.context.history.length >
            (stages[index - 1]?.context.history.length ?? 0),
        );
      }
    }
  });

  it("fails closed when one canonical record cannot fit", () => {
    assert.throws(
      () =>
        planBridgeCompactionStages(
          context([" token".repeat(20_000)]),
          "contract",
          10_000,
        ),
      BridgeCompactionStagingError,
    );
  });

  it("requires an exact record-to-ledger mapping", () => {
    assert.throws(
      () =>
        planBridgeCompactionStages(
          { ...context(["one", "two"]), ledger: ["only-one"] },
          "contract",
          20_000,
        ),
      /one context ledger entry per history record/,
    );
  });
});
