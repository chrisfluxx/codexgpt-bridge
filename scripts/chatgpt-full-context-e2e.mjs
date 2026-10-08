import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron } from "playwright-core";

function fixture(badAck = false) {
  return `<!doctype html><main><form onsubmit="return false">
    <div id="prompt-textarea" contenteditable="true" style="width:500px;height:80px;overflow:auto"></div>
    <button type="button" data-testid="model-switcher-dropdown-button" aria-haspopup="menu">High</button>
    <button type="button" data-testid="send-button">Send</button></form><div id="messages"></div></main><script>
    const composer = document.querySelector('#prompt-textarea');
    const picker = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
    window.sent = []; window.acks = []; window.commits = 0;
    picker.onclick = () => {
      const menu = document.createElement('div'); menu.role = 'menu';
      menu.innerHTML = '<div data-testid="composer-intelligence-picker-content"><button role="menuitem" aria-expanded="false">GPT-5.6 Sol High</button><button role="menuitem" id="effort" aria-describedby="version-description"><span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="2" aria-valuetext="High">High</span></button><span id="version-description">GPT-5.6 Sol Thinking, High</span><div inert style="display:none"><button role="menuitemradio" aria-checked="true">GPT-5.6 Sol</button></div></div>';
      document.body.append(menu);
    };
    document.addEventListener('keydown', event => { if (event.key === 'Escape') document.querySelector('[role="menu"], [role="listbox"]')?.remove(); });
    composer.addEventListener('input', () => {
      if (!composer.textContent.includes('@CodexGPT')) return;
      document.querySelector('[role="listbox"]')?.remove();
      const menu = document.createElement('div'); menu.role = 'listbox';
      const option = document.createElement('button'); option.role = 'option'; option.textContent = 'CodexGPT Bridge';
      option.onclick = () => {
        composer.textContent = '';
        const node = document.createElement('span'); node.contentEditable = 'false'; node.dataset.id = 'plugin:codexgpt-bridge'; node.dataset.keyword = 'CodexGPT Bridge'; node.textContent = 'CodexGPT Bridge';
        composer.append(node); menu.remove();
      };
      menu.append(option); document.body.append(menu);
    });
    document.querySelector('[data-testid="send-button"]').onclick = () => {
      const text = composer.textContent; window.sent.push(text);
      const user = document.createElement('div'); user.dataset.messageAuthorRole = 'user';
      const pill = document.createElement('span'); pill.dataset.inlineSelectionPill = ''; pill.dataset.keyword = 'CodexGPT Bridge'; pill.textContent = 'CodexGPT Bridge'; user.append(pill, document.createTextNode(text));
      composer.textContent = ''; document.querySelector('#messages').append(user);
      const ack = /BRIDGE_CONTEXT_ACK ctx_[a-f0-9]{32} [1-6]\\/[2-6] [a-f0-9]{64}/.exec(text)?.[0];
      let answer;
      if (ack) { window.acks.push(ack); answer = ${badAck} ? 'WRONG_ACK' : ack; }
      else { window.commits++; answer = '<codex_text>FULL_CONTEXT_DONE</codex_text>'; }
      setTimeout(() => {
        const turn = document.createElement('div'); turn.dataset.testid = 'conversation-turn-' + window.sent.length;
        const reply = document.createElement('div'); reply.dataset.messageAuthorRole = 'assistant'; reply.textContent = answer;
        const copy = document.createElement('button'); copy.dataset.testid = 'copy-turn-button'; copy.textContent = 'Copy'; turn.append(reply, copy); document.querySelector('#messages').append(turn);
      }, 40);
    };
    </script>`;
}

const directory = await mkdtemp(join(tmpdir(), "bridge-full-context-e2e-"));
let app;
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [fileURLToPath(new URL("./chatgpt-mode-host.mjs", import.meta.url))],
    env: { ...process.env, CODEXGPT_BRIDGE_DOM_TEST_PROFILE: directory },
  });
  for (const badAck of [false, true]) {
    const result = await app.evaluate(
      async ({ BrowserWindow }, { html, badAck }) => {
        const receipts = [];
        const controller = new globalThis.ChatGptBrowserController(
          "data:text/html;charset=utf-8," + encodeURIComponent(html),
          undefined,
          async (receipt) => {
            receipts.push(receipt);
          },
        );
        let held = false,
          committed = false,
          outputs,
          error;
        const input = {
          operationId: "c".repeat(64),
          threadId: "multipart-e2e-task",
          turnId: "multipart-e2e-turn",
          mode: "high",
          modelFamily: "bridge-native:5.6",
          prompt: "Canonical records and UTF-8 data: 甲乙丙丁😀. ".repeat(190),
          contract: "FINAL_EXECUTION_CONTRACT turn_" + "b".repeat(43),
          images: [],
          allowWebNativeTools: true,
          connectorName: "CodexGPT Bridge",
          signal: globalThis.AbortSignal.timeout(60_000),
          onContextStaging: () => {
            if (held) throw new Error("Staging was submitted twice");
            held = true;
          },
          onContextCommit: () => {
            if (!held || committed) throw new Error("Invalid commit");
            committed = true;
          },
          execution: {
            version: 1,
            route: "codexgpt-bridge/gpt-5.6-sol-3x",
            mode: "high",
            operationToolTransport: "full",
            toolTransport: "full",
            attempt: "initial",
            toolCount: 1,
            sourceContextTokens: 15_000,
            inputBasis: "full-context",
            inputTokens: 15_000,
            textTokens: 6_808,
            textCharacters: 8_000,
            imageCount: 0,
            imageReserveTokens: 0,
            platformReserveTokens: 8_192,
            contextWindow: 30_000,
            autoCompactTokenLimit: 27_000,
            hardInputTokenLimit: 30_000,
            browserMessageTokenLimit: 1_500,
            browserComposerCharLimit: 3_500,
            remainingInputTokens: 15_000,
            status: "within-limit",
            budgetProfile: "owned-fixture-3x",
            contextMultiplier: 3,
          },
        };
        try {
          try {
            outputs = await Promise.all([
              controller.runTurn(input),
              controller.runTurn(input),
            ]);
            if (!badAck) outputs.push(await controller.runTurn(input));
          } catch (failure) {
            error = { message: failure.message, code: failure.code };
          }
          const window = BrowserWindow.getAllWindows().find((item) =>
            item.webContents.getURL().startsWith("data:"),
          );
          return {
            outputs,
            error,
            held,
            committed,
            receipts,
            ...(window
              ? await window.webContents.executeJavaScript(
                  "({sent: window.sent, acks: window.acks, commits: window.commits})",
                )
              : {}),
          };
        } finally {
          await controller.close();
        }
      },
      { html: fixture(badAck), badAck },
    );
    assert.equal(result.held, true, JSON.stringify(result));
    if (badAck) {
      assert.equal(result.committed, false, JSON.stringify(result));
      assert.equal(result.sent.length, 1);
      assert.equal(result.commits, 0);
      assert.equal(result.error.code, "bridge_full_context_transfer_failed");
    } else {
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.equal(result.committed, true);
      assert.equal(result.commits, 1);
      assert.ok(result.sent.length >= 2 && result.sent.length <= 6);
      assert.equal(result.acks.length, result.sent.length - 1);
      assert.equal(result.outputs.length, 3);
      assert.ok(
        result.outputs.every((text) => text.includes("FULL_CONTEXT_DONE")),
      );
      assert.ok(
        result.sent
          .slice(0, -1)
          .every(
            (text) =>
              !text.includes("FINAL_EXECUTION_CONTRACT") &&
              !text.includes("turn_" + "b".repeat(43)),
          ),
      );
      assert.match(result.sent.at(-1), /FINAL_EXECUTION_CONTRACT/);
      assert.ok(
        result.receipts.filter(
          (receipt) =>
            receipt.phase === "completed" &&
            receipt.execution?.multipart?.phase === "stage",
        ).length === result.acks.length,
      );
      assert.ok(
        result.receipts.every(
          (receipt) =>
            receipt.confidence === "UI_VERIFIED" &&
            receipt.observed.modelDescriptions?.includes(
              "GPT-5.6 Sol Thinking, High",
            ),
        ),
      );
    }
    process.stdout.write(
      `Full context Electron: ${badAck ? "bad ACK withheld commit after one stage" : "ordered stages, final-only execution and duplicate observers passed"}\n`,
    );
  }
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
