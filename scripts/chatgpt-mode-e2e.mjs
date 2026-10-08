import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron } from "playwright-core";

// Exercise the actual controller and generated renderer scripts. A regex unit test
// alone cannot catch escapes consumed when a script is embedded in a template literal.
function fixture(proLabel, disabled = false) {
  return `<!doctype html><main>
    <button data-testid="model-switcher-dropdown-button" aria-haspopup="menu">Extra High</button>
    <div id="prompt-textarea" contenteditable="true"> </div>
    <button data-testid="send-button">Send</button><div id="messages"></div>
    </main><script>
    const picker = document.querySelector('button');
    let selected = 'Extra High';
    window.sends = 0;
    window.menuOpens = 0;
    window.modelChanges = 0;
    picker.onclick = () => {
      const existing = document.querySelector('[role="menu"]');
      if (existing) { existing.remove(); return; }
      window.menuOpens++;
      const menu = document.createElement('div');
      menu.role = 'menu';
      menu.innerHTML = '<button role="menuitemradio">GPT-5</button><button role="menuitem" id="effort"><span role="slider" aria-valuemin="0" aria-valuemax="3" aria-valuenow="3">Extra High</span></button><button role="menuitemradio" id="pro" aria-disabled="${disabled}"></button>';
      menu.querySelector('#pro').textContent = ${JSON.stringify(proLabel)};
      menu.querySelector('#pro').onclick = () => {
        if (${disabled}) return;
        selected = picker.textContent = 'Pro'; menu.remove();
      };
      const slider = menu.querySelector('[role="slider"]');
      const initialEffort = selected === 'Pro' ? 'Extra High' : selected;
      slider.setAttribute('aria-valuenow', ['Instant', 'Medium', 'High', 'Extra High'].indexOf(initialEffort));
      slider.textContent = initialEffort;
      menu.querySelector('#effort').onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        const value = Math.max(0, Math.min(3, Number(slider.getAttribute('aria-valuenow')) + (event.key === 'ArrowRight' ? 1 : -1)));
        slider.setAttribute('aria-valuenow', value);
        selected = picker.textContent = slider.textContent = ['Instant', 'Medium', 'High', 'Extra High'][value];
      };
      document.body.append(menu);
    };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelector('[role="menu"]')?.remove(); });
    document.querySelector('[data-testid="send-button"]').onclick = () => {
      window.sends++;
      const prompt = document.querySelector('#prompt-textarea');
      const user = document.createElement('div');
      user.setAttribute('data-message-author-role', 'user');
      user.textContent = prompt.textContent; prompt.textContent = '';
      document.querySelector('#messages').append(user);
      const reply = document.createElement('div');
      reply.setAttribute('data-testid', 'conversation-turn-' + window.sends);
      reply.innerHTML = '<div data-message-author-role="assistant">SELECTED:' + selected + '</div><button data-testid="copy-turn-button">Copy</button>';
      document.querySelector('#messages').append(reply);
    };
    </script>`;
}

// September UI: Pro is the fifth slider position, with a separate, initially
// inert model panel. Keep the selected model: Latest, GPT-5.6 Sol, or GPT-5.5.
function sliderFixture(
  locked = false,
  endpointLabel = "Pro",
  initialModel = "最新的",
  delayedSlider = false,
) {
  return (
    fixture("Pro") +
    `<script>
    let modelName = ${JSON.stringify(initialModel)};
    picker.onclick = () => {
      const existing = document.querySelector('[role="menu"]');
      if (existing) { existing.remove(); return; }
      window.menuOpens++;
      const menu = document.createElement('div'); menu.role = 'menu';
      menu.innerHTML = '<div data-testid="composer-intelligence-picker-content"><button role="menuitem" aria-expanded="false" id="toggle">極高</button><button role="menuitem" id="effort"><span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="3">Effort</span></button><div data-testid="composer-model-picker-slider-advanced-view" inert style="display:none"><button role="menuitemradio">最新的</button><button role="menuitemradio">GPT-5.6 Sol</button><button role="menuitemradio">GPT-5.5</button></div></div>';
      const panel = menu.querySelector('[inert]');
      const toggle = menu.querySelector('#toggle');
      const slider = menu.querySelector('[role="slider"]');
      if (${delayedSlider}) {
        slider.remove();
        setTimeout(() => menu.querySelector('#effort').append(slider), 850);
      }
      const labels = ['Instant', 'Medium', 'High', 'Extra High', ${JSON.stringify(endpointLabel)}];
      slider.setAttribute('aria-valuenow', Math.max(0, labels.indexOf(selected)));
      const update = () => {
        toggle.textContent = (modelName === 'GPT-5.5' ? '5.5' : modelName) + selected;
        for (const option of panel.children) option.setAttribute('aria-checked', String(option.textContent === modelName));
      };
      toggle.onclick = () => { panel.inert = false; panel.style.display = ''; toggle.setAttribute('aria-expanded', 'true'); };
      for (const option of panel.children) option.onclick = () => {
        window.modelChanges++;
        modelName = option.textContent; panel.inert = true; panel.style.display = 'none'; toggle.setAttribute('aria-expanded', 'false'); update();
      };
      menu.querySelector('#effort').onkeydown = e => {
        if (${locked} || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        const value = Math.max(0, Math.min(4, Number(slider.getAttribute('aria-valuenow')) + (e.key === 'ArrowRight' ? 1 : -1)));
        slider.setAttribute('aria-valuenow', value); selected = picker.textContent = labels[value]; update();
      };
      update(); document.body.append(menu);
    };
    </script>`
  );
}

function nativeVersionSliderFixture(
  override = null,
  hiddenThumb = false,
  sol61 = false,
) {
  const html = sliderFixture()
    .replace(
      '<button role="menuitemradio">GPT-5.5</button>',
      sol61
        ? '<button role="menuitemradio">GPT-5.5</button><button role="menuitemradio">GPT-6.1 Sol</button>'
        : '<button role="menuitemradio">GPT-5.5</button>',
    )
    .replace(
      "const update = () => {",
      `const description = document.createElement('span'); description.id = 'native-model-description';
      menu.append(description); menu.querySelector('#effort').setAttribute('aria-describedby', description.id);
      const update = () => {
        description.textContent = ${JSON.stringify(override)} ?? ((modelName === 'GPT-6.1 Sol' ? modelName : modelName === '最新的' && selected === 'Pro' ? 'GPT-6 Astra' : 'GPT-5.6 Sol') + (selected === 'Pro' ? ' Pro, max' : ' Thinking, ' + selected));`,
    );
  return hiddenThumb
    ? html
        .replace(
          'role="slider" aria-valuemin',
          'role="slider" aria-hidden="true" aria-valuemin',
        )
        .replace(
          'id="effort"',
          'id="effort" aria-keyshortcuts="ArrowLeft ArrowRight" tabindex="0"',
        )
    : html;
}

function offFormRoleControlSliderFixture() {
  return sliderFixture()
    .replace(
      '<button data-testid="model-switcher-dropdown-button" aria-haspopup="menu">Extra High</button>',
      '<div role="button" aria-haspopup="menu" data-tone="neutral" tabindex="0">Extra High</div>',
    )
    .replace(
      '<div id="prompt-textarea" contenteditable="true"> </div>',
      '<form><div id="prompt-textarea" contenteditable="true"> </div>',
    )
    .replace(
      '<button data-testid="send-button">Send</button>',
      '<button data-testid="send-button">Send</button></form>',
    )
    .replace(
      "const picker = document.querySelector('button');",
      "const picker = document.querySelector('[role=button]');",
    );
}

function localizedInstantSliderFixture() {
  return sliderFixture()
    .replace(">Extra High</button>", ">\u5373\u6642</button>")
    .replace("let selected = 'Extra High';", "let selected = 'Instant';");
}

function ordinalSliderFixture() {
  return (
    fixture("Pro") +
    `<script>
    picker.onclick = () => {
      const existing = document.querySelector('[role="menu"]');
      if (existing) { existing.remove(); return; }
      window.menuOpens++;
      const menu = document.createElement('div'); menu.role = 'menu';
      menu.innerHTML = '<span id="ordinal-status" role="status" style="position:absolute;width:1px;height:1px"></span><div id="ordinal-proxy" role="menuitem" tabindex="0" aria-keyshortcuts="ArrowLeft ArrowRight" style="width:230px;height:32px"><span>● ● ● ● ●</span></div>';
      const labels = ['Instant', 'Medium', 'High', 'Extra High', 'Pro'];
      const status = menu.querySelector('#ordinal-status');
      const proxy = menu.querySelector('#ordinal-proxy');
      const update = () => {
        const position = labels.indexOf(selected) + 1;
        status.textContent = '5.6 ' + selected + '，第 ' + position + ' 個，共 5 個。';
        picker.textContent = selected;
      };
      proxy.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        const current = labels.indexOf(selected);
        const next = Math.max(0, Math.min(4, current + (event.key === 'ArrowRight' ? 1 : -1)));
        selected = labels[next]; update();
      };
      update(); document.body.append(menu);
    };
    </script>`
  );
}

function nonOpeningRetainedModeFixture() {
  return `<!doctype html><main>
    <button data-testid="model-switcher-dropdown-button" aria-haspopup="menu">高</button>
    <div id="prompt-textarea" contenteditable="true"> </div>
    <button data-testid="send-button">Send</button><div id="messages"></div>
    </main><script>
    window.menuOpens = 0; window.sends = 0;
    document.querySelector('[data-testid="model-switcher-dropdown-button"]').onclick = () => { window.menuOpens++; };
    document.querySelector('[data-testid="send-button"]').onclick = () => {
      window.sends++;
      const prompt = document.querySelector('#prompt-textarea');
      const user = document.createElement('div');
      user.setAttribute('data-message-author-role', 'user');
      user.textContent = prompt.textContent; prompt.textContent = '';
      const reply = document.createElement('div');
      reply.setAttribute('data-testid', 'conversation-turn-' + window.sends);
      reply.innerHTML = '<div data-message-author-role="assistant">RETAINED_HIGH_OK</div><button data-testid="copy-turn-button">Copy</button>';
      document.querySelector('#messages').append(user, reply);
    };
    </script>`;
}

function lunaFixture(thinkCommandAvailable = true) {
  return `<!doctype html><style>
    #prompt-textarea { width: 500px; min-height: 40px; border: 1px solid #777; }
    .popover { position: fixed; left: 20px; top: 70px; width: 240px; height: 50px; }
  </style><main><form>
    <div id="prompt-textarea" data-testid="prompt-textarea" contenteditable="true"> </div>
    <button type="button" id="think-toggle" aria-pressed="false">Think</button>
    <button type="button" data-testid="send-button">Send</button>
  </form><div id="messages"></div></main><script>
    const prompt = document.querySelector('#prompt-textarea');
    const thinkToggle = document.querySelector('#think-toggle');
    let lunaMode = 'Luna';
    window.sends = 0;
    window.commandUses = 0;
    const removeCommand = () => document.querySelector('.popover')?.remove();
    const updateCommand = () => {
      removeCommand();
      if (!${thinkCommandAvailable} || prompt.textContent.trim() !== '/think') return;
      const popover = document.createElement('div');
      popover.className = 'popover'; popover.setAttribute('aria-busy', 'false');
      const row = document.createElement('button');
      row.type = 'button'; row.className = '__menu-item'; row.tabIndex = 0;
      row.setAttribute('data-highlighted', ''); row.textContent = 'Think';
      popover.append(row); document.body.append(popover);
    };
    prompt.addEventListener('input', updateCommand);
    document.addEventListener('keydown', event => {
      const popover = document.querySelector('.popover');
      if (event.key === 'Escape') { removeCommand(); return; }
      if (!popover) return;
      if (event.key === 'ArrowDown') {
        popover.querySelector('.__menu-item')?.setAttribute('data-highlighted', '');
        event.preventDefault(); return;
      }
      if (event.key === 'Enter') {
        event.preventDefault(); window.commandUses++;
        lunaMode = lunaMode === 'Think' ? 'Luna' : 'Think';
        thinkToggle.setAttribute('aria-pressed', String(lunaMode === 'Think'));
        prompt.textContent = ''; removeCommand();
      }
    });
    document.querySelector('[data-testid="send-button"]').onclick = () => {
      window.sends++;
      const user = document.createElement('div');
      user.setAttribute('data-message-author-role', 'user');
      user.textContent = prompt.textContent; prompt.textContent = '';
      const reply = document.createElement('div');
      reply.setAttribute('data-testid', 'conversation-turn-' + window.sends);
      reply.innerHTML = '<div data-message-author-role="assistant">LUNA_SELECTED:' + lunaMode + '</div><button data-testid="copy-turn-button">Copy</button>';
      document.querySelector('#messages').append(user, reply);
    };
  </script>`;
}

const directory = await mkdtemp(join(tmpdir(), "bridge-mode-e2e-"));
let app;
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [fileURLToPath(new URL("./chatgpt-mode-host.mjs", import.meta.url))],
    env: { ...process.env, CODEXGPT_BRIDGE_DOM_TEST_PROFILE: directory },
  });
  {
    const proof = await app.evaluate(async ({ BrowserWindow }, html) => {
      const controller = new globalThis.ChatGptBrowserController(
        "data:text/html;charset=utf-8," + encodeURIComponent(html),
      );
      try {
        const families = await controller.probeNativeModelFamilies();
        const window = BrowserWindow.getAllWindows().find((item) =>
          item.webContents.getURL().startsWith("data:"),
        );
        return {
          families,
          ...(await window.webContents.executeJavaScript(
            "({sends: window.sends, modelChanges: window.modelChanges})",
          )),
        };
      } finally {
        await controller.close();
      }
    }, nativeVersionSliderFixture());
    assert.deepEqual(proof, {
      families: ["5.6", "6"],
      sends: 0,
      modelChanges: 0,
    });
    process.stdout.write(
      "Mode E2E: native family discovery used enabled composer options without Send\n",
    );
  }
  for (const [family, mode, override, reject, hiddenThumb] of [
    ["5.6", "high", null, false],
    ["5.6", "pro", null, false],
    ["6", "pro", null, false],
    ["6", "medium", null, false],
    ["6", "pro", "GPT-7 Astra Pro, max", true],
    ["6", "pro", "GPT-5.6 Sol Pro, max", true],
    ["5.6", "high", "", true],
    ["6", "pro", null, false, true],
    ["6.1", "high", null, false],
    ["6.1", "medium", null, false],
    ["6.1", "high", "GPT-5.6 Sol Thinking, High", true],
    ["6.1", "pro", "GPT-6 Astra Pro, max", true],
  ]) {
    const result = await app.evaluate(
      async ({ BrowserWindow }, { html, family, mode }) => {
        const receipts = [];
        const controller = new globalThis.ChatGptBrowserController(
          "data:text/html;charset=utf-8," + encodeURIComponent(html),
          undefined,
          async (receipt) => {
            receipts.push(receipt);
          },
        );
        let output, error;
        try {
          try {
            output = await controller.runTurn({
              mode,
              modelFamily: `bridge-native:${family}`,
              threadId: "native-version-fixture",
              turnId: "native-version-turn",
              prompt: "verify native model",
              images: [],
              signal: globalThis.AbortSignal.timeout(25_000),
            });
          } catch (failure) {
            error = failure.message;
          }
          const window = BrowserWindow.getAllWindows().find((item) =>
            item.webContents.getURL().startsWith("data:"),
          );
          return {
            output,
            error,
            receipts,
            sends: window
              ? await window.webContents.executeJavaScript("window.sends")
              : -1,
          };
        } finally {
          await controller.close();
        }
      },
      {
        html: nativeVersionSliderFixture(
          override,
          hiddenThumb,
          family === "6.1",
        ),
        family,
        mode,
      },
    );
    if (reject) {
      assert.equal(result.sends, 0, JSON.stringify(result));
      assert.match(result.error, /verification failed/);
      assert.equal(result.receipts.at(-1).confidence, "REJECTED");
    } else {
      assert.equal(result.sends, 1, JSON.stringify(result));
      assert.equal(result.receipts.at(-1).confidence, "UI_VERIFIED");
      assert.equal(result.receipts.at(-1).backendIdentity, "NOT_OBSERVED");
    }
    process.stdout.write(
      `Mode E2E: native ${family} / ${mode} version proof ${reject ? "rejected before Send" : "passed"}\n`,
    );
  }
  {
    const capabilities = await app.evaluate(
      async (_electron, html) => {
        const controller = new globalThis.ChatGptBrowserController(
          "data:text/html;charset=utf-8," + encodeURIComponent(html),
        );
        try {
          return await controller.probeCapabilities();
        } finally {
          await controller.close();
        }
      },
      sliderFixture().replace('aria-valuemax="4"', 'aria-valuemax="3"'),
    );
    assert.deepEqual(capabilities, {
      availableModes: ["instant", "medium", "high", "extra-high"],
      source: "slider",
    });
    process.stdout.write(
      "Mode E2E: account capability probe omitted unavailable Pro\n",
    );
  }
  {
    const capabilities = await app.evaluate(async (_electron, html) => {
      const controller = new globalThis.ChatGptBrowserController(
        "data:text/html;charset=utf-8," + encodeURIComponent(html),
      );
      try {
        return await controller.probeCapabilities();
      } finally {
        await controller.close();
      }
    }, ordinalSliderFixture());
    assert.deepEqual(capabilities, {
      availableModes: ["instant", "medium", "high", "extra-high", "pro"],
      source: "slider",
    });
    process.stdout.write(
      "Mode E2E: sliderless ordinal status proved all five modes\n",
    );
  }
  {
    const capabilities = await app.evaluate(async ({ BrowserWindow }, html) => {
      const controller = new globalThis.ChatGptBrowserController(
        "data:text/html;charset=utf-8," + encodeURIComponent(html),
      );
      try {
        const result = await controller.probeCapabilities();
        const window = BrowserWindow.getAllWindows().find((item) =>
          item.webContents.getURL().startsWith("data:"),
        );
        return {
          result,
          state: await window.webContents.executeJavaScript(
            "({pressed: document.querySelector('#think-toggle').getAttribute('aria-pressed'), commandUses: window.commandUses})",
          ),
        };
      } finally {
        await controller.close();
      }
    }, lunaFixture());
    assert.deepEqual(capabilities, {
      result: {
        availableModes: ["luna", "think"],
        source: "no-model-control",
      },
      state: { pressed: "false", commandUses: 2 },
    });
    process.stdout.write(
      "Mode E2E: Luna capability probe proved /think and restored Luna\n",
    );
  }
  {
    const result = await app.evaluate(async ({ BrowserWindow }, html) => {
      const controller = new globalThis.ChatGptBrowserController(
        "data:text/html;charset=utf-8," + encodeURIComponent(html),
      );
      const outputs = [];
      try {
        for (const mode of ["luna", "think", "luna"]) {
          outputs.push(
            await controller.runTurn({
              mode,
              threadId: "luna-mode-task",
              turnId: `luna-mode-turn-${outputs.length}`,
              prompt: "luna fixture",
              images: [],
              signal: globalThis.AbortSignal.timeout(20_000),
            }),
          );
        }
        const window = BrowserWindow.getAllWindows().find((item) =>
          item.webContents.getURL().startsWith("data:"),
        );
        return {
          outputs,
          state: await window.webContents.executeJavaScript(
            "({sends: window.sends, commandUses: window.commandUses, pressed: document.querySelector('#think-toggle').getAttribute('aria-pressed')})",
          ),
        };
      } finally {
        await controller.close();
      }
    }, lunaFixture());
    assert.deepEqual(result, {
      outputs: [
        "LUNA_SELECTED:Luna",
        "LUNA_SELECTED:Think",
        "LUNA_SELECTED:Luna",
      ],
      state: { sends: 3, commandUses: 2, pressed: "false" },
    });
    process.stdout.write(
      "Mode E2E: Luna and Think routes toggled and verified before Send\n",
    );
  }
  {
    const result = await app.evaluate(async ({ BrowserWindow }, html) => {
      const controller = new globalThis.ChatGptBrowserController(
        "data:text/html;charset=utf-8," + encodeURIComponent(html),
      );
      try {
        const capabilities = await controller.probeCapabilities();
        let error = "";
        try {
          await controller.runTurn({
            mode: "think",
            threadId: "missing-think-task",
            turnId: "missing-think-turn",
            prompt: "must not send",
            images: [],
            signal: globalThis.AbortSignal.timeout(20_000),
          });
        } catch (cause) {
          error = cause.message;
        }
        const window = BrowserWindow.getAllWindows().find((item) =>
          item.webContents.getURL().startsWith("data:"),
        );
        return {
          capabilities,
          error,
          state: await window.webContents.executeJavaScript(
            "({sends: window.sends, draft: document.querySelector('#prompt-textarea').textContent})",
          ),
        };
      } finally {
        await controller.close();
      }
    }, lunaFixture(false));
    assert.deepEqual(result.capabilities, {
      availableModes: ["luna"],
      source: "no-model-control",
    });
    assert.match(result.error, /\/think command is unavailable/);
    assert.deepEqual(result.state, { sends: 0, draft: "" });
    process.stdout.write(
      "Mode E2E: unavailable Think stayed out of the catalog and failed before Send\n",
    );
  }
  {
    const result = await app.evaluate(async ({ BrowserWindow }, html) => {
      const controller = new globalThis.ChatGptBrowserController(
        "data:text/html;charset=utf-8," + encodeURIComponent(html),
      );
      try {
        const output = await controller.runTurn({
          mode: "high",
          threadId: "retained-mode-task",
          turnId: "retained-mode-turn",
          prompt: "mode fixture",
          images: [],
          signal: globalThis.AbortSignal.timeout(20_000),
        });
        const window = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().startsWith("data:"),
        );
        return {
          output,
          menuOpens:
            await window.webContents.executeJavaScript("window.menuOpens"),
          sends: await window.webContents.executeJavaScript("window.sends"),
        };
      } finally {
        await controller.close();
      }
    }, nonOpeningRetainedModeFixture());
    assert.deepEqual(result, {
      output: "RETAINED_HIGH_OK",
      menuOpens: 0,
      sends: 1,
    });
    process.stdout.write(
      "Mode E2E: retained High verified without opening its unavailable picker\n",
    );
  }
  {
    const result = await app.evaluate(async ({ BrowserWindow }, html) => {
      const controller = new globalThis.ChatGptBrowserController(
        "data:text/html;charset=utf-8," + encodeURIComponent(html),
      );
      try {
        let code;
        try {
          await controller.runTurn({
            mode: "high",
            threadId: "missing-full-checkpoint",
            turnId: "missing-full-checkpoint-turn",
            prompt: "must not send to a replacement conversation",
            images: [],
            allowWebNativeTools: true,
            connectorName: "Bridge",
            requireRetainedConversation: true,
            signal: globalThis.AbortSignal.timeout(20_000),
          });
        } catch (error) {
          code = error.code;
        }
        const window = BrowserWindow.getAllWindows().find((item) =>
          item.webContents.getURL().startsWith("data:"),
        );
        return {
          code,
          sends: await window.webContents.executeJavaScript("window.sends"),
        };
      } finally {
        await controller.close();
      }
    }, fixture("Pro"));
    assert.deepEqual(result, {
      code: "bridge_retained_full_source_unavailable",
      sends: 0,
    });
    process.stdout.write(
      "Mode E2E: missing Full checkpoint source failed before Send\n",
    );
  }
  for (const [label, disabled] of [
    ["Pro", false],
    ["Pro\nResearch-grade intelligence", false],
    ["Pro", true],
    ["slider", false],
    ["5.5-slider", false],
    ["5.6-slider", false],
    ["ordinal-slider", false],
    ["delayed-slider", false],
    ["delayed-control-slider", false],
    ["off-form-role-control-slider", false],
    ["localized-instant-slider", false],
    ["locked-slider", true],
    ["wrong-slider", true],
  ]) {
    process.stdout.write(
      `Mode E2E: ${JSON.stringify(label)}, disabled=${disabled}\n`,
    );
    const result = await app.evaluate(
      async ({ BrowserWindow }, { html, disabled }) => {
        const controller = new globalThis.ChatGptBrowserController(
          "data:text/html;charset=utf-8," + encodeURIComponent(html),
        );
        const outputs = [];
        try {
          for (const mode of disabled ? ["pro"] : ["pro", "medium", "pro"]) {
            outputs.push(
              await controller.runTurn({
                mode,
                threadId: "mode-e2e-task",
                turnId: `mode-e2e-turn-${outputs.length}`,
                prompt: "mode fixture",
                images: [],
                signal: globalThis.AbortSignal.timeout(20_000),
              }),
            );
          }
          const window = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().startsWith("data:"),
          );
          return {
            outputs,
            ...(await window.webContents.executeJavaScript(
              "({menuOpens: window.menuOpens, sends: window.sends, modelChanges: window.modelChanges})",
            )),
          };
        } catch (error) {
          const window = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().startsWith("data:"),
          );
          return {
            error: error.message,
            sends: window
              ? await window.webContents.executeJavaScript("window.sends")
              : -1,
          };
        } finally {
          await controller.close();
        }
      },
      {
        html:
          label === "off-form-role-control-slider"
            ? offFormRoleControlSliderFixture()
            : label === "localized-instant-slider"
              ? localizedInstantSliderFixture()
              : label === "ordinal-slider"
                ? ordinalSliderFixture()
                : label.endsWith("slider")
                  ? sliderFixture(
                      label === "locked-slider",
                      label === "wrong-slider" ? "Maximum" : "Pro",
                      label === "5.5-slider"
                        ? "GPT-5.5"
                        : label === "5.6-slider"
                          ? "GPT-5.6 Sol"
                          : "最新的",
                      label === "delayed-slider",
                    ) +
                    (label === "delayed-control-slider"
                      ? '<script>picker.style.display="none"; setTimeout(() => picker.style.display="", 850);</script>'
                      : "")
                  : fixture(label, disabled),
        disabled,
      },
    );
    if (disabled) {
      assert.equal(result.sends, 0);
      assert.match(
        result.error,
        label === "locked-slider"
          ? /reasoning level could not be selected/
          : label === "wrong-slider"
            ? /did not confirm Pro for the current model/
            : /Pro mode is disabled/,
      );
    } else {
      // Selection opens once per requested change. The final mode-only receipt
      // now trusts the scoped composer label and does not reopen the picker.
      assert.ok(result.menuOpens >= 3, JSON.stringify(result));
      assert.deepEqual(
        { ...result, menuOpens: 3 },
        {
          outputs: ["SELECTED:Pro", "SELECTED:Medium", "SELECTED:Pro"],
          menuOpens: 3,
          sends: 3,
          modelChanges: 0,
        },
      );
    }
  }
  for (const [family, expectedFailure] of [
    ["GPT-5.5", false],
    ["GPT-6 Missing", true],
  ]) {
    const result = await app.evaluate(
      async ({ BrowserWindow }, { html, family }) => {
        const receipts = [];
        const controller = new globalThis.ChatGptBrowserController(
          "data:text/html;charset=utf-8," + encodeURIComponent(html),
          undefined,
          async (receipt) => {
            receipts.push(receipt);
          },
        );
        try {
          const output = await controller.runTurn({
            mode: "high",
            modelFamily: family,
            threadId: "mode-pin-e2e-task",
            turnId: "mode-pin-e2e-turn",
            prompt: "model pin fixture",
            images: [],
            signal: globalThis.AbortSignal.timeout(20_000),
          });
          return { output, receipts };
        } catch (error) {
          const window = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().startsWith("data:"),
          );
          return {
            error: error.message,
            sends: window
              ? await window.webContents.executeJavaScript("window.sends")
              : -1,
          };
        } finally {
          await controller.close();
        }
      },
      { html: sliderFixture(), family },
    );
    if (expectedFailure) {
      assert.equal(result.sends, 0);
      assert.match(result.error, /unavailable|could not be selected/);
    } else {
      assert.equal(result.output, "SELECTED:High");
      assert.equal(result.receipts.at(-1).observed.model, family);
      assert.equal(result.receipts.at(-1).confidence, "UI_VERIFIED");
      assert.equal(result.receipts.at(-1).backendIdentity, "NOT_OBSERVED");
      assert.equal(result.receipts.at(-1).phase, "completed");
    }
  }
  for (const scenario of ["ignored-click", "changed-on-input"]) {
    const html =
      scenario === "ignored-click"
        ? fixture("Pro").replace(
            "selected = picker.textContent = 'Pro'; menu.remove();",
            "selected = picker.textContent = 'High'; menu.remove();",
          )
        : sliderFixture() +
          `<script>document.querySelector('#prompt-textarea').addEventListener('input', () => { selected = picker.textContent = 'Medium'; });</script>`;
    const result = await app.evaluate(
      async ({ BrowserWindow }, { html, mode }) => {
        const receipts = [];
        const controller = new globalThis.ChatGptBrowserController(
          "data:text/html;charset=utf-8," + encodeURIComponent(html),
          undefined,
          async (receipt) => {
            receipts.push(receipt);
          },
        );
        try {
          await controller.runTurn({
            mode,
            threadId: "drift-model-task",
            turnId: "drift-model-turn",
            prompt: "selection drift fixture",
            images: [],
            signal: globalThis.AbortSignal.timeout(20_000),
          });
          return { error: "unexpected success", sends: -1, receipts };
        } catch (error) {
          const window = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().startsWith("data:"),
          );
          return {
            error: error.message,
            sends: window
              ? await window.webContents.executeJavaScript("window.sends")
              : -1,
            receipts,
          };
        } finally {
          await controller.close();
        }
      },
      { html, mode: scenario === "ignored-click" ? "pro" : "high" },
    );
    assert.equal(result.sends, 0, JSON.stringify(result));
    assert.match(result.error, /selection verification failed/i);
    assert.equal(result.receipts.at(-1).confidence, "REJECTED");
    assert.equal(result.receipts.at(-1).phase, "failed");
  }
  process.stdout.write(
    "Mode E2E passed: repeated modes, model pinning, unavailable/disabled models, ignored clicks and pre-submit selection drift.\n",
  );
} finally {
  await app?.close();
  // mkdtemp creates this test-owned directory directly under the system temp root.
  await rm(directory, { recursive: true, force: true });
}
