import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron } from "playwright-core";

// Real Electron controller; only the remote page is replaced with an owned fixture.
// Delayed mounting, generic composer controls and reactive drift reproduce races
// that synchronous picker fixtures cannot exercise.
function fixture({
  initial = "High",
  menuDelay = 0,
  verifyDelay = 0,
  drift = false,
  missing = false,
  disabled = false,
  generic = false,
  configure = false,
  unrelatedControl = false,
  hiddenPicker = false,
  ignoreFirstClick = false,
} = {}) {
  return `<!doctype html><main>
    ${unrelatedControl ? '<button type="button" data-tone="neutral" aria-haspopup="menu" onclick="window.unrelatedClicks++">Attachments</button>' : ""}
    ${hiddenPicker ? '<button type="button" data-testid="model-switcher-dropdown-button" aria-haspopup="menu" style="display:none">High</button>' : ""}
    <form onsubmit="return false">
    <div id="prompt-textarea" contenteditable="true" style="width:500px;min-height:30px"></div>
    <button type="button" data-fixture-picker ${generic ? 'data-tone="neutral"' : 'data-testid="model-switcher-dropdown-button"'} aria-haspopup="menu">${initial}</button>
    <button type="button" data-testid="send-button">Send</button>
    </form><div id="messages"></div></main><script>
    const picker = document.querySelector('[data-fixture-picker]');
    const composer = document.querySelector('#prompt-textarea');
    let selected = ${JSON.stringify(initial)}, prepared = false, pending;
    window.sends = 0; window.menuOpens = 0; window.configureOpens = 0; window.selectedAtSend = []; window.unrelatedClicks = 0;
    picker.onclick = () => {
      const old = document.querySelector('[role="menu"]');
      if (old) { old.remove(); return; }
      window.menuOpens++;
      if (${ignoreFirstClick} && window.menuOpens === 1) return;
      picker.setAttribute('aria-expanded', 'true');
      if (${missing} && prepared) return;
      clearTimeout(pending);
      pending = setTimeout(() => {
        const menu = document.createElement('div'); menu.role = 'menu';
        if (${configure}) {
          const entry = document.createElement('button'); entry.role = 'menuitem'; entry.textContent = 'Configure…';
          entry.onclick = () => {
            window.configureOpens++; menu.remove();
            pending = setTimeout(() => {
              const dialog = document.createElement('div'); dialog.role = 'dialog';
              dialog.innerHTML = '<h2>Intelligence</h2><div><label>Model</label> <button role="combobox">GPT-6 Fixture</button></div><div><button role="radio" aria-checked="true">Thinking</button></div><div><button role="combobox">Extended</button></div>';
              document.body.append(dialog);
            }, ${verifyDelay});
          };
          menu.append(entry);
        } else {
          for (const label of ['Instant','Medium','High','Extra High','Pro']) {
            const option = document.createElement('button'); option.role = 'menuitemradio'; option.textContent = label;
            option.setAttribute('aria-checked', String(label === selected));
            option.setAttribute('aria-disabled', String(${disabled} && label === 'High'));
            option.onclick = () => { if (${disabled} && label === 'High') return; selected = picker.textContent = label; menu.remove(); picker.setAttribute('aria-expanded', 'false'); };
            menu.append(option);
          }
        }
        document.body.append(menu);
      }, prepared ? ${verifyDelay} : ${menuDelay});
    };
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') { clearTimeout(pending); document.querySelector('[role="menu"]')?.remove(); document.querySelector('[role="dialog"]')?.remove(); picker.setAttribute('aria-expanded', 'false'); }
    });
    composer.addEventListener('input', () => {
      prepared = true;
      if (${drift}) selected = picker.textContent = 'Medium';
      if (${missing}) picker.remove();
      if (${disabled}) { picker.setAttribute('aria-disabled', 'true'); picker.disabled = true; }
    });
    document.querySelector('[data-testid="send-button"]').onclick = () => {
      window.sends++; window.selectedAtSend.push(selected);
      const user = document.createElement('div'); user.setAttribute('data-message-author-role','user'); user.textContent = composer.textContent; composer.textContent = '';
      const reply = document.createElement('div'); reply.setAttribute('data-testid','conversation-turn-' + window.sends);
      reply.innerHTML = '<div data-message-author-role="assistant">OK ' + window.sends + '</div><button data-testid="copy-turn-button">Copy</button>';
      document.querySelector('#messages').append(user,reply);
    };
    </script>`;
}

function connectorRetryFixture({ appMention = false, pro = false } = {}) {
  return `<!doctype html><main>
    <form onsubmit="return false">
      <div ${appMention ? 'class="ProseMirror" data-composer-markdown' : 'id="prompt-textarea"'} contenteditable="true" style="width:500px;min-height:30px"></div>
      <button type="button" data-testid="model-switcher-dropdown-button" aria-haspopup="menu" style="display:none">Instant</button>
      <button type="button" data-testid="send-button">Send</button>
    </form>
    <div id="messages"></div>
  </main><script>
    const state = (() => {
      try { return JSON.parse(window.name || '{}'); } catch { return {}; }
    })();
    state.loads = Number(state.loads || 0) + 1;
    state.sends = Number(state.sends || 0);
    state.lastSendLoad = Number(state.lastSendLoad || 0);
    state.connectorActivations = Number(state.connectorActivations || 0);
    state.fileRowsSeen = Number(state.fileRowsSeen || 0);
    state.mentionTriggerInputs = Number(state.mentionTriggerInputs || 0);
    state.modelMenuOpens = Number(state.modelMenuOpens || 0);
    state.modelReselections = Number(state.modelReselections || 0);
    state.cleanupBlocksRemaining = Number(state.cleanupBlocksRemaining || 0);
    state.cleanupRetries = Number(state.cleanupRetries || 0);
    state.selectedAtSend ||= [];
    state.preConnectorModelClicks = Number(state.preConnectorModelClicks || 0);
    const persist = () => { window.name = JSON.stringify(state); };
    persist();

    const composer = document.querySelector('#prompt-textarea, [data-composer-markdown]');
    const modelPicker = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
    let connectorSelected = false;
    let mentionTriggerObserved = false;
    let mentionReadyAt = 0;
    let selectedMode = 'Instant';
    modelPicker.onclick = () => {
      document.querySelector('[data-model-menu]')?.remove();
      if (!connectorSelected && state.sends === 0) { state.preConnectorModelClicks++; persist(); return; }
      state.modelMenuOpens += 1;
      persist();
      const menu = document.createElement('div');
      menu.dataset.modelMenu = 'true';
      menu.setAttribute('role', 'menu');
      menu.innerHTML = '<div data-testid="composer-intelligence-picker-content"><button role="menuitem" aria-expanded="false">Instant</button><button role="menuitem" id="effort"><span role="slider" aria-valuemin="0" aria-valuemax="${pro ? 4 : 3}" aria-valuenow="0">Instant</span></button></div>';
      const slider = menu.querySelector('[role="slider"]');
      menu.querySelector('#effort').onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        const value = Math.max(0, Math.min(${pro ? 4 : 3}, Number(slider.getAttribute('aria-valuenow')) + (event.key === 'ArrowRight' ? 1 : -1)));
        const labels = ['Instant', 'Medium', 'High', 'Extra High', 'Pro'];
        slider.setAttribute('aria-valuenow', value);
        slider.textContent = labels[value];
        selectedMode = modelPicker.textContent = labels[value];
        if (value === ${pro ? 4 : 3}) {
          state.modelReselections += 1;
          persist();
        }
      };
      document.body.append(menu);
    };
    composer.addEventListener('keydown', event => {
      if (event.key !== 'Backspace') return;
      if (state.cleanupBlocksRemaining > 0) {
        event.preventDefault();
        state.cleanupBlocksRemaining -= 1;
        state.cleanupRetries += 1;
        persist();
        return;
      }
      if (connectorSelected) {
        connectorSelected = false;
        composer.querySelectorAll('[data-id^="plugin:"], [app-mention-path]').forEach(element => element.remove());
      }
      if (composer.textContent === 'stale-tool-draft') {
        event.preventDefault();
        composer.textContent = '';
      }
    });
    composer.addEventListener('input', () => {
      if (composer.textContent === '@') {
        mentionTriggerObserved = true;
        mentionReadyAt = performance.now() + 250;
        state.mentionTriggerInputs += 1;
        persist();
        return;
      }
      // The real ChatGPT Lexical picker intermittently ignores a combined
      // "@CodexGPT" insertion on retained conversations. This fixture only
      // exposes the connector after the standalone trigger event.
      if (!mentionTriggerObserved) return;
      if (performance.now() < mentionReadyAt) return;
      if (!composer.textContent.includes('@CodexGPT')) return;
      document.querySelector('[data-connector-menu]')?.remove();
      const menu = document.createElement('div');
      menu.dataset.connectorMenu = 'true';
      menu.setAttribute('role', 'listbox');
      const option = document.createElement('button');
      option.setAttribute('role', 'option');
      // ChatGPT hides an App from the picker after it has already been used in
      // this conversation. A project file can still remain as the only row.
      if (state.sends > 0 || composer.textContent !== '@CodexGPT Bridge') {
        option.textContent = 'etf-resonance-radar-codex-plan.md';
        state.fileRowsSeen += 1;
        persist();
        menu.append(option);
        document.body.append(menu);
        return;
      }
      option.textContent = 'CodexGPT Bridge';
      option.onclick = () => {
        composer.textContent = '';
        const connector = document.createElement('span');
        if (${appMention}) {
          connector.setAttribute('app-mention-name', 'codexgpt-bridge');
          connector.setAttribute('app-mention-display-name', 'CodexGPT Bridge');
          connector.setAttribute('app-mention-path', 'app://bridge-fixture');
          const icon = document.createElement('span');
          icon.contentEditable = 'false';
          connector.append(icon);
        } else {
          connector.dataset.id = 'plugin:codexgpt-bridge';
          connector.dataset.keyword = 'CodexGPT Bridge';
        }
        connector.contentEditable = 'false';
        connector.append('CodexGPT Bridge');
        composer.append(connector);
        connectorSelected = true;
        mentionTriggerObserved = false;
        selectedMode = modelPicker.textContent = 'Instant';
        setTimeout(() => { modelPicker.style.display = ''; }, 750);
        state.connectorActivations += 1;
        persist();
        menu.remove();
      };
      menu.append(option);
      document.body.append(menu);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        document.querySelector('[data-connector-menu]')?.remove();
        document.querySelector('[data-model-menu]')?.remove();
      }
    });
    document.querySelector('[data-testid="send-button"]').onclick = () => {
      state.sends += 1;
      state.selectedAtSend.push(selectedMode);
      state.lastSendLoad = state.loads;
      state.cleanupBlocksRemaining = 1;
      persist();
      const user = document.createElement('div');
      user.setAttribute('data-testid', 'conversation-turn-user-' + state.sends);
      user.setAttribute('data-message-author-role', 'user');
      user.textContent = '[Codex Full MCP protocol v1] Use the ChatGPT connector named "CodexGPT Bridge" for every action. Pass this turn_token unchanged. Call codex_tool_inventory. ' + composer.textContent;
      if (${appMention} && composer.querySelector('[app-mention-path]')) user.prepend(composer.querySelector('[app-mention-path]').cloneNode(true));
      composer.textContent = 'stale-tool-draft';
      connectorSelected = false;
      mentionTriggerObserved = false;
      const reply = document.createElement('div');
      reply.setAttribute('data-testid', 'conversation-turn-assistant-' + state.sends);
      reply.innerHTML = '<div data-message-author-role="assistant"><button aria-label="Open tool call list">Called tool</button>CONNECTOR_OK_' + state.sends + '</div><button data-testid="copy-turn-button">Copy</button>';
      document.querySelector('#messages').append(user, reply);
    };
  </script>`;
}

function retainedConnectorReopenFixture() {
  return `<!doctype html><main>
    <form onsubmit="return false">
      <div id="prompt-textarea" contenteditable="true" style="width:500px;min-height:30px"></div>
      <button type="button" data-testid="model-switcher-dropdown-button" aria-haspopup="menu">High</button>
      <button type="button" data-testid="send-button">Send</button>
    </form>
    <div id="messages"></div>
  </main><script>
    const state = (() => {
      try { return JSON.parse(window.name || '{}'); } catch { return {}; }
    })();
    const conversationPath = '/c/retained-bridge-task';
    state.baseVisits = Number(state.baseVisits || 0);
    state.conversationLoads = Number(state.conversationLoads || 0);
    state.connectorActivations = Number(state.connectorActivations || 0);
    state.sends = Number(state.sends || 0);
    state.sendPaths ||= [];
    if (location.pathname === conversationPath) state.conversationLoads += 1;
    else state.baseVisits += 1;
    const persist = () => { window.name = JSON.stringify(state); };
    persist();

    const composer = document.querySelector('#prompt-textarea');
    let mentionTriggered = false;
    composer.addEventListener('input', () => {
      if (composer.textContent === '@') {
        mentionTriggered = true;
        return;
      }
      if (!mentionTriggered || !composer.textContent.includes('@CodexGPT')) return;
      // The first load and a plain reload of the retained URL deliberately keep
      // the picker stale. It becomes available only after the start surface has
      // been visited again, proving recovery reopens this same conversation.
      if (state.baseVisits < 2 || document.querySelector('[data-connector-menu]')) return;
      const menu = document.createElement('div');
      menu.dataset.connectorMenu = 'true';
      menu.setAttribute('role', 'listbox');
      const option = document.createElement('button');
      option.setAttribute('role', 'option');
      option.textContent = 'CodexGPT Bridge';
      option.onclick = () => {
        composer.textContent = '';
        const connector = document.createElement('span');
        connector.dataset.id = 'plugin:codexgpt-bridge';
        connector.dataset.keyword = 'CodexGPT Bridge';
        connector.contentEditable = 'false';
        connector.textContent = 'CodexGPT Bridge';
        composer.append(connector);
        state.connectorActivations += 1;
        persist();
        menu.remove();
      };
      menu.append(option);
      document.body.append(menu);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') document.querySelector('[data-connector-menu]')?.remove();
    });
    document.querySelector('[data-testid="send-button"]').onclick = () => {
      state.sends += 1;
      state.sendPaths.push(location.pathname);
      persist();
      const user = document.createElement('div');
      user.setAttribute('data-message-author-role', 'user');
      user.textContent = composer.textContent;
      composer.textContent = '';
      const reply = document.createElement('div');
      reply.setAttribute('data-testid', 'conversation-turn-' + state.sends);
      reply.innerHTML = '<div data-message-author-role="assistant">REOPEN_OK</div><button data-testid="copy-turn-button">Copy</button>';
      document.querySelector('#messages').append(user, reply);
    };
  </script>`;
}

const directory = await mkdtemp(join(tmpdir(), "bridge-preparation-e2e-"));
const results = [];
let app;
let fixtureServer;
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [fileURLToPath(new URL("./chatgpt-mode-host.mjs", import.meta.url))],
    env: { ...process.env, CODEXGPT_BRIDGE_DOM_TEST_PROFILE: directory },
  });
  for (const [name, settings, count, failure] of [
    ["unrelated-control-before-picker", { unrelatedControl: true }, 1, false],
    [
      "generic-control-with-unrelated-menu",
      { generic: true, unrelatedControl: true },
      1,
      false,
    ],
    ["hidden-duplicate-picker", { hiddenPicker: true }, 1, false],
    ["cold-and-retained-high", {}, 3, false],
    ["plain-selection", { initial: "Medium" }, 1, false],
    [
      "delayed-plain-selection",
      { initial: "Medium", menuDelay: 850 },
      1,
      false,
    ],
    ["delayed-verification", { verifyDelay: 850 }, 2, false],
    [
      "ignored-pre-hydration-click",
      { initial: "Medium", ignoreFirstClick: true },
      1,
      false,
    ],
    [
      "slow-portal-is-not-toggled",
      { initial: "Medium", menuDelay: 3600 },
      1,
      false,
    ],
    ["generic-composer-control", { generic: true }, 2, false],
    ["delayed-configure", { configure: true, verifyDelay: 650 }, 1, false],
    ["post-input-drift", { drift: true }, 1, true],
    ["missing-verification-menu", { missing: true }, 1, true],
    ["disabled-selected-effort", { disabled: true }, 1, true],
  ]) {
    const result = await app.evaluate(
      async ({ BrowserWindow }, { html, count, name, modelFamily }) => {
        const traces = [],
          receipts = [];
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
        const outputs = [];
        let error;
        try {
          for (let index = 0; index < count; index++) {
            const input = {
              mode: "high",
              threadId: "preparation-task",
              turnId: name + index,
              operationId: name + index,
              modelFamily,
              prompt: "private-fixture-input",
              images: [],
              signal: globalThis.AbortSignal.timeout(20_000),
            };
            // Reconnecting to the same operation must not click Send twice.
            const repeated = await Promise.all([
              controller.runTurn(input),
              controller.runTurn(input),
            ]);
            if (repeated[0] !== repeated[1])
              throw new Error("Reconnect reply mismatch");
            outputs.push(repeated[0]);
          }
        } catch (caught) {
          error = caught.message;
        }
        const window = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().startsWith("data:"),
        );
        const state = window
          ? await window.webContents.executeJavaScript(
              "({sends:window.sends,menuOpens:window.menuOpens,configureOpens:window.configureOpens,selectedAtSend:window.selectedAtSend,unrelatedClicks:window.unrelatedClicks})",
            )
          : {};
        await controller.close();
        return { name, outputs, error, traces, receipts, ...state };
      },
      {
        html: fixture(settings),
        count,
        name,
        modelFamily: settings.configure ? "GPT-6 Fixture" : undefined,
      },
    );
    results.push(result);
    process.stdout.write(
      JSON.stringify({
        name,
        error: result.error,
        sends: result.sends,
        menuOpens: result.menuOpens,
        preparingMs: result.traces.map((trace) => trace.milestones.submitting),
        failure: result.traces.at(-1)?.failure,
      }) + "\n",
    );
    if (failure) {
      assert.equal(result.sends, 0, JSON.stringify(result));
      assert.match(result.error, /selection verification failed/i);
      assert.equal(result.receipts.at(-1).confidence, "REJECTED");
      assert.equal(result.traces.at(-1).outcome, "failed");
      assert.ok(result.traces.at(-1).failure);
    } else {
      assert.equal(result.error, undefined);
      assert.equal(result.unrelatedClicks, 0);
      assert.equal(result.sends, count);
      assert.deepEqual(result.selectedAtSend, Array(count).fill("High"));
      assert.equal(result.traces.length, count);
      // Wide scheduling allowance; this measures pre-submit only, not inference.
      for (const trace of result.traces)
        assert.ok(
          trace.milestones.submitting <
            (settings.menuDelay > 3_000 ? 7_000 : 5_000),
          JSON.stringify(trace),
        );
      assert.equal(result.configureOpens, settings.configure ? count * 2 : 0);
      assert.equal(
        result.menuOpens,
        settings.configure
          ? count * 2
          : settings.ignoreFirstClick
            ? 2
            : settings.initial === "Medium"
              ? 1
              : 0,
      );
      for (const trace of result.traces) {
        assert.ok(
          trace.preparationSteps.some(
            (step) =>
              step.stage === "pre-submit-verify" &&
              step.outcome === "completed",
          ),
        );
        assert.ok(
          trace.preparationSteps.some((step) => step.stage === "composer-fill"),
        );
        assert.ok(
          trace.preparationSteps.some(
            (step) => step.stage === "attachments-ready",
          ),
        );
      }
    }
    assert.doesNotMatch(
      JSON.stringify(result.traces),
      /private-fixture-input|<script|data:text|GPT-6 Fixture/,
    );
  }

  const connectorRetry = await app.evaluate(async ({ BrowserWindow }, html) => {
    const traces = [];
    const controller = new globalThis.ChatGptBrowserController(
      "data:text/html;charset=utf-8," + encodeURIComponent(html),
      undefined,
      undefined,
      async (trace) => traces.push(trace),
    );
    const outputs = [];
    let error;
    try {
      for (let index = 0; index < 5; index++) {
        outputs.push(
          await controller.runTurn({
            mode: "extra-high",
            threadId: "connector-retry-task",
            turnId: "connector-retry-" + index,
            operationId: "connector-retry-" + index,
            prompt: "private-connector-input",
            conversationHistory: "bounded prior Codex context",
            images: [],
            allowWebNativeTools: true,
            connectorName: "CodexGPT Bridge",
            signal: globalThis.AbortSignal.timeout(30_000),
          }),
        );
      }
    } catch (caught) {
      error = caught.message;
    }
    const window = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().startsWith("data:"),
    );
    const state = window
      ? await window.webContents.executeJavaScript(
          "JSON.parse(window.name || '{}')",
        )
      : {};
    await controller.close();
    return { outputs, error, traces, state };
  }, connectorRetryFixture());
  assert.equal(connectorRetry.error, undefined, JSON.stringify(connectorRetry));
  assert.equal(
    connectorRetry.outputs.length,
    5,
    JSON.stringify(connectorRetry),
  );
  assert.equal(connectorRetry.state.sends, 5, JSON.stringify(connectorRetry));
  assert.deepEqual(
    connectorRetry.state.selectedAtSend,
    Array(5).fill("Extra High"),
  );
  assert.equal(connectorRetry.state.preConnectorModelClicks, 0);
  assert.equal(
    connectorRetry.state.connectorActivations,
    1,
    JSON.stringify(connectorRetry),
  );
  assert.ok(
    connectorRetry.state.fileRowsSeen >= 5,
    JSON.stringify(connectorRetry),
  );
  assert.equal(
    connectorRetry.state.mentionTriggerInputs,
    1,
    JSON.stringify(connectorRetry),
  );
  assert.equal(
    connectorRetry.state.modelMenuOpens,
    1,
    JSON.stringify(connectorRetry),
  );
  assert.equal(
    connectorRetry.state.modelReselections,
    1,
    JSON.stringify(connectorRetry),
  );
  assert.ok(
    connectorRetry.state.cleanupRetries >= 4,
    JSON.stringify(connectorRetry),
  );
  assert.equal(connectorRetry.state.loads, 1, JSON.stringify(connectorRetry));
  for (const trace of connectorRetry.traces.slice(1)) {
    assert.ok(
      trace.preparationSteps.some(
        (step) =>
          step.stage === "connector-conversation-binding" &&
          step.outcome === "completed",
      ),
      JSON.stringify(connectorRetry),
    );
    assert.ok(
      !trace.preparationSteps.some((step) => step.stage === "connector-select"),
    );
    assert.ok(
      !trace.preparationSteps.some(
        (step) =>
          step.stage === "reload-stale-connector-picker" ||
          step.stage === "rebuild-stale-connector-conversation",
      ),
    );
  }
  assert.doesNotMatch(
    JSON.stringify(connectorRetry.traces),
    /private-connector-input|<script|data:text/,
  );

  const modernConnector = await app.evaluate(
    async ({ BrowserWindow }, html) => {
      const traces = [];
      const controller = new globalThis.ChatGptBrowserController(
        "data:text/html;charset=utf-8," + encodeURIComponent(html),
        undefined,
        undefined,
        async (trace) => traces.push(trace),
      );
      const outputs = [];
      let error;
      try {
        for (let index = 0; index < 2; index++) {
          outputs.push(
            await controller.runTurn({
              mode: "pro",
              threadId: "modern-connector-pro-task",
              turnId: "modern-connector-pro-" + index,
              operationId: "modern-connector-pro-" + index,
              prompt: "private-modern-connector-input",
              images: [],
              allowWebNativeTools: true,
              connectorName: "CodexGPT Bridge",
              signal: globalThis.AbortSignal.timeout(30_000),
            }),
          );
        }
      } catch (caught) {
        error = caught.message;
      }
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().startsWith("data:"),
      );
      const state = window
        ? await window.webContents.executeJavaScript(
            "JSON.parse(window.name || '{}')",
          )
        : {};
      await controller.close();
      return { outputs, error, traces, state };
    },
    connectorRetryFixture({ appMention: true, pro: true }),
  );
  assert.equal(
    modernConnector.error,
    undefined,
    JSON.stringify(modernConnector),
  );
  assert.equal(modernConnector.outputs.length, 2);
  assert.deepEqual(modernConnector.state.selectedAtSend, ["Pro", "Pro"]);
  assert.equal(modernConnector.state.connectorActivations, 1);
  assert.equal(modernConnector.state.mentionTriggerInputs, 1);
  assert.equal(modernConnector.state.preConnectorModelClicks, 0);
  assert.equal(modernConnector.state.loads, 1);
  assert.ok(
    modernConnector.traces[0].preparationSteps.some(
      (step) =>
        step.stage === "select-mode-after-connector" &&
        step.outcome === "completed",
    ),
  );
  assert.ok(
    !modernConnector.traces[1].preparationSteps.some(
      (step) => step.stage === "connector-select",
    ),
  );
  process.stdout.write(
    "ProseMirror App mention preparation E2E passed: exact App, automatic Pro level and retained follow-up.\n",
  );

  const failedConnectorCleanup = await app.evaluate(
    async ({ BrowserWindow }, html) => {
      const traces = [];
      const controller = new globalThis.ChatGptBrowserController(
        "data:text/html;charset=utf-8," + encodeURIComponent(html),
        undefined,
        undefined,
        async (trace) => traces.push(trace),
      );
      let error;
      try {
        await controller.runTurn({
          mode: "high",
          threadId: "missing-connector-cleanup-task",
          turnId: "missing-connector-cleanup-turn",
          operationId: "missing-connector-cleanup-operation",
          prompt: "private-missing-connector-input",
          images: [],
          allowWebNativeTools: true,
          connectorName: "Missing Bridge",
          signal: globalThis.AbortSignal.timeout(35_000),
        });
      } catch (caught) {
        error = caught.message;
      }
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().startsWith("data:"),
      );
      const composer = window
        ? await window.webContents.executeJavaScript(`(() => {
            const root = document.querySelector('#prompt-textarea');
            return {
              text: root?.textContent ?? '',
              selections: root?.querySelectorAll('[data-id^="plugin:"], [data-id^="connector:"], [data-id^="app:"]').length ?? -1,
              sends: JSON.parse(window.name || '{}').sends ?? 0
            };
          })()`)
        : {};
      await controller.close();
      return { error, traces, composer };
    },
    connectorRetryFixture(),
  );
  assert.match(
    failedConnectorCleanup.error,
    /could not select the exact Full MCP connector/i,
  );
  assert.equal(failedConnectorCleanup.composer.sends, 0);
  assert.equal(failedConnectorCleanup.composer.text, "");
  assert.equal(failedConnectorCleanup.composer.selections, 0);
  assert.ok(
    failedConnectorCleanup.traces
      .at(-1)
      .preparationSteps.some(
        (step) => step.stage === "reload-stale-connector-picker",
      ),
  );

  const retainedHtml = retainedConnectorReopenFixture();
  fixtureServer = createServer((request, response) => {
    if (request.url === "/api/auth/session") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end('{"user":{"id":"fixture-user"}}');
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(retainedHtml);
  });
  await new Promise((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(0, "127.0.0.1", resolve);
  });
  const address = fixtureServer.address();
  assert.ok(address && typeof address !== "string");
  const retainedBaseUrl = `http://127.0.0.1:${address.port}/`;
  const retainedConversationUrl = `${retainedBaseUrl}c/retained-bridge-task`;
  const retainedConversationFile = join(
    directory,
    "retained-reopen-conversations.json",
  );
  await writeFile(
    retainedConversationFile,
    JSON.stringify({
      version: 1,
      conversations: [["retained-reopen-task", retainedConversationUrl]],
      receipts: [],
      projects: [],
      temporary: [],
    }),
  );
  const retainedReopen = await app.evaluate(
    async (
      { BrowserWindow },
      { baseUrl, conversationFile, conversationUrl },
    ) => {
      const traces = [];
      const controller = new globalThis.ChatGptBrowserController(
        baseUrl,
        conversationFile,
        undefined,
        async (trace) => traces.push(trace),
      );
      let output;
      let error;
      try {
        output = await controller.runTurn({
          mode: "high",
          threadId: "retained-reopen-task",
          turnId: "retained-reopen-turn",
          operationId: "retained-reopen-operation",
          prompt: "private-retained-reopen-input",
          images: [],
          allowWebNativeTools: true,
          connectorName: "CodexGPT Bridge",
          signal: globalThis.AbortSignal.timeout(40_000),
        });
      } catch (caught) {
        error = caught.message;
      }
      const window = BrowserWindow.getAllWindows().find(
        (candidate) =>
          candidate.webContents.getURL().split("?", 1)[0] === conversationUrl,
      );
      const state = window
        ? await window.webContents.executeJavaScript(
            "JSON.parse(window.name || '{}')",
          )
        : {};
      const finalUrl = window?.webContents.getURL().split("?", 1)[0];
      await controller.close();
      return { output, error, traces, state, finalUrl };
    },
    {
      baseUrl: retainedBaseUrl,
      conversationFile: retainedConversationFile,
      conversationUrl: retainedConversationUrl,
    },
  );
  assert.equal(retainedReopen.error, undefined, JSON.stringify(retainedReopen));
  assert.equal(
    retainedReopen.output,
    "REOPEN_OK",
    JSON.stringify(retainedReopen),
  );
  assert.equal(retainedReopen.state.sends, 1, JSON.stringify(retainedReopen));
  assert.equal(retainedReopen.state.connectorActivations, 1);
  assert.deepEqual(retainedReopen.state.sendPaths, ["/c/retained-bridge-task"]);
  assert.equal(retainedReopen.state.baseVisits, 2);
  assert.equal(retainedReopen.state.conversationLoads, 3);
  assert.equal(retainedReopen.finalUrl, retainedConversationUrl);
  const retainedTrace = retainedReopen.traces.at(-1);
  assert.ok(
    retainedTrace.preparationSteps.some(
      (step) => step.stage === "reload-stale-connector-picker",
    ),
    JSON.stringify(retainedReopen),
  );
  assert.ok(
    retainedTrace.preparationSteps.some(
      (step) => step.stage === "reopen-stale-connector-conversation",
    ),
    JSON.stringify(retainedReopen),
  );
  assert.ok(
    !retainedTrace.preparationSteps.some(
      (step) => step.stage === "rebuild-stale-connector-conversation",
    ),
  );
  const retainedMapping = JSON.parse(
    await readFile(retainedConversationFile, "utf8"),
  );
  assert.deepEqual(retainedMapping.conversations, [
    ["retained-reopen-task", retainedConversationUrl],
  ]);
  process.stdout.write(
    "Preparation E2E: an existing exact App binding was reused across five retained turns while the picker hid the App.\n",
  );
  process.stdout.write(
    "Preparation E2E: stale picker reopened the same retained conversation without creating a replacement.\n",
  );
  process.stdout.write(
    "Preparation E2E: a missing App left no unsent query, App node or submission behind.\n",
  );
  if (process.env.BRIDGE_PREPARATION_REPORT)
    await writeFile(
      process.env.BRIDGE_PREPARATION_REPORT,
      JSON.stringify(results, null, 2) + "\n",
    );
  process.stdout.write(
    "Preparation E2E passed: cold/warm selection, delayed controls, Configure, drift, disabled/missing state, reconnect and timing evidence.\n",
  );
} finally {
  await app?.close();
  await new Promise((resolve) => fixtureServer?.close(resolve) ?? resolve());
  await rm(directory, { recursive: true, force: true });
}
