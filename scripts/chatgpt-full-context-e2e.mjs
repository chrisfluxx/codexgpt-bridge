import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron } from "playwright-core";

function fixture(
  badAck = false,
  temporaryChat = false,
  tamper = "",
  hiddenUser = false,
) {
  return `<!doctype html>${temporaryChat ? '<header id="page-header"><button aria-label="Turn off temporary chat">Temporary chat</button></header>' : ""}<main><form onsubmit="return false">
    <div id="prompt-textarea" contenteditable="true" style="width:500px;height:80px;overflow:auto"></div>
    <button type="button" data-testid="model-switcher-dropdown-button" aria-haspopup="menu">High</button>
    <button type="button" data-testid="send-button">Send</button></form><div id="messages"></div></main><script>
    const composer = document.querySelector('#prompt-textarea');
    const picker = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
    window.sent = []; window.acks = []; window.commits = 0;
    const fixtureFetch = globalThis.fetch;
    if (${hiddenUser}) globalThis.fetch = async (...args) => {
      if (!String(args[0]).includes('/backend-api/conversation')) return fixtureFetch(...args);
      const text = window.acks.at(-1) || '<codex_text>FULL_CONTEXT_DONE</codex_text>';
      const payload = { message: { id: 'answer-' + window.sent.length, author: { role: 'assistant' }, recipient: 'all', channel: 'final', status: 'finished_successfully', end_turn: true, content: { content_type: 'text', parts: [text] } } };
      return new Response('data: ' + JSON.stringify(payload) + '\\n\\ndata: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    picker.onclick = () => {
      const menu = document.createElement('div'); menu.role = 'menu';
      menu.innerHTML = '<div data-testid="composer-intelligence-picker-content"><button role="menuitem" aria-expanded="false">GPT-5.6 Sol High</button><button role="menuitem" id="effort" aria-describedby="version-description"><span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="2" aria-valuetext="High">High</span></button><span id="version-description">GPT-5.6 Sol Thinking, High</span><div inert style="display:none"><button role="menuitemradio" aria-checked="true">GPT-5.6 Sol</button></div></div>';
      document.body.append(menu);
    };
    document.addEventListener('keydown', event => { if (event.key === 'Escape') document.querySelector('[role="menu"], [role="listbox"]')?.remove(); });
    composer.addEventListener('input', () => {
      if (${hiddenUser} && window.sent.length === 1 && document.querySelector('[data-turn-key="fallback-turn-0"]')) {
        const previous = document.querySelector('[data-turn-key="fallback-turn-0"]');
        previous.dataset.turnKey = 'hydrated-turn-1';
        previous.firstElementChild.dataset.chatgptSearchUnitKey = 'hydrated-turn-1:1:assistant';
        const user = document.createElement('div'); user.dataset.userMessageBubble = ''; user.dataset.turnKey = 'hydrated-user-1'; user.textContent = window.sent[0];
        previous.before(user);
      }
      if (window.sent.length === 1 && ${JSON.stringify(tamper)}) {
        if (${JSON.stringify(tamper)} === 'inactive') document.querySelector('#page-header').innerHTML = '<button aria-label="Turn on temporary chat">Temporary chat</button>';
        if (${JSON.stringify(tamper)} === 'document') window.__codexgptBridgeTemporaryDocumentToken = crypto.randomUUID();
        if (${JSON.stringify(tamper)} === 'body') document.querySelector('[data-message-author-role="assistant"]').textContent = 'REPLACED_ACK';
      }
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
      composer.textContent = ''; if (!${hiddenUser} || window.sent.length > 1) document.querySelector('#messages').append(user);
      const ack = /BRIDGE_CONTEXT_ACK ctx_[a-f0-9]{32} [1-6]\\/[2-6] [a-f0-9]{64}/.exec(text)?.[0];
      let answer;
      if (ack) { window.acks.push(ack); answer = ${badAck} ? 'WRONG_ACK' : ack; }
      else { window.commits++; answer = '<codex_text>FULL_CONTEXT_DONE</codex_text>'; }
      setTimeout(async () => {
        const turn = document.createElement('div'); turn.dataset.testid = 'conversation-turn-' + window.sent.length;
        const reply = document.createElement('div'); reply.dataset.messageAuthorRole = 'assistant'; reply.dataset.messageId = 'answer-' + window.sent.length; reply.textContent = answer;
        const copy = document.createElement('button'); copy.dataset.testid = 'copy-turn-button'; copy.textContent = 'Copy'; turn.append(reply, copy); document.querySelector('#messages').append(turn);
        if (ack && ${JSON.stringify(tamper)} === 'tool') {
          const tool = document.createElement('div');
          tool.dataset.testid = 'tool-call';
          tool.textContent = 'Unexpected native tool call';
          turn.append(tool);
        }
        if (ack && ${JSON.stringify(tamper)} === 'media') {
          reply.append(document.createElement('canvas'));
        }
        if (${hiddenUser}) {
          if (window.sent.length === 1) {
            turn.removeAttribute('data-testid'); turn.dataset.turnKey = 'fallback-turn-0';
            reply.removeAttribute('data-message-author-role'); reply.dataset.chatgptSearchUnitKey = 'fallback-turn-0:1:assistant';
            copy.outerHTML = '<div class="turn-action-controls"><button data-testid="copy-turn-button">Copy</button></div>';
          }
          await fetch('/backend-api/conversation', { method: 'POST' });
        }
        if (${temporaryChat}) {
          history.replaceState({}, '', '/c/temporary-staged');
          document.querySelector('#page-header').replaceChildren();
        }
      }, 40);
    };
    </script>`;
}

const directory = await mkdtemp(join(tmpdir(), "bridge-full-context-e2e-"));
let currentHtml;
const server = createServer((request, response) => {
  if (request.url === "/api/auth/session") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ user: { id: "fixture" } }));
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(currentHtml);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
let app;
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [fileURLToPath(new URL("./chatgpt-mode-host.mjs", import.meta.url))],
    env: { ...process.env, CODEXGPT_BRIDGE_DOM_TEST_PROFILE: directory },
  });
  for (const {
    badAck,
    stagedContext,
    temporaryChat = false,
    tamper = "",
    hiddenUser = false,
  } of [
    { badAck: false, stagedContext: false },
    { badAck: false, stagedContext: true },
    { badAck: true, stagedContext: true },
    { badAck: false, stagedContext: true, temporaryChat: true },
    {
      badAck: false,
      stagedContext: true,
      temporaryChat: true,
      hiddenUser: true,
    },
    { badAck: true, stagedContext: true, temporaryChat: true },
    {
      badAck: false,
      stagedContext: true,
      temporaryChat: true,
      tamper: "inactive",
    },
    {
      badAck: false,
      stagedContext: true,
      temporaryChat: true,
      tamper: "document",
    },
    { badAck: false, stagedContext: true, temporaryChat: true, tamper: "body" },
    { badAck: false, stagedContext: true, temporaryChat: true, tamper: "tool" },
    {
      badAck: false,
      stagedContext: true,
      temporaryChat: true,
      tamper: "media",
    },
  ]) {
    if (process.argv.includes("--temporary-only") && !temporaryChat) continue;
    currentHtml = fixture(badAck, temporaryChat, tamper, hiddenUser);
    const result = await app.evaluate(
      async (
        { BrowserWindow },
        { html, baseUrl, badAck, stagedContext, temporaryChat },
      ) => {
        const receipts = [];
        const controller = new globalThis.ChatGptBrowserController(
          temporaryChat
            ? baseUrl
            : "data:text/html;charset=utf-8," + encodeURIComponent(html),
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
          temporaryChat,
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
            route: stagedContext
              ? "codexgpt-bridge/gpt-5.6-sol"
              : "codexgpt-bridge/gpt-5.6-sol-3x",
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
            ...(stagedContext
              ? { stagedContext: true }
              : { contextMultiplier: 3 }),
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
            item.webContents
              .getURL()
              .startsWith(temporaryChat ? baseUrl : "data:"),
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
      { html: currentHtml, baseUrl, badAck, stagedContext, temporaryChat },
    );
    assert.equal(result.held, true, JSON.stringify(result));
    if (badAck || tamper) {
      assert.equal(result.committed, false, JSON.stringify(result));
      assert.equal(result.sent.length, 1);
      assert.equal(result.commits, 0);
      assert.equal(result.error.code, "bridge_full_context_transfer_failed");
      if (tamper === "tool")
        assert.match(result.error.message, /opened an App or tool/);
      if (tamper === "media")
        assert.match(result.error.message, /produced media/);
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
              !text.includes("turn_" + "b".repeat(43)) &&
              !text.includes("CodexGPT Bridge"),
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
      `Full context Electron (${stagedContext ? "standard staged route" : "legacy 3x route"}${temporaryChat ? ", temporary" : ""}): ${badAck ? "bad ACK withheld commit after one stage" : tamper ? `changed ${tamper} withheld commit after one stage` : "ordered stages, final-only execution and duplicate observers passed"}\n`,
    );
  }
} finally {
  await app?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
