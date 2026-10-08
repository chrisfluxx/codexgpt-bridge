import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron } from "playwright-core";

const chatPage = `<!doctype html><title>ChatGPT backend fixture</title><style>
  button, #prompt-textarea { width: 240px; min-height: 36px; }
</style><main>
  <button data-testid="model-switcher-dropdown-button" aria-haspopup="menu">High</button>
  <div id="prompt-textarea" data-testid="prompt-textarea" contenteditable="true"> </div>
  <button data-testid="send-button">Send</button><div id="messages"></div>
</main><script>
  window.fixtureDocument = String(Math.random());
  window.fixtureSessionVerified = false;
  const pageFetch = fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await pageFetch(input, init);
    if (new URL(input, location.href).pathname === '/api/auth/session')
      window.fixtureSessionVerified = response.ok;
    return response;
  };
  window.bootstrap = fetch('/backend-api/bootstrap');
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
  document.querySelector('[data-testid="send-button"]').onclick = async () => {
    const user = document.createElement('div');
    user.setAttribute('data-message-author-role', 'user');
    user.textContent = prompt.textContent;
    prompt.textContent = '';
    document.querySelector('#messages').append(user);
    const response = await fetch('/backend-api/conversation', { method: 'POST' });
    if (!response.ok) return;
    const reply = document.createElement('div');
    reply.setAttribute('data-testid', 'conversation-turn-1');
    reply.innerHTML = '<div data-message-author-role="assistant">BACKEND RECOVERED ONCE</div><button data-testid="copy-turn-button">Copy</button>';
    document.querySelector('#messages').append(reply);
  };
</script>`;

let phase;
let navigations;
let bootstrapChecks;
let sessionChecks;
let sends;
const challenge = (response) => {
  response.writeHead(403, {
    "Content-Type": "text/html",
    "cf-mitigated": "challenge",
  });
  response.end("Security verification required");
};
const server = createServer((request, response) => {
  if (request.url === "/slow-initial-load") {
    globalThis.setTimeout(() => response.end(""), 2_000);
    return;
  }
  if (request.url === "/api/auth/session") {
    sessionChecks += 1;
    if (phase === "session-once" && sessionChecks === 1) {
      challenge(response);
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ user: { id: "backend-fixture" } }));
    return;
  }
  if (request.url === "/backend-api/bootstrap") {
    bootstrapChecks += 1;
    if (
      phase === "persistent" ||
      (["recover-once", "initial-navigation"].includes(phase) &&
        bootstrapChecks === 1)
    ) {
      challenge(response);
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.statusCode = phase === "ordinary-403" ? 403 : 200;
    response.end("{}");
    return;
  }
  if (request.url === "/backend-api/conversation") {
    sends += 1;
    if (phase === "after-send") {
      challenge(response);
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end("{}");
    return;
  }
  if (request.url.split("?")[0] === "/") navigations += 1;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(
    chatPage +
      (phase === "initial-navigation" && navigations === 1
        ? '<img src="/slow-initial-load">'
        : ""),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
const directory = await mkdtemp(join(tmpdir(), "bridge-backend-recovery-e2e-"));
const controllerArgument = process.argv.find((value) =>
  value.startsWith("--controller="),
);
const caseArgument = process.argv.find((value) => value.startsWith("--case="));
let app;
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [
      fileURLToPath(
        new URL("./chatgpt-backend-recovery-host.mjs", import.meta.url),
      ),
    ],
    env: {
      ...process.env,
      CODEXGPT_BRIDGE_DOM_TEST_PROFILE: directory,
      ...(controllerArgument
        ? {
            CODEXGPT_BRIDGE_BACKEND_TEST_CONTROLLER: controllerArgument.slice(
              "--controller=".length,
            ),
          }
        : {}),
    },
  });
  if (process.argv.includes("--trace"))
    app.process().stdout.on("data", (chunk) => process.stdout.write(chunk));
  const cases = caseArgument
    ? [caseArgument.slice("--case=".length)]
    : [
        "recover-once",
        "initial-navigation",
        "persistent",
        "ordinary-403",
        "session-once",
        "after-send",
      ];
  for (const next of cases) {
    phase = next;
    navigations = bootstrapChecks = sessionChecks = sends = 0;
    const result = await app.evaluate(
      async ({ BrowserWindow }, fixture) => {
        const controller = new globalThis.ChatGptBrowserController(
          fixture.baseUrl,
          fixture.conversationFile,
        );
        const input = {
          operationId: fixture.phase,
          threadId: fixture.phase,
          turnId: fixture.phase,
          prompt: "respond exactly: BACKEND RECOVERED ONCE",
          images: [],
          signal: globalThis.AbortSignal.timeout(30_000),
          mode: "high",
        };
        try {
          let text;
          let failure;
          try {
            if (fixture.phase === "initial-navigation") {
              if (fixture.trace)
                globalThis.console.log("initial-navigation: opening login");
              await controller.openLoginWindow();
              if (fixture.trace)
                globalThis.console.log(
                  "initial-navigation: refreshing account",
                );
              await controller.refreshUsageAccount();
              const status = await controller.status();
              text = status.signedIn ? "LOGIN RECOVERY READY" : undefined;
            } else {
              text = await controller.runTurn(input);
            }
          } catch (error) {
            failure = error;
          }
          const sameFailure = [];
          if (fixture.phase === "after-send" && failure) {
            for (let i = 0; i < 3; i++) {
              try {
                await controller.runTurn(input);
              } catch (error) {
                sameFailure.push(error === failure);
              }
            }
          }
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().startsWith(fixture.baseUrl),
          );
          return {
            text,
            error: failure
              ? {
                  message: failure.message,
                  code: failure.code,
                  stack: failure.stack,
                }
              : undefined,
            sameFailure,
            windowPreserved: Boolean(window && !window.isDestroyed()),
          };
        } finally {
          await controller.close();
        }
      },
      {
        baseUrl,
        phase,
        conversationFile: join(directory, `${phase}.json`),
        trace: process.argv.includes("--trace"),
      },
    );
    if (phase === "initial-navigation") {
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.equal(result.text, "LOGIN RECOVERY READY");
      assert.equal(navigations, 2);
      assert.equal(sends, 0);
    } else if (phase === "persistent") {
      assert.equal(result.error?.code, "chatgpt_web_session_unavailable");
      assert.equal(navigations, 2);
      assert.equal(sends, 0);
    } else if (phase === "after-send") {
      assert.equal(result.error?.code, "chatgpt_web_session_unavailable");
      assert.deepEqual(result.sameFailure, [true, true, true]);
      assert.equal(navigations, 1);
      assert.equal(sends, 1);
      assert.equal(result.windowPreserved, true);
    } else {
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.equal(result.text, "BACKEND RECOVERED ONCE");
      assert.equal(navigations, phase === "ordinary-403" ? 1 : 2);
      assert.equal(sends, 1);
    }
    process.stdout.write(
      `${phase}: passed; navigations=${navigations}, sends=${sends}\n`,
    );
  }
  if (!caseArgument) {
    phase = "clear";
    await app.evaluate(
      async ({ BrowserWindow }, fixture) => {
        const first = new globalThis.ChatGptBrowserController(
          fixture.baseUrl,
          fixture.firstFile,
        );
        const second = new globalThis.ChatGptBrowserController(
          fixture.baseUrl,
          fixture.secondFile,
        );
        await first.openLoginWindow();
        await second.openLoginWindow();
        const windows = BrowserWindow.getAllWindows().filter((candidate) =>
          candidate.webContents.getURL().startsWith(fixture.baseUrl),
        );
        for (const window of windows)
          await window.webContents.executeJavaScript("window.bootstrap");
        await first.close();
        const window = windows.find((candidate) => !candidate.isDestroyed());
        await window.loadURL(fixture.baseUrl + "?retained=1");
        await window.webContents.executeJavaScript(
          "window.bootstrap.then(() => { localStorage.setItem('backend-fixture', 'kept'); document.cookie = 'backend_fixture=kept; Path=/'; })",
        );
        globalThis.backendSharedFixture = { second, window };
      },
      {
        baseUrl,
        firstFile: join(directory, "shared-first.json"),
        secondFile: join(directory, "shared-second.json"),
      },
    );
    phase = "recover-once";
    navigations = bootstrapChecks = sessionChecks = sends = 0;
    const shared = await app.evaluate(async () => {
      const { second, window } = globalThis.backendSharedFixture;
      try {
        const originalDocument = await window.webContents.executeJavaScript(
          "window.fixtureDocument",
        );
        await window.webContents.executeJavaScript(
          "fetch('/backend-api/bootstrap')",
        );
        const deadline = Date.now() + 10_000;
        let verified = false;
        while (Date.now() < deadline) {
          verified = await window.webContents
            .executeJavaScript(
              `window.fixtureDocument !== ${JSON.stringify(originalDocument)} && window.fixtureSessionVerified === true`,
            )
            .catch(() => false);
          if (verified) break;
          await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
        }
        const storage = await window.webContents.executeJavaScript(
          "({ cookie: document.cookie, storage: localStorage.getItem('backend-fixture') })",
        );
        return { verified, url: window.webContents.getURL(), ...storage };
      } finally {
        await second.close();
        delete globalThis.backendSharedFixture;
      }
    });
    assert.equal(navigations, 1);
    assert.equal(bootstrapChecks, 2);
    assert.ok(sessionChecks > 0);
    assert.equal(sends, 0);
    assert.equal(shared.verified, true);
    assert.equal(shared.url, baseUrl + "?retained=1");
    assert.equal(shared.storage, "kept");
    assert.match(shared.cookie, /backend_fixture=kept/);
    process.stdout.write(
      "shared-session idle recovery: passed; one refresh, exact URL and login storage preserved after another owner closed\n",
    );
  }
} finally {
  await app?.close().catch(() => undefined);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  // mkdtemp owns this directory; never remove the persistent login profile.
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 30,
    retryDelay: 100,
  });
}
