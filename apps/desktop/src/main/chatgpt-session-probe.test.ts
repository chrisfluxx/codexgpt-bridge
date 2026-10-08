import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ChatGptSessionError,
  probeChatGptServerSession,
  type ChatGptSessionFetch,
} from "./chatgpt-session-probe.js";

const signal = (): AbortSignal => new AbortController().signal;
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("ChatGPT server session probe", () => {
  it("uses the same-origin session endpoint and cookie credentials without exposing identity", async () => {
    let called:
      { readonly url: string; readonly init: RequestInit } | undefined;
    const result = await probeChatGptServerSession(
      "https://chatgpt.com/c/retained",
      async (url, init) => {
        called = { url, init };
        return json({ user: { id: "private-user" }, accessToken: "secret" });
      },
      signal(),
    );
    assert.deepEqual(result, { verified: true });
    assert.equal(called?.url, "https://chatgpt.com/api/auth/session");
    assert.equal(called?.init.method, "GET");
    assert.equal(called?.init.credentials, "include");
    assert.equal(called?.init.redirect, "manual");
    assert.equal(JSON.stringify(result).includes("private-user"), false);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  });

  it("exports only a hashed account key and canonical usage plan", async () => {
    const result = await probeChatGptServerSession(
      "https://chatgpt.com/",
      async () =>
        json({
          user: { id: "private-user" },
          account: {
            id: "private-account",
            planType: "prolite",
            structure: "personal",
            isDelinquent: false,
          },
          accessToken: "secret",
        }),
      signal(),
    );
    assert.equal(result.usageAccount?.accountKey.length, 64);
    assert.equal(result.usageAccount?.plan, "pro_100");
    assert.equal(result.usageAccount?.personal, true);
    assert.equal(result.usageAccount?.needsAttention, false);
    assert.equal(JSON.stringify(result).includes("private-user"), false);
    assert.equal(JSON.stringify(result).includes("private-account"), false);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  });

  it("treats an empty session and authentication statuses as expired", async () => {
    for (const response of [
      json({}),
      json({ user: {} }),
      json({}, 401),
      json({}, 403),
    ]) {
      await assert.rejects(
        probeChatGptServerSession(
          "https://chatgpt.com/",
          async () => response,
          signal(),
        ),
        (error: unknown) =>
          error instanceof ChatGptSessionError &&
          error.code === "chatgpt_web_session_expired" &&
          error.retryable === false,
      );
    }
  });

  it("keeps Cloudflare challenges distinct from an expired login", async () => {
    for (const status of [200, 403]) {
      await assert.rejects(
        probeChatGptServerSession(
          "https://chatgpt.com/",
          async () =>
            new Response("Cloudflare challenge", {
              status,
              headers: {
                "content-type": "text/html",
                "cf-mitigated": "challenge",
              },
            }),
          signal(),
        ),
        { code: "chatgpt_web_session_unavailable", retryable: true },
      );
    }
  });

  it("recognizes a same-origin login redirect as an expired session", async () => {
    await assert.rejects(
      probeChatGptServerSession(
        "https://chatgpt.com/",
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "/auth/login" },
          }),
        signal(),
      ),
      { code: "chatgpt_web_session_expired", retryable: false },
    );
  });

  it("keeps transient, malformed, and cross-origin failures distinct from logout", async () => {
    const failures: ChatGptSessionFetch[] = [
      async () => json({}, 503),
      async () =>
        new Response("login", {
          headers: { "content-type": "text/html" },
        }),
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://example.com/login" },
        }),
      async () => {
        throw new Error("offline");
      },
    ];
    for (const fetcher of failures) {
      await assert.rejects(
        probeChatGptServerSession("https://chatgpt.com/", fetcher, signal()),
        (error: unknown) =>
          error instanceof ChatGptSessionError &&
          error.code === "chatgpt_web_session_unavailable" &&
          error.retryable === true,
      );
    }
  });

  it("bounds response bodies and respects caller cancellation", async () => {
    await assert.rejects(
      probeChatGptServerSession(
        "https://chatgpt.com/",
        async () =>
          new Response("x".repeat(256 * 1024 + 1), {
            headers: { "content-type": "application/json" },
          }),
        signal(),
      ),
      { code: "chatgpt_web_session_unavailable" },
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      probeChatGptServerSession(
        "https://chatgpt.com/",
        async () => {
          throw new Error("should preserve cancellation");
        },
        controller.signal,
      ),
      { name: "AbortError" },
    );
  });

  it("hard-times out fetchers and response streams that ignore abort", async () => {
    const keepAlive = setTimeout(() => undefined, 1_000);
    try {
      await assert.rejects(
        probeChatGptServerSession(
          "https://chatgpt.com/",
          async () => await new Promise<Response>(() => undefined),
          signal(),
          { timeoutMs: 20 },
        ),
        (error: unknown) =>
          error instanceof ChatGptSessionError &&
          error.code === "chatgpt_web_session_unavailable" &&
          error.retryable === true &&
          /timed out/i.test(error.message),
      );

      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"user":'));
        },
        cancel() {
          cancelled = true;
        },
      });
      await assert.rejects(
        probeChatGptServerSession(
          "https://chatgpt.com/",
          async () =>
            new Response(body, {
              headers: { "content-type": "application/json" },
            }),
          signal(),
          { timeoutMs: 20 },
        ),
        (error: unknown) =>
          error instanceof ChatGptSessionError &&
          error.code === "chatgpt_web_session_unavailable" &&
          error.retryable === true &&
          /timed out/i.test(error.message),
      );
      assert.equal(cancelled, true);
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it("skips only non-network DOM fixtures", async () => {
    let called = false;
    const result = await probeChatGptServerSession(
      "data:text/html,<main></main>",
      async () => {
        called = true;
        return json({ user: { id: "fixture" } });
      },
      signal(),
    );
    assert.deepEqual(result, {
      verified: false,
      reason: "non-network-fixture",
    });
    assert.equal(called, false);
  });
});
