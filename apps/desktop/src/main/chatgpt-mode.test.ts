import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  availableBridgeModesFromLabels,
  availableBridgeModesFromSlider,
  planEffortSliderSelection,
} from "./chatgpt-mode.js";

describe("ChatGPT effort slider", () => {
  it("derives only the account modes proven by the slider range", () => {
    assert.deepEqual(availableBridgeModesFromSlider(0, 3), [
      "instant",
      "medium",
      "high",
      "extra-high",
    ]);
    assert.deepEqual(availableBridgeModesFromSlider(2, 6), [
      "instant",
      "medium",
      "high",
      "extra-high",
      "pro",
    ]);
    assert.throws(
      () => availableBridgeModesFromSlider(0, 5),
      /unsupported option count/,
    );
  });

  it("derives enabled plain and Configure labels without inventing Pro", () => {
    assert.deepEqual(
      availableBridgeModesFromLabels([
        "Instant",
        "Standard",
        "Thinking Extended",
        "Heavy",
      ]),
      ["instant", "medium", "high", "extra-high"],
    );
    assert.deepEqual(
      availableBridgeModesFromLabels([
        "即時",
        "中等",
        "高",
        "極高",
        "Pro Research-grade intelligence",
      ]),
      ["instant", "medium", "high", "extra-high", "pro"],
    );
  });

  it("selects Pro at the fifth position and leaves it for normal efforts", () => {
    assert.deepEqual(planEffortSliderSelection("pro", 0, 4, 3), {
      targetValue: 4,
      keys: ["RIGHT"],
    });
    assert.deepEqual(planEffortSliderSelection("high", 0, 4, 4), {
      targetValue: 2,
      keys: ["LEFT", "LEFT"],
    });
    assert.throws(
      () => planEffortSliderSelection("pro", 0, 3, 3),
      /does not expose pro/,
    );
  });
  it("moves left from extra-high to high without relying on Home", () => {
    assert.deepEqual(planEffortSliderSelection("high", 0, 3, 3), {
      targetValue: 2,
      keys: ["LEFT"],
    });
  });

  it("moves relative to non-zero ARIA ranges", () => {
    assert.deepEqual(planEffortSliderSelection("medium", 1, 4, 4), {
      targetValue: 2,
      keys: ["LEFT", "LEFT"],
    });
  });

  it("does nothing when the requested effort is already selected", () => {
    assert.deepEqual(planEffortSliderSelection("extra-high", 0, 3, 3), {
      targetValue: 3,
      keys: [],
    });
  });
});
