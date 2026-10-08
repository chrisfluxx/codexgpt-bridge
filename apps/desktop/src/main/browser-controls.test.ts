import assert from "node:assert/strict";
import test from "node:test";
import {
  browserZoomPercent,
  nextBrowserZoomFactor,
} from "./browser-controls.js";

test("steps, resets and bounds browser zoom", () => {
  assert.equal(nextBrowserZoomFactor(1, "in"), 1.1);
  assert.equal(nextBrowserZoomFactor(1, "out"), 0.9);
  assert.equal(nextBrowserZoomFactor(1.7, "reset"), 1);
  assert.equal(nextBrowserZoomFactor(2, "in"), 2);
  assert.equal(nextBrowserZoomFactor(0.5, "out"), 0.5);
  assert.equal(browserZoomPercent(1.249), 125);
});
