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
  FullTurnBroker,
  ResponsesGateway,
} from "@codexgpt-bridge/responses-gateway";

const broker = new FullTurnBroker();
let epoch = 0,
  normal = 0,
  checkpointSends = 0;
const submissions = [];
const server = createServer(async (request, response) => {
  if (request.url === "/api/auth/session") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ user: { id: "owned-luna-fixture" } }));
    return;
  }
  if (request.url === "/send") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const checkpoint = input.text.includes(
      "[Codex context checkpoint control:",
    );
    submissions.push({ epoch: input.epoch, checkpoint });
    if (checkpoint) {
      checkpointSends++;
      const token = /turn_[A-Za-z0-9_-]{40,}/.exec(input.text)[0];
      const capability = /checkpoint_[A-Za-z0-9_-]{40,}/.exec(input.text)[0];
      broker.submitCheckpoint(token, {
        checkpoint_token: capability,
        summary:
          "Goal: preserve the task. Completed: the browser replied. Evidence: exact source checkpoint received. Next: continue.",
      });
    } else normal++;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        answer: checkpoint
          ? "Checkpoint received"
          : `<codex_text>LUNA_ELECTRON_REPLY_${normal}</codex_text>`,
      }),
    );
    return;
  }
  const currentEpoch = ++epoch;
  const temporary = request.url.includes("temporary-chat=true");
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><header id="page-header">${temporary ? '<button aria-label="Turn off temporary chat">Temporary chat</button>' : ""}</header><main><form onsubmit="return false">
    <div id="prompt-textarea" contenteditable="true" style="width:500px;height:80px;overflow:auto"></div><button type="button" data-testid="send-button">Send</button></form><div id="messages"></div></main><script>
    const composer = document.querySelector('#prompt-textarea'); let sends = 0;
    document.addEventListener('keydown', event => { if(event.key === 'Escape') document.querySelector('[role="listbox"]')?.remove(); });
    composer.addEventListener('input', () => {
      if (!composer.textContent.includes('@CodexGPT')) return;
      document.querySelector('[role="listbox"]')?.remove();
      const menu = document.createElement('div'); menu.role = 'listbox';
      const option = document.createElement('button'); option.role = 'option'; option.textContent = 'CodexGPT Bridge';
      option.onclick = () => { composer.textContent = ''; const node = document.createElement('span'); node.contentEditable = 'false'; node.dataset.id = 'plugin:codexgpt-bridge'; node.dataset.keyword = 'CodexGPT Bridge'; node.textContent = 'CodexGPT Bridge'; composer.append(node); menu.remove(); };
      menu.append(option); document.body.append(menu);
    });
    document.querySelector('[data-testid="send-button"]').onclick = async () => {
      const text = composer.textContent; sends++;
      const user = document.createElement('div'); user.dataset.messageAuthorRole = 'user';
      const pill = document.createElement('span'); pill.dataset.inlineSelectionPill = ''; pill.dataset.keyword = 'CodexGPT Bridge'; pill.textContent = 'CodexGPT Bridge'; user.append(pill, document.createTextNode(text));
      composer.textContent = ''; document.querySelector('#messages').append(user);
      const output = await (await fetch('/send', {method: 'POST', body: JSON.stringify({text, epoch: ${currentEpoch}})})).json();
      const turn = document.createElement('div'); turn.dataset.testid = 'conversation-turn-' + sends;
      const reply = document.createElement('div'); reply.dataset.messageAuthorRole = 'assistant'; reply.textContent = output.answer;
      const copy = document.createElement('button'); copy.dataset.testid = 'copy-turn-button'; copy.textContent = 'Copy'; turn.append(reply, copy); document.querySelector('#messages').append(turn);
      history.pushState({}, '', '/c/luna-epoch-${currentEpoch}');
    };
    </script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
const directory = await mkdtemp(join(tmpdir(), "bridge-luna-e2e-"));
let app, gateway;
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [fileURLToPath(new URL("./chatgpt-mode-host.mjs", import.meta.url))],
    env: { ...process.env, CODEXGPT_BRIDGE_DOM_TEST_PROFILE: directory },
  });
  gateway = new ResponsesGateway({
    port: 0,
    accountContextProfile: () => "standard",
    availableWebModes: () => ["luna"],
    fullMcp: {
      broker,
      enabled: () => true,
      connectorName: () => "CodexGPT Bridge",
    },
    runWebTurn: (input) =>
      app.evaluate(
        async (_electron, value) => {
          globalThis.lastLunaInput = value;
          return globalThis.lunaController.runTurn({
            ...value,
            signal: globalThis.AbortSignal.timeout(60_000),
            temporaryChat: globalThis.lunaTemporary,
          });
        },
        {
          ...input,
          signal: undefined,
          onProgress: undefined,
          onStreamSnapshot: undefined,
          onContextCommit: undefined,
          onContextStaging: undefined,
        },
      ),
  });
  const address = await gateway.start();
  for (const temporary of [false, true]) {
    const start = submissions.length;
    await app.evaluate(
      async (_electron, { baseUrl, temporary }) => {
        globalThis.lunaController = new globalThis.ChatGptBrowserController(
          baseUrl,
        );
        globalThis.lunaTemporary = temporary;
      },
      { baseUrl, temporary },
    );
    const items = [];
    try {
      for (let index = 1; index <= 2; index++) {
        items.push({ role: "user", content: `Continue ${index}` });
        const result = await globalThis.fetch(`${address.baseUrl}/responses`, {
          method: "POST",
          headers: {
            authorization: "Bearer test",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "codexgpt-bridge/luna-native",
            input: items,
            metadata: {
              thread_id: `luna-electron-${temporary}`,
              turn_id: `luna-turn-${index}`,
            },
          }),
        });
        const output = await result.json();
        assert.equal(result.status, 200, JSON.stringify(output));
        const text = output.output
          .flatMap((item) => item.content ?? [])
          .find((part) => part.type === "output_text").text;
        assert.equal(text, `LUNA_ELECTRON_REPLY_${normal}`);
        items.push({ role: "assistant", content: text });
      }
      const sent = submissions.slice(start);
      assert.equal(sent.length, 4);
      assert.deepEqual(
        sent.map((item) => item.checkpoint),
        [false, true, false, true],
      );
      assert.equal(sent[0].epoch, sent[1].epoch);
      assert.equal(sent[2].epoch, sent[3].epoch);
      assert.notEqual(sent[0].epoch, sent[2].epoch);
      if (temporary) {
        const rejected = await app.evaluate(
          async ({ BrowserWindow }, baseUrl) => {
            const window = BrowserWindow.getAllWindows().find((item) =>
              item.webContents.getURL().startsWith(baseUrl),
            );
            await window.loadURL(baseUrl + "c/foreign-owned-fixture");
            try {
              await globalThis.lunaController.runTurn({
                ...globalThis.lastLunaInput,
                operationId: "f".repeat(64),
                turnId: "luna-tampered-source",
                temporaryChat: true,
                signal: globalThis.AbortSignal.timeout(15_000),
              });
              return "unexpected success";
            } catch (error) {
              return error.code;
            }
          },
          baseUrl,
        );
        assert.equal(rejected, "bridge_retained_full_source_unavailable");
        assert.equal(submissions.length, start + 4);
      }
      process.stdout.write(
        `Luna Electron: ${temporary ? "Temporary" : "saved"} exact-source checkpoint and fresh next epoch passed\n`,
      );
    } finally {
      await app.evaluate(async () => globalThis.lunaController.close());
    }
  }
  assert.equal(normal, 4);
  assert.equal(checkpointSends, 4);
} finally {
  await gateway?.close();
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
