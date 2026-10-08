import assert from "node:assert/strict";
import test from "node:test";
import { validatePasskeyLoginState } from "./passkey-login-state.js";

function cookie(overrides: Record<string, unknown> = {}) {
  return {
    name: "session",
    value: "opaque",
    domain: ".chatgpt.com",
    path: "/",
    expires: 2_000_000_000,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    ...overrides,
  };
}

test("retains only portable ChatGPT/OpenAI passkey state", () => {
  const state = validatePasskeyLoginState({
    cookies: [
      cookie(),
      cookie({ name: "openai", domain: "auth.openai.com", sameSite: "None" }),
      cookie({ name: "google", domain: "accounts.google.com" }),
      cookie({ name: "partitioned", partitionKey: "https://chatgpt.com" }),
    ],
    origins: [
      {
        origin: "https://chatgpt.com",
        localStorage: [{ name: "theme", value: "dark" }],
      },
      {
        origin: "https://accounts.google.com",
        localStorage: [{ name: "identity", value: "excluded" }],
      },
    ],
  });

  assert.deepEqual(
    state.cookies.map((entry) => entry.name),
    ["session", "openai"],
  );
  assert.deepEqual(state.localStorage, [{ name: "theme", value: "dark" }]);
});

test("fails closed without an allowed session cookie", () => {
  assert.throws(
    () =>
      validatePasskeyLoginState({
        cookies: [cookie({ domain: "accounts.google.com" })],
        origins: [],
      }),
    /no ChatGPT\/OpenAI cookies/u,
  );
});

test("rejects malformed allowed-domain cookie fields", () => {
  assert.throws(
    () =>
      validatePasskeyLoginState({
        cookies: [cookie({ path: "/login?redirect=bad" })],
        origins: [],
      }),
    /invalid cookie path/u,
  );
  assert.throws(
    () =>
      validatePasskeyLoginState({
        cookies: [cookie({ sameSite: "Unexpected" })],
        origins: [],
      }),
    /SameSite/u,
  );
});
