import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron } from "playwright-core";

const challengePage = `<!doctype html><title>請稍候...</title>
<style>#challenge-running, button { width: 260px; min-height: 40px; }</style>
<main>
  <p>Performing security verification</p>
  <button id="verify">Verify you are human</button>
</main>
<script>
  document.querySelector('#verify').onclick = async () => {
    await fetch('/solve', { method: 'POST' });
    location.reload();
  };
</script>`;

const chatPage = `<!doctype html><title>ChatGPT</title><style>
  button, #prompt-textarea { width: 240px; min-height: 36px; }
</style><main>
  <button data-testid="model-switcher-dropdown-button" aria-haspopup="menu">High</button>
  <div id="prompt-textarea" data-testid="prompt-textarea" contenteditable="true"> </div>
  <button data-testid="send-button">Send</button><div id="messages"></div>
</main><script>
  const picker = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
  const prompt = document.querySelector('#prompt-textarea');
  picker.onclick = () => {
    const existing = document.querySelector('[role="menu"]');
    if (existing) { existing.remove(); return; }
    const menu = document.createElement('div');
    menu.role = 'menu';
    menu.innerHTML = '<button role="menuitemradio">GPT-5</button><button role="menuitem" id="effort"><span role="slider" aria-valuemin="0" aria-valuemax="3" aria-valuenow="2">High</span></button>';
    document.body.append(menu);
  };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') document.querySelector('[role="menu"]')?.remove();
  });
  document.querySelector('[data-testid="send-button"]').onclick = () => {
    void fetch('/sent', { method: 'POST' });
    const user = document.createElement('div');
    user.setAttribute('data-message-author-role', 'user');
    user.textContent = prompt.textContent;
    prompt.textContent = '';
    const reply = document.createElement('div');
    reply.setAttribute('data-testid', 'conversation-turn-1');
    reply.innerHTML = '<div data-message-author-role="assistant">CHALLENGE RECOVERED ONCE</div><button data-testid="copy-turn-button">Copy</button>';
    document.querySelector('#messages').append(user, reply);
  };
</script>`;

let phase = "challenge";
let sends = 0;
let navigations = 0;
let pageSessionChecks = 0;
let nativeSessionChecks = 0;
const server = createServer((request, response) => {
  if (request.url === "/api/auth/session") {
    if (request.headers["sec-fetch-site"] !== "same-origin") {
      nativeSessionChecks += 1;
      response.writeHead(403, {
        "Content-Type": "text/html",
        "cf-mitigated": "challenge",
      });
      response.end("The separate native client was challenged");
      return;
    }
    pageSessionChecks += 1;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ user: { id: "challenge-fixture" } }));
    return;
  }
  if (request.url === "/solve" && request.method === "POST") {
    phase = "blank";
    response.end("ok");
    return;
  }
  if (request.url === "/sent" && request.method === "POST") {
    sends += 1;
    response.end("ok");
    return;
  }
  if (request.url === "/ready") phase = "ready";
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (request.url === "/") navigations += 1;
  response.end(
    phase === "challenge"
      ? challengePage
      : phase === "blank"
        ? "<!doctype html><title>ChatGPT</title><main>Loading</main>"
        : chatPage,
  );
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
const directory = await mkdtemp(join(tmpdir(), "bridge-challenge-e2e-"));
let app;
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [fileURLToPath(new URL("./chatgpt-mode-host.mjs", import.meta.url))],
    env: { ...process.env, CODEXGPT_BRIDGE_DOM_TEST_PROFILE: directory },
  });
  const result = await app.evaluate(
    async ({ BrowserWindow }, fixture) => {
      const controller = new globalThis.ChatGptBrowserController(
        fixture.baseUrl,
        fixture.conversationFile,
      );
      const progress = [];
      try {
        const pending = controller.runTurn({
          operationId: "challenge-e2e",
          threadId: "challenge-e2e",
          prompt: "respond exactly: CHALLENGE RECOVERED ONCE",
          images: [],
          signal: globalThis.AbortSignal.timeout(30_000),
          mode: "high",
          onProgress: (stage) => progress.push(stage),
        });
        const deadline = Date.now() + 10_000;
        while (
          controller.tasks()[0]?.state !== "waiting-challenge" &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
        }
        const task = controller.tasks()[0];
        const window = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().startsWith(fixture.baseUrl),
        );
        const visibleDuringChallenge = window?.isVisible() ?? false;
        const sendsBeforeVerification =
          await window?.webContents.executeJavaScript(
            "document.querySelectorAll('[data-testid=send-button]').length",
          );
        await window?.webContents.executeJavaScript(
          "document.querySelector('#verify').click()",
        );
        await new Promise((resolve) => globalThis.setTimeout(resolve, 1_500));
        const waitingAfterBlank = controller.tasks()[0]?.state;
        const resumedBeforeComposer = progress.includes("resuming_challenge");
        await window.webContents.executeJavaScript(
          "document.title = '請稍候...'; document.body.innerHTML = '<div id=challenge-running style=width:100px;height:40px>Checking</div>'",
        );
        window.hide();
        await new Promise((resolve) => globalThis.setTimeout(resolve, 1_500));
        const visibleAfterRepeatedChallenge = window.isVisible();
        await window.loadURL(fixture.baseUrl + "ready");
        const response = await pending;
        return {
          response,
          progress,
          waitingState: task?.state,
          visibleDuringChallenge,
          sendsBeforeVerification,
          waitingAfterBlank,
          resumedBeforeComposer,
          visibleAfterRepeatedChallenge,
        };
      } finally {
        await controller.close();
      }
    },
    {
      baseUrl,
      conversationFile: join(directory, "conversations.json"),
    },
  );
  await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  assert.equal(result.waitingState, "waiting-challenge");
  assert.equal(result.visibleDuringChallenge, true);
  assert.equal(result.sendsBeforeVerification, 0);
  assert.equal(result.waitingAfterBlank, "waiting-challenge");
  assert.equal(result.resumedBeforeComposer, false);
  assert.equal(result.visibleAfterRepeatedChallenge, false);
  assert.ok(result.progress.includes("waiting_challenge"));
  assert.ok(result.progress.includes("resuming_challenge"));
  assert.equal(result.response, "CHALLENGE RECOVERED ONCE");
  assert.equal(sends, 1);
  assert.equal(nativeSessionChecks, 0);
  assert.ok(pageSessionChecks >= 2);
  phase = "challenge";
  const beforeFailedNavigations = navigations;
  const failed = await app.evaluate(async ({ BrowserWindow }, baseUrl) => {
    const controller = new globalThis.ChatGptBrowserController(baseUrl);
    const input = {
      operationId: "challenge-closed-e2e",
      threadId: "challenge-closed-e2e",
      turnId: "challenge-closed-e2e",
      prompt: "This fixture must never be submitted",
      images: [],
      signal: globalThis.AbortSignal.timeout(20_000),
      mode: "high",
    };
    try {
      const pending = controller.runTurn(input).catch((error) => error);
      const deadline = Date.now() + 10_000;
      while (
        controller.tasks()[0]?.state !== "waiting-challenge" &&
        Date.now() < deadline
      )
        await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().startsWith(baseUrl),
      );
      window.destroy();
      const original = await pending;
      const errors = [];
      for (let retry = 0; retry < 3; retry++) {
        try {
          await controller.runTurn(input);
        } catch (error) {
          errors.push(error === original);
        }
      }
      return {
        sameFailure: errors,
        message: original.message,
        taskWindows: BrowserWindow.getAllWindows().filter((candidate) =>
          candidate.webContents.getURL().startsWith(baseUrl),
        ).length,
      };
    } finally {
      await controller.close();
    }
  }, baseUrl);
  assert.deepEqual(failed.sameFailure, [true, true, true]);
  assert.match(failed.message, /verification window was closed/);
  assert.equal(failed.taskWindows, 0);
  assert.equal(navigations - beforeFailedNavigations, 1);
  assert.equal(sends, 1);
  process.stdout.write(
    "Cloudflare challenge E2E passed: loading documents stayed blocked, repeated challenges did not steal focus, one verified send, and three reconnects preserved the original failure without reopening.\n",
  );
} finally {
  await app?.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
