import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron } from "playwright-core";
import {
  acknowledgeChatGptRateLimitDialog,
  observeChatGptPageBlock,
  observeChatGptServerSessionNotice,
} from "../apps/desktop/dist/main/chatgpt-page-access.js";

function fixture({
  sidebar = false,
  missing = false,
  overlay = false,
  rate = false,
  pin = false,
  quoted = false,
  afterFill = false,
  dedicated = false,
  lateRate = false,
  rateWithAnswer = false,
  terminalStaleStop = false,
} = {}) {
  return `<!doctype html><body>
    <aside>${sidebar ? '<button data-tone="neutral" aria-haspopup="menu" onclick="window.pinClicks++">High</button>' : ""}</aside>
    <button aria-label="ChatGPT model pin" onclick="window.pinClicks++">ChatGPT Pro</button>
    <main><form onsubmit="return false">
      <div id="prompt-textarea" contenteditable="true" style="width:500px;min-height:40px"></div>
      ${missing ? "" : `<button type="button" id="picker" ${dedicated ? 'data-testid="composer-model-picker-button"' : 'data-tone="neutral"'} aria-haspopup="menu">Medium</button>`}
      <button type="button" data-testid="send-button">Send</button>
    </form><div id="messages">${quoted ? '<div data-message-author-role="assistant"><div role="dialog">Too many requests</div></div>' : ""}</div></main>
    ${overlay ? '<button style="position:fixed;inset:0;z-index:99;opacity:0.5" onclick="window.pinClicks++">Pin</button>' : ""}
    <script>
      window.pinClicks = 0; window.ackClicks = 0; window.sends = 0; window.menuOpens = 0;
      const picker = document.querySelector('#picker');
      const composer = document.querySelector('#prompt-textarea');
      let selected = 'Medium';
      if (${terminalStaleStop}) globalThis.fetch = async () => {
        const payload = { message: { id: 'answer-' + window.sends, author: { role: 'assistant' }, recipient: 'all', channel: 'final', status: 'finished_successfully', end_turn: true, content: { content_type: 'text', parts: ['OK'] } } };
        const bytes = new TextEncoder().encode('data: ' + JSON.stringify(payload) + '\\n\\ndata: [DONE]\\n\\n');
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
      };
      const notice = (text) => { const el = document.createElement('div'); el.role = 'dialog'; el.textContent = text; document.body.append(el); };
      if (${rate}) {
        const dialog = document.createElement('div'); dialog.role = 'dialog';
        dialog.append('Too many requests. You are making requests too quickly. We have temporarily limited access to your conversations to protect your data.');
        const acknowledge = document.createElement('button'); acknowledge.textContent = 'Got it';
        acknowledge.onclick = () => { window.ackClicks++; dialog.remove(); };
        dialog.append(acknowledge); document.body.append(dialog);
      }
      if (${pin}) notice('You can only pin 10 items');
      composer.addEventListener('input', () => { if (${afterFill}) notice('Too many requests'); });
      if (picker) picker.onclick = () => {
        window.menuOpens++;
        document.querySelector('[role="menu"]')?.remove();
        const menu = document.createElement('div'); menu.role = 'menu';
        for (const label of ['Medium', 'High']) {
          const item = document.createElement('button'); item.role = 'menuitemradio'; item.textContent = label;
          item.setAttribute('aria-checked', String(selected === label));
          item.onclick = () => { selected = picker.textContent = label; menu.remove(); };
          menu.append(item);
        }
        document.body.append(menu);
      };
      document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelector('[role="menu"]')?.remove(); });
      document.querySelector('[data-testid="send-button"]').onclick = () => {
        window.sends++;
        const user = document.createElement('div'); user.setAttribute('data-message-author-role', 'user'); user.textContent = composer.textContent; composer.textContent = '';
        const answer = document.createElement('div'); answer.setAttribute('data-testid', 'conversation-turn-' + window.sends);
        answer.innerHTML = '<div data-message-author-role="assistant">OK</div><button data-testid="copy-turn-button">Copy</button>';
        answer.querySelector('[data-message-author-role="assistant"]').setAttribute('data-message-id', 'answer-' + window.sends);
        document.querySelector('#messages').append(user, answer);
        if (${terminalStaleStop}) {
          document.querySelector('[data-testid="stop-button"]')?.remove();
          const stop = document.createElement('button'); stop.setAttribute('data-testid', 'stop-button'); stop.textContent = 'Stop'; document.querySelector('main').append(stop);
          void fetch('data:/backend-api/f/conversation', { method: 'POST' }).then((response) => response.text());
        }
        if (${rateWithAnswer}) {
          const dialog = document.createElement('div'); dialog.role = 'dialog';
          dialog.append('Too many requests. You are making requests too quickly. We have temporarily limited access to your conversations to protect your data.');
          const acknowledge = document.createElement('button'); acknowledge.textContent = 'Got it';
          acknowledge.onclick = () => { window.ackClicks++; dialog.remove(); };
          dialog.append(acknowledge); document.body.append(dialog);
        }
        if (${lateRate}) setTimeout(() => {
          const shell = document.createElement('div');
          shell.innerHTML = '<h2>太多要求</h2><p>你的要求過於頻繁。為了保護你的資料，我們已暫時限制了你的對話存取權限。請稍等幾分鐘後再試一次。</p>';
          const acknowledge = document.createElement('button'); acknowledge.textContent = '知道了';
          acknowledge.onclick = () => { window.ackClicks++; shell.remove(); };
          shell.append(acknowledge); document.body.append(shell);
        }, 2600);
      };
    </script>`;
}

const directory = await mkdtemp(join(tmpdir(), "bridge-safety-e2e-"));
let app;
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [fileURLToPath(new URL("./chatgpt-mode-host.mjs", import.meta.url))],
    env: { ...process.env, CODEXGPT_BRIDGE_DOM_TEST_PROFILE: directory },
  });
  for (const [name, settings, expected] of [
    ["sidebar-high-must-not-be-clicked", { sidebar: true }, "ok"],
    ["dedicated-composer-picker", { sidebar: true, dedicated: true }, "ok"],
    ["quoted-rate-limit-is-not-a-notice", { quoted: true }, "ok"],
    ["no-global-chatgpt-button-fallback", { missing: true }, "model"],
    ["covered-picker-must-not-click-overlay", { overlay: true }, "model"],
    ["pin-dialog-stops-preparation", { pin: true }, "pin"],
    ["rate-dialog-dismisses-and-continues", { rate: true }, "dismiss-rate"],
    ["rate-dialog-after-composer-fill", { afterFill: true }, "rate"],
    [
      "completed-answer-survives-simultaneous-rate-dialog",
      { rateWithAnswer: true },
      "dismiss-answer-rate",
    ],
    [
      "terminal-stale-stop-does-not-reload-completed-page",
      { terminalStaleStop: true },
      "stale-stop",
    ],
    [
      "late-traditional-rate-dialog-after-completion",
      { lateRate: true },
      "dismiss-late-rate",
    ],
  ]) {
    const result = await app.evaluate(
      async ({ BrowserWindow }, { html, expected, name }) => {
        const controller = new globalThis.ChatGptBrowserController(
          "data:text/html;charset=utf-8," + encodeURIComponent(html),
        );
        const errors = [];
        const responses = [];
        const run = async (
          threadId,
          timeoutMs = 15_000,
          turnId = "same-turn",
        ) => {
          try {
            responses.push(
              await controller.runTurn({
                mode: "high",
                threadId,
                turnId,
                operationId: "same-operation",
                prompt: "test",
                images: [],
                signal: globalThis.AbortSignal.timeout(timeoutMs),
              }),
            );
          } catch (error) {
            errors.push({
              message: error.message,
              code: error.code,
              retryAfterSeconds: error.retryAfterSeconds,
            });
          }
        };
        try {
          await run(name);
          if (expected === "dismiss-late-rate")
            await new Promise((resolve) =>
              globalThis.setTimeout(resolve, 3_200),
            );
          const ackClicksBefore = await Promise.all(
            BrowserWindow.getAllWindows()
              .filter((w) => w.webContents.getURL().startsWith("data:"))
              .map((w) =>
                w.webContents.executeJavaScript("window.ackClicks || 0"),
              ),
          ).then((values) => values.reduce((sum, value) => sum + value, 0));
          const pagesBefore = BrowserWindow.getAllWindows().filter((w) =>
            w.webContents.getURL().startsWith("data:"),
          ).length;
          if (expected === "rate") {
            await run(name, 100);
            await run(name + "-other-task", 100);
          } else if (expected.startsWith("dismiss-")) {
            await run(name + "-after-late-rate", 15_000);
          } else if (expected === "stale-stop") {
            await run(name, 15_000, "second-turn");
          }
          const pages = BrowserWindow.getAllWindows().filter((w) =>
            w.webContents.getURL().startsWith("data:"),
          );
          const states = await Promise.all(
            pages.map((w) =>
              w.webContents.executeJavaScript(
                "({sends:window.sends,pinClicks:window.pinClicks,ackClicks:window.ackClicks,menuOpens:window.menuOpens})",
              ),
            ),
          );
          return {
            errors,
            responses,
            states,
            ackClicksBefore,
            pagesBefore,
            pagesAfter: pages.length,
          };
        } finally {
          await controller.close();
        }
      },
      { html: fixture(settings), expected, name },
    );
    assert.equal(
      result.states.reduce((sum, state) => sum + state.pinClicks, 0),
      0,
      name,
    );
    if (expected === "ok" || expected === "stale-stop") {
      assert.deepEqual(result.errors, [], name);
      assert.equal(
        result.states.reduce((sum, state) => sum + state.sends, 0),
        expected === "stale-stop" ? 2 : 1,
        name,
      );
      assert.deepEqual(
        result.responses,
        expected === "stale-stop" ? ["OK", "OK"] : ["OK"],
        name,
      );
    } else if (expected.startsWith("dismiss-")) {
      assert.deepEqual(result.errors, [], name);
      assert.equal(result.ackClicksBefore, 1, name);
      assert.deepEqual(result.responses, ["OK", "OK"], name);
      assert.equal(
        result.states.reduce((sum, state) => sum + state.sends, 0),
        2,
        name,
      );
    } else {
      assert.equal(
        result.states.reduce((sum, state) => sum + state.sends, 0),
        0,
        name,
      );
      assert.match(
        result.errors[0].message,
        expected === "rate"
          ? /rate limited/
          : expected === "pin"
            ? /pin-limit dialog/
            : /recognized model control/,
      );
      if (expected === "rate") {
        assert.equal(result.errors.length, 3, name);
        assert.equal(result.errors[0].code, "chatgpt_web_rate_limited");
        assert.ok(result.errors[0].retryAfterSeconds > 0);
        assert.match(result.errors[1].message, /cancelled/i);
        assert.match(result.errors[2].message, /cancelled/i);
        assert.ok(result.pagesAfter <= result.pagesBefore, name);
        assert.equal(result.ackClicksBefore, settings.rate ? 1 : 0, name);
      }
    }
    process.stdout.write(name + ": passed\n");
  }
  const noticeChecks = await app.evaluate(async ({ BrowserWindow }, script) => {
    const window = new BrowserWindow({ show: false });
    try {
      await window.loadURL("data:text/html,<body></body>");
      return await window.webContents.executeJavaScript(`(() => {
        const observe = (${script}); const results = [];
        for (const [html, expected] of [
          ['<div role="alertdialog">Too many requests</div>', 'rate-limit'],
          ['<div role="dialog">太多要求 你的要求過於頻繁。為了保護你的資料，我們已暫時限制了你的對話存取權限。</div>', 'rate-limit'],
          ['<section><h2>太多要求</h2><p>你的要求過於頻繁。為了保護你的資料，我們已暫時限制了你的對話存取權限。</p><button>知道了</button></section>', 'rate-limit'],
          ['<div role="dialog">最多只能釘選 10 個項目</div>', 'pin-limit'],
          ['<div role="dialog" style="display:none">Too many requests</div>', null],
          ['<div data-message-author-role="assistant"><div role="alert">Too many requests</div></div>', null],
          ['<pre><div role="dialog">Too many requests</div></pre>', null],
          ['<div role="dialog">Intelligence Model High</div>', null],
        ]) { document.body.innerHTML = html; results.push({ actual: observe(), expected }); }
        return results;
      })()`);
    } finally {
      window.destroy();
    }
  }, observeChatGptPageBlock.toString());
  for (const result of noticeChecks)
    assert.equal(result.actual, result.expected);
  process.stdout.write("Application notice ownership: 8 checks passed\n");
  const acknowledgementChecks = await app.evaluate(
    async ({ BrowserWindow }, script) => {
      const window = new BrowserWindow({ show: false });
      try {
        await window.loadURL("data:text/html,<body></body>");
        return await window.webContents.executeJavaScript(`(() => {
          const acknowledge = (${script}); const results = [];
          for (const [html, expected] of [
            ['<section><h2>太多要求</h2><p>你的要求過於頻繁。為了保護你的資料，我們已暫時限制了你的對話存取權限。請稍等幾分鐘後再試一次。</p><button onclick="window.clicked++">知道了</button></section>', true],
            ['<div role="dialog"><h2>Too many requests</h2><p>You are making requests too quickly.</p><button onclick="window.clicked++">Got it</button></div>', true],
            ['<section><h2>太多要求</h2><button onclick="window.clicked++">知道了</button></section>', false],
            ['<div data-message-author-role="assistant"><h2>太多要求</h2><p>你的要求過於頻繁。</p><button onclick="window.clicked++">知道了</button></div>', false],
          ]) {
            window.clicked = 0; document.body.innerHTML = html;
            results.push({ actual: acknowledge(), clicked: window.clicked, expected });
          }
          return results;
        })()`);
      } finally {
        window.destroy();
      }
    },
    acknowledgeChatGptRateLimitDialog.toString(),
  );
  for (const result of acknowledgementChecks) {
    assert.equal(result.actual, result.expected);
    assert.equal(result.clicked, result.expected ? 1 : 0);
  }
  process.stdout.write("Rate-limit acknowledgement: 4 checks passed\n");
  const challengeChecks = await app.evaluate(
    async ({ BrowserWindow }, script) => {
      const window = new BrowserWindow({ show: false });
      try {
        await window.loadURL("data:text/html,<body></body>");
        return await window.webContents.executeJavaScript(`(() => {
          const observe = (${script}); const results = [];
          for (const [title, html, expected] of [
            ['Just a moment...', '<div id="challenge-running" style="width:100px;height:40px">Checking your browser</div>', 'cloudflare-challenge'],
            ['ChatGPT', '<iframe src="https://challenges.cloudflare.com/turnstile/v0/api.js" style="width:100px;height:40px"></iframe>', 'cloudflare-challenge'],
            ['ChatGPT', '<div id="challenge-running" style="display:none">Checking your browser</div>', null],
            ['ChatGPT', '<div data-message-author-role="assistant"><p>Just a moment...</p></div>', null],
          ]) {
            document.title = title;
            document.body.innerHTML = html;
            results.push({ actual: observe(), expected });
          }
          return results;
        })()`);
      } finally {
        window.destroy();
      }
    },
    observeChatGptPageBlock.toString(),
  );
  for (const result of challengeChecks)
    assert.equal(result.actual, result.expected);
  process.stdout.write("Cloudflare challenge ownership: 4 checks passed\n");
  const sessionNoticeChecks = await app.evaluate(
    async ({ BrowserWindow }, script) => {
      const window = new BrowserWindow({ show: false });
      try {
        await window.loadURL("data:text/html,<body></body>");
        return await window.webContents.executeJavaScript(`(() => {
          const observe = (${script}); const results = [];
          for (const [html, expected] of [
            ['<div role="alert">Your session has expired. Please log in again.</div>', 'session-expired'],
            ['<div role="dialog">Failed to load subscription</div>', 'subscription-unavailable'],
            ['<div role="alert" style="display:none">Your session has expired.</div>', null],
            ['<div data-message-author-role="assistant"><div role="alert">Your session has expired.</div></div>', null],
            ['<code><div role="alert">Failed to load subscription</div></code>', null],
            ['<div role="dialog">Session settings</div>', null],
          ]) { document.body.innerHTML = html; results.push({ actual: observe(), expected }); }
          return results;
        })()`);
      } finally {
        window.destroy();
      }
    },
    observeChatGptServerSessionNotice.toString(),
  );
  for (const result of sessionNoticeChecks)
    assert.equal(result.actual, result.expected);
  process.stdout.write("Server session notice ownership: 6 checks passed\n");

  let serverProbeCount = 0;
  let expireBeforeSubmit = false;
  const sessionServer = createServer((request, response) => {
    if (request.url === "/api/auth/session") {
      serverProbeCount++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        expireBeforeSubmit && serverProbeCount < 3
          ? JSON.stringify({ user: { id: "session-fixture" } })
          : "{}",
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><main>
      <button data-testid="model-switcher-dropdown-button" aria-haspopup="menu">High</button>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button" onclick="window.sends++">Send</button>
      </main><script>window.sends = 0;</script>`);
  });
  await new Promise((resolve, reject) => {
    sessionServer.once("error", reject);
    sessionServer.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = sessionServer.address();
    if (typeof address === "string" || address === null)
      throw new Error("Session fixture did not bind a TCP port.");
    const baseUrl = `http://127.0.0.1:${address.port}/`;
    const runSessionFailure = (identity) =>
      app.evaluate(
        async ({ BrowserWindow }, { baseUrl, identity }) => {
          const controller = new globalThis.ChatGptBrowserController(baseUrl);
          let error;
          try {
            await controller.runTurn({
              mode: "high",
              threadId: identity,
              turnId: identity,
              operationId: identity,
              prompt: "must-not-reach-composer",
              images: [],
              signal: globalThis.AbortSignal.timeout(10_000),
            });
          } catch (caught) {
            error = { message: caught.message, code: caught.code };
          }
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().startsWith(baseUrl),
          );
          const state = window
            ? await window.webContents.executeJavaScript(
                "({sends: window.sends, composer: document.querySelector('#prompt-textarea').textContent})",
              )
            : {};
          await controller.close();
          return { error, state };
        },
        { baseUrl, identity },
      );
    const sessionFailure = await runSessionFailure("expired-session");
    assert.equal(
      sessionFailure.error.code,
      "chatgpt_web_session_expired",
      JSON.stringify(sessionFailure),
    );
    assert.match(sessionFailure.error.message, /server session has expired/i);
    assert.deepEqual(sessionFailure.state, { sends: 0, composer: "" });
    assert.equal(serverProbeCount, 1);
    process.stdout.write(
      "Expired server session blocked prompt injection and submission\n",
    );

    expireBeforeSubmit = true;
    serverProbeCount = 0;
    const preSubmitFailure = await runSessionFailure("expired-before-submit");
    assert.equal(
      preSubmitFailure.error.code,
      "chatgpt_web_session_expired",
      JSON.stringify(preSubmitFailure),
    );
    assert.deepEqual(preSubmitFailure.state, { sends: 0, composer: "" });
    assert.equal(serverProbeCount, 3);
    process.stdout.write(
      "Session expiry immediately before Send discarded the owned draft\n",
    );
  } finally {
    await new Promise((resolve) => sessionServer.close(resolve));
  }
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
