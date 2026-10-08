import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_SMOKE_EXPECTED,
  completeBrowserSmoke,
  selectBrowserSmokeMode,
} from "./browser-smoke.js";

test("prefers High, uses Luna for Luna accounts and keeps a supported fallback", () => {
  assert.equal(selectBrowserSmokeMode(["instant", "high", "pro"]), "high");
  assert.equal(selectBrowserSmokeMode(["luna", "think"]), "luna");
  assert.equal(selectBrowserSmokeMode(["instant"]), "instant");
  assert.throws(() => selectBrowserSmokeMode([]), /supported model/u);
});

test("accepts only the exact completed smoke response", () => {
  const result = completeBrowserSmoke("high", ` ${BROWSER_SMOKE_EXPECTED}\n`);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "high");
  assert.equal(result.checks.length, 5);
  assert.ok(result.checks.every((check) => check.passed));
  assert.throws(
    () => completeBrowserSmoke("high", "Almost ready"),
    /unexpected answer/u,
  );
  assert.throws(
    () => completeBrowserSmoke("high", { kind: "generated_images" }),
    /non-text/u,
  );
});
