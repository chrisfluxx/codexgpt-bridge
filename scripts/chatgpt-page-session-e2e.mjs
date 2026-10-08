import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron } from "playwright-core";

let phase = "authenticated";
let nativeChecks = 0;
let pageChecks = 0;
let followedRedirects = 0;
const server = createServer((request, response) => {
  if (request.url === "/redirect-target") followedRedirects += 1;
  if (request.url !== "/api/auth/session") {
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<!doctype html><main><div contenteditable="true"> </div></main>',
    );
    return;
  }
  if (request.headers["sec-fetch-site"] !== "same-origin") {
    nativeChecks += 1;
    response.writeHead(403, {
      "cf-mitigated": "challenge",
      "Content-Type": "text/html",
    });
    response.end("Separate native client challenged");
    return;
  }
  pageChecks += 1;
  if (phase === "challenge") {
    response.writeHead(403, {
      "cf-mitigated": "challenge",
      "Content-Type": "text/html",
    });
    response.end("Page session challenged");
  } else if (phase === "redirect") {
    response.writeHead(302, { location: "/redirect-target" });
    response.end();
  } else if (phase === "large") {
    response.setHeader("Content-Type", "application/json");
    response.write("x".repeat(260 * 1024));
    response.end();
  } else if (phase === "slow") {
    response.setHeader("Content-Type", "application/json");
    response.write('{"user":');
  } else {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        user: { id: "private-page-user", email: "private@example.invalid" },
        account: {
          id: "private-page-account",
          planType: "pro",
          structure: "personal",
        },
        accessToken: "secret-page-token",
      }),
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
const directory = await mkdtemp(join(tmpdir(), "bridge-page-session-e2e-"));
let app;
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [fileURLToPath(new URL("./chatgpt-mode-host.mjs", import.meta.url))],
    env: { ...process.env, CODEXGPT_BRIDGE_DOM_TEST_PROFILE: directory },
  });
  const authenticated = await app.evaluate(
    async ({ BrowserWindow }, fixture) => {
      const probe = globalThis.ChatGptSessionProbe;
      const window = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: true },
      });
      globalThis.pageSessionWindow = window;
      await window.loadURL(fixture.baseUrl);
      let nativeError;
      try {
        await probe.probeChatGptServerSession(
          fixture.baseUrl,
          (url, init) => window.webContents.session.fetch(url, init),
          globalThis.AbortSignal.timeout(5_000),
        );
      } catch (error) {
        nativeError = { code: error.code, retryable: error.retryable };
      }
      let safeIpc = true;
      const result = await probe.probeChatGptPageSession(
        fixture.baseUrl,
        {
          getURL: () => window.webContents.getURL(),
          executeJavaScript: async (code) => {
            const result = await window.webContents.executeJavaScript(code);
            const serialized = JSON.stringify(result);
            if (
              serialized?.includes("secret-page-token") ||
              serialized?.includes("private@example.invalid")
            )
              safeIpc = false;
            return result;
          },
        },
        globalThis.AbortSignal.timeout(5_000),
      );
      return { result, nativeError, safeIpc };
    },
    { baseUrl },
  );
  assert.deepEqual(authenticated.nativeError, {
    code: "chatgpt_web_session_unavailable",
    retryable: true,
  });
  assert.equal(authenticated.result.verified, true);
  assert.equal(authenticated.result.usageAccount.plan, "pro_200");
  assert.equal(authenticated.result.usageAccount.accountKey.length, 64);
  assert.equal(authenticated.safeIpc, true);
  assert.equal(
    JSON.stringify(authenticated.result).includes("private-page"),
    false,
  );
  assert.equal(nativeChecks, 1);
  assert.equal(pageChecks, 1);

  for (const next of ["challenge", "redirect", "large", "slow"]) {
    phase = next;
    const result = await app.evaluate(
      async (_, fixture) => {
        const probe = globalThis.ChatGptSessionProbe;
        try {
          await probe.probeChatGptPageSession(
            fixture.baseUrl,
            globalThis.pageSessionWindow.webContents,
            globalThis.AbortSignal.timeout(5_000),
            { timeoutMs: 150 },
          );
          return { accepted: true };
        } catch (error) {
          return { code: error.code, retryable: error.retryable };
        }
      },
      { baseUrl },
    );
    assert.deepEqual(
      result,
      { code: "chatgpt_web_session_unavailable", retryable: true },
      next,
    );
  }
  assert.equal(followedRedirects, 0);
  const checksBeforeForeignPage = pageChecks;
  const foreign = await app.evaluate(
    async (_, fixture) => {
      const probe = globalThis.ChatGptSessionProbe;
      const window = globalThis.pageSessionWindow;
      await window.loadURL("about:blank");
      let errorCode;
      try {
        await probe.probeChatGptPageSession(
          fixture.baseUrl,
          {
            getURL: () => fixture.baseUrl,
            executeJavaScript: (code) =>
              window.webContents.executeJavaScript(code),
          },
          globalThis.AbortSignal.timeout(5_000),
        );
      } catch (error) {
        errorCode = error.code;
      }
      return errorCode;
    },
    { baseUrl },
  );
  assert.equal(foreign, "chatgpt_web_session_unavailable");
  assert.equal(pageChecks, checksBeforeForeignPage);
  assert.equal(nativeChecks, 1);
  process.stdout.write(
    "Page session E2E passed: native request challenged, same-page session accepted, credentials kept in page, challenge classified without logout, redirects rejected, body bounded, stream timed out, and foreign document rejected.\n",
  );
} finally {
  await app?.close().catch(() => undefined);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 30,
    retryDelay: 100,
  });
}
