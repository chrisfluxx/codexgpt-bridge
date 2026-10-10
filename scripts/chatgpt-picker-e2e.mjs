import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron } from "playwright-core";

function fixture({
  contents = false,
  native = false,
  generic = false,
  initial = 2,
  drift = false,
  unavailable = false,
  contradictory = false,
  roving = false,
} = {}) {
  return `<!doctype html><body>
    <aside><button data-tone="neutral" aria-haspopup="menu" onclick="window.unrelatedClicks++">High</button></aside>
    <main><form onsubmit="return false">
      <div ${roving ? "data-composer-markdown" : 'id="prompt-textarea"'} contenteditable="true" style="width:600px;min-height:180px"></div>
      <button id="picker" type="button" data-tone="neutral" aria-haspopup="dialog" aria-controls="effort-popover">${generic ? "推理強度" : "高"}</button>
      <button type="button" data-testid="send-button">Send</button>
    </form><div id="messages"></div></main>
    <div role="dialog" id="unrelated"><input type="range" value="1"></div>
    <script>
      let selected = ${initial};
      const labels = ['低', '中', '高', '極高', 'Pro'];
      const picker = document.querySelector('#picker');
      window.sends = 0; window.menuOpens = 0; window.unrelatedClicks = 0;
      document.querySelector('#unrelated input').oninput = () => window.unrelatedClicks++;
      const close = () => { document.querySelector('#effort-popover')?.remove(); picker.setAttribute('aria-expanded', 'false'); };
      const render = () => {
        const root = document.querySelector('#effort-popover'); if (!root) return;
        const slider = root.querySelector('[data-slider]');
        if (${native}) slider.value = selected; else slider.setAttribute('aria-valuenow', selected);
        slider.setAttribute('aria-valuetext', ${contradictory} ? 'Medium' : labels[selected]);
        root.querySelector('[data-mode]').textContent = labels[selected];
        if (${roving}) root.querySelector('[role="status"]').textContent = '6 ' + labels[selected] + '，第 ' + (selected + 1) + ' 項，共 5 項。';
        if (!${generic}) picker.textContent = labels[selected];
      };
      picker.onclick = () => {
        window.menuOpens++;
        if (${unavailable}) return;
        if (document.querySelector('#effort-popover')) { close(); return; }
        const root = document.createElement('div'); root.id = 'effort-popover';
        if (${contents}) { root.style.display = 'contents'; root.setAttribute('data-testid', 'composer-intelligence-picker-content'); }
        else root.role = ${roving} ? 'menu' : 'dialog';
        root.innerHTML = '<button type="button" aria-haspopup="menu" aria-expanded="false" data-mode></button>' +
          (${roving}
            ? '<button role="menuitemradio" aria-checked="true">6</button><span id="native-status" role="status"></span><div role="menuitem" tabindex="-1" aria-keyshortcuts="ArrowLeft ArrowRight" aria-describedby="native-status" style="width:200px;height:30px"><span data-slider role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4"></span></div>'
            : ${native} ? '<input data-slider type="range" min="0" max="4" step="1">' : '<button role="menuitem"><span data-slider role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="4" style="display:inline-block;width:200px;height:24px"></span></button>');
        if (${roving}) root.innerHTML = '<div data-model-picker-view="simple">' + root.innerHTML + '</div>';
        const slider = root.querySelector('[data-slider]');
        if (${native}) slider.oninput = () => { selected = Number(slider.value); render(); };
        else slider.parentElement.onkeydown = e => {
          if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
          selected = Math.max(0, Math.min(4, selected + (e.key === 'ArrowRight' ? 1 : -1))); render();
        };
        document.body.append(root); picker.setAttribute('aria-expanded', 'true'); render();
      };
      const composer = document.querySelector('#prompt-textarea, [data-composer-markdown]');
      composer.addEventListener('input', () => { if (${drift}) { selected = 1; if (!${generic}) picker.textContent = labels[selected]; } });
      document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
      document.querySelector('[data-testid="send-button"]').onclick = () => {
        window.sends++;
        const user = document.createElement('div'); user.setAttribute('data-message-author-role', 'user'); user.textContent = composer.textContent; composer.textContent = '';
        const reply = document.createElement('div'); reply.setAttribute('data-testid', 'conversation-turn-' + window.sends);
        reply.innerHTML = '<div data-message-author-role="assistant">OK</div><button data-testid="copy-turn-button">Copy</button>';
        document.querySelector('#messages').append(user, reply);
      };
    </script>`;
}

const directory = await mkdtemp(join(tmpdir(), "bridge-picker-e2e-"));
let app;
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [fileURLToPath(new URL("./chatgpt-mode-host.mjs", import.meta.url))],
    env: { ...process.env, CODEXGPT_BRIDGE_DOM_TEST_PROFILE: directory },
  });
  for (const [name, settings, fails, mode = "high", model] of [
    ["linked-dialog-with-current-high", {}, false],
    ["contents-wrapper-with-current-high", { contents: true }, false],
    ["localized-reasoning-button", { generic: true }, false],
    [
      "native-six-roving-slider-high-to-extra-high",
      { roving: true, generic: true },
      false,
      "extra-high",
      "bridge-native:6",
    ],
    [
      "native-range-medium-to-high",
      { native: true, generic: true, initial: 1 },
      false,
    ],
    [
      "contents-native-range",
      { contents: true, native: true, generic: true, initial: 1 },
      false,
    ],
    [
      "post-fill-drift-reconnect",
      { native: true, generic: true, drift: true },
      true,
    ],
    [
      "unrelated-dialog-does-not-replace-current-high",
      { unavailable: true },
      false,
    ],
    [
      "contradictory-slider-state",
      { generic: true, contradictory: true },
      true,
    ],
  ]) {
    const result = await app.evaluate(
      async ({ BrowserWindow }, { html, name, fails, mode, model }) => {
        const receipts = [],
          traces = [],
          errors = [];
        const controller = new globalThis.ChatGptBrowserController(
          "data:text/html;charset=utf-8," + encodeURIComponent(html),
          undefined,
          async (receipt) => {
            receipts.push(receipt);
          },
          async (trace) => {
            traces.push(trace);
          },
        );
        try {
          for (let attempt = 0; attempt < (fails ? 5 : 2); attempt++) {
            try {
              await controller.runTurn({
                mode,
                modelFamily: model,
                threadId: name,
                turnId: fails ? "same-turn" : "turn-" + attempt,
                operationId: fails ? "same-operation" : "operation-" + attempt,
                prompt: "test",
                images: [],
                signal: globalThis.AbortSignal.timeout(15_000),
              });
            } catch (error) {
              errors.push(error.message);
            }
          }
          const page = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().startsWith("data:"),
          );
          const state = page
            ? await page.webContents.executeJavaScript(
                "({sends:window.sends,menuOpens:window.menuOpens,unrelatedClicks:window.unrelatedClicks})",
              )
            : {};
          return { ...state, errors, receipts, traceCount: traces.length };
        } finally {
          await controller.close();
        }
      },
      { html: fixture(settings), name, fails, mode, model },
    );
    assert.equal(result.unrelatedClicks, 0, name);
    if (fails) {
      assert.equal(result.sends, 0, JSON.stringify({ name, ...result }));
      assert.equal(result.errors.length, 5, name);
      assert.equal(
        result.traceCount,
        5,
        name + " must safely re-read repaired UI on every reconnect",
      );
    } else {
      assert.deepEqual(result.errors, [], JSON.stringify({ name, ...result }));
      assert.equal(result.sends, 2, name);
      assert.equal(result.receipts.at(-1).observed.mode, mode, name);
      if (model) {
        assert.equal(result.receipts.at(-1).confidence, "UI_VERIFIED", name);
        assert.equal(result.receipts.at(-1).observed.model, "6", name);
      }
      assert.ok(
        result.receipts.every((receipt) => receipt.confidence !== "REJECTED"),
        name,
      );
    }
    process.stdout.write(name + ": passed\n");
  }
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
