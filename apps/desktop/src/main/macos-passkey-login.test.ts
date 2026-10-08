import assert from "node:assert/strict";
import test from "node:test";
import { MacOsPasskeyLogin } from "./macos-passkey-login.js";

test("advertises passkey-assisted login only on macOS", () => {
  assert.deepEqual(
    new MacOsPasskeyLogin("/unused", "darwin", "/unused/chrome").status(),
    { available: true, phase: "idle" },
  );
  assert.deepEqual(
    new MacOsPasskeyLogin("C:\\unused", "win32", "C:\\chrome.exe").status(),
    { available: false, phase: "idle" },
  );
});

test("rejects direct passkey capture outside macOS", async () => {
  const login = new MacOsPasskeyLogin("C:\\unused", "win32", "C:\\chrome.exe");
  await assert.rejects(login.begin(), /available only on macOS/u);
});
