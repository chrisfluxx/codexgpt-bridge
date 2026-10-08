import assert from "node:assert/strict";
import test from "node:test";
import { allowedAuthenticationPopupUrl } from "./authentication-popup.js";

const baseUrl = "https://chatgpt.com/";

test("allows owned ChatGPT and known identity-provider authentication URLs", () => {
  for (const url of [
    "https://chatgpt.com/auth/login",
    "https://chatgpt.com/api/auth/callback/google",
    "https://accounts.google.com/o/oauth2/v2/auth",
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    "https://appleid.apple.com/auth/authorize",
    "https://auth0.openai.com/authorize",
  ]) {
    assert.equal(allowedAuthenticationPopupUrl(url, baseUrl), true, url);
  }
});

test("rejects malformed, insecure and unrelated authentication popup URLs", () => {
  for (const url of [
    "not a url",
    "http://accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com.evil.example/oauth",
    "https://example.com/login",
    "file:///C:/login.html",
  ]) {
    assert.equal(allowedAuthenticationPopupUrl(url, baseUrl), false, url);
  }
});

test("allows the configured loopback origin used by Electron fixtures", () => {
  assert.equal(
    allowedAuthenticationPopupUrl(
      "http://127.0.0.1:7788/auth/provider",
      "http://127.0.0.1:7788/",
    ),
    true,
  );
});
