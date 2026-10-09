import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron } from "playwright-core";
import { compileResponsesPrompt } from "../packages/responses-gateway/dist/index.js";
import { prepareBridgeWebTurn } from "../packages/responses-gateway/dist/tool-protocol.js";

let behavior = "normal";
const sends = [],
  navigations = [];
const server = createServer(async (req, res) => {
  if (req.url === "/api/auth/session") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ user: { id: "fixture" } }));
    return;
  }
  if (req.url === "/send") {
    let body = "";
    for await (const chunk of req) body += chunk;
    sends.push(JSON.parse(body));
    res.end("ok");
    return;
  }
  const temporary = req.url.includes("temporary-chat=true");
  navigations.push({ url: req.url, temporary });
  const mode = behavior;
  const sprite = (name, opacity = 1) =>
    `<svg width="20" height="20" aria-hidden="true" style="opacity:${opacity}"><use href="/sprites.svg#${name}"></use></svg>`;
  let marker =
    '<button aria-label="Turn off temporary chat">Temporary chat</button>';
  if (mode === "zh-TW")
    marker = '<button aria-label="關閉暫存對話">暫存對話</button>';
  if (mode.startsWith("sprite"))
    marker = `<button aria-label="unknown translation">${sprite("chat-temp", mode === "sprite-off" || mode === "sprite-conflict" ? 1 : 0)}${sprite("chat-temp-checked", mode === "sprite-off" || mode === "sprite-hidden" ? 0 : 1)}</button>`;
  if (mode === "duplicate") marker += marker;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><header id="page-header">${temporary && mode !== "missing" ? marker : ""}${mode === "unpersonalized" ? '<button aria-label="Unpersonalized">Unpersonalized</button>' : ""}</header>
  <main><form onsubmit="return false"><div id="prompt-textarea" contenteditable="true" style="width:500px;min-height:40px"></div><button type="button" data-testid="model-switcher-dropdown-button" aria-haspopup="menu">Medium</button><button type="button" data-testid="send-button">Send</button></form><div id="messages"></div></main>
  <script>
    const composer=document.querySelector('#prompt-textarea');
    let sent=0;
    const hiddenUser = ${JSON.stringify(mode)}.startsWith('hidden-user');
    const fixtureFetch = globalThis.fetch;
    if (hiddenUser && ${JSON.stringify(mode)} !== 'hidden-user-dom-only') globalThis.fetch = async (...args) => {
      if (!String(args[0]).includes('/backend-api/conversation')) return fixtureFetch(...args);
      const payload = { message: { id: 'answer-' + sent, author: { role: 'assistant' }, recipient: 'all', channel: 'final', status: 'finished_successfully', end_turn: true, content: { content_type: 'text', parts: ['TEMP_OK'] } } };
      return new Response('data: ' + JSON.stringify(payload) + '\\n\\ndata: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    if (${JSON.stringify(mode)} === 'full' || ['hidden-user-hydrated-full','hidden-user-delayed-full'].includes(${JSON.stringify(mode)})) composer.innerHTML='<span contenteditable="false" data-id="plugin:fixture" data-keyword="Fixture App">Fixture App</span> ';
    let hydrated = false;
    composer.oninput=()=>{
      if(${JSON.stringify(mode)}==='drift')document.querySelector('#page-header').replaceChildren();
      if (${JSON.stringify(mode)} === 'hidden-user-delayed-full' && sent === 1 && !hydrated) {
        hydrated = true;
        const messages=document.querySelector('#messages');
        const previous=[...messages.children];
        messages.replaceChildren();
        document.querySelector('#page-header').replaceChildren();
        setTimeout(()=>messages.append(...previous), 600);
      }
      if (${JSON.stringify(mode)} === 'hidden-user-hydrated-full' && sent === 1 && !hydrated) {
        hydrated = true;
        const answer = document.querySelector('#messages > section');
        answer.dataset.turnKey = 'hydrated-turn-1';
        answer.firstElementChild.dataset.chatgptSearchUnitKey = 'hydrated-turn-1:1:assistant';
        const user = document.createElement('section');
        user.dataset.turnKey = 'hydrated-user-1';
        user.dataset.userMessageBubble = '';
        user.textContent = 'HIDDEN_USER_PRIVATE_REQUEST';
        answer.before(user);
        document.querySelector('#page-header').replaceChildren();
      }
    };
    document.querySelector('[data-testid="send-button"]').onclick=async()=>{
      const text=composer.textContent;
      await fetch('/send',{method:'POST',body:JSON.stringify({temporary:${temporary},text,mode:${JSON.stringify(mode)}})});
      sent++;
      const reply=${JSON.stringify(mode)}==='simple-tools' && sent<3 ? '<codex_tool_calls>[{"id":"tool-'+sent+'","name":"exec","input":"text('+sent+')"}]</codex_tool_calls>' : 'TEMP_OK';
      const user=document.createElement('section');
      user.dataset.turnId='user-'+sent;
      user.dataset.messageAuthorRole='user';
      user.textContent=text;
      const assistant=document.createElement('section');
      assistant.dataset.testid='conversation-turn-'+sent;
      assistant.dataset.turnId='assistant-'+sent;
      assistant.innerHTML='<div data-message-author-role="assistant" data-message-id="answer-'+sent+'"></div><button data-testid="copy-turn-button">Copy</button>';
      assistant.firstElementChild.textContent=reply;
      if (hiddenUser && sent === 1) {
        assistant.removeAttribute('data-testid');
        assistant.removeAttribute('data-turn-id');
        assistant.dataset.turnKey='fallback-turn-0';
        assistant.firstElementChild.removeAttribute('data-message-author-role');
        assistant.firstElementChild.dataset.chatgptSearchUnitKey='fallback-turn-0:1:assistant';
        assistant.lastElementChild.outerHTML='<div class="turn-action-controls"><button data-testid="copy-turn-button">Copy</button></div>';
        document.querySelector('#messages').replaceChildren(assistant);
        if (${JSON.stringify(mode)} !== 'hidden-user-dom-only') await fetch('/backend-api/conversation',{method:'POST'});
      } else {
        document.querySelector('#messages').append(user,assistant);
        if (hiddenUser && ${JSON.stringify(mode)} !== 'hidden-user-dom-only') await fetch('/backend-api/conversation',{method:'POST'});
      }
      composer.textContent='';
      history.pushState({},'',${temporary ? "'/c/temporary-canary'" : "'/c/standard-chat'"});
      // The real retained chat can stop rendering the empty-page mode toggle.
      if (${JSON.stringify(mode)}==='simple-tools') document.querySelector('#page-header').replaceChildren();
    };
  </script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
const directory = await mkdtemp(join(tmpdir(), "bridge-temporary-e2e-"));
const file = join(directory, "conversations.json");
let app;
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [fileURLToPath(new URL("./chatgpt-mode-host.mjs", import.meta.url))],
    env: { ...process.env, CODEXGPT_BRIDGE_DOM_TEST_PROFILE: directory },
  });
  const setup = () =>
    app.evaluate(
      async (_, { baseUrl, file }) => {
        globalThis.tempController = new globalThis.ChatGptBrowserController(
          baseUrl,
          file,
          undefined,
          undefined,
          async () => {
            throw new Error("Temporary Chat must not sync its title");
          },
        );
      },
      { baseUrl, file },
    );
  await setup();
  let turn = 0;
  const run = (threadId, temporaryChat, full = false, request = {}) =>
    app.evaluate(
      async (_, { threadId, temporaryChat, full, turn, baseUrl, request }) => {
        const input = {
          threadId,
          temporaryChat,
          turnId: "turn-" + turn,
          operationId: "operation-" + turn,
          mode: "medium",
          prompt: "private-current-request",
          conversationHistory: "prior Codex context",
          projectUrl: baseUrl + "g/g-p-fixture/project",
          projectName: "MUST NOT CREATE",
          images: [],
          allowWebNativeTools: full,
          connectorName: "Fixture App",
          signal: globalThis.AbortSignal.timeout(25000),
          ...request,
        };
        const results = await Promise.all([
          globalThis.tempController.runTurn(input),
          globalThis.tempController.runTurn(input),
        ]);
        return { results, tasks: globalThis.tempController.tasks() };
      },
      { threadId, temporaryChat, full, turn: ++turn, baseUrl, request },
    );
  const first = await run("temporary-task", true);
  assert.ok(first.tasks.every((task) => !task.titleSyncWarning));
  assert.deepEqual(first.results, ["TEMP_OK", "TEMP_OK"]);
  const browserControlsVisible = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.getTitle() === "ChatGPT - CodexGPT Bridge",
    );
    return window?.isMenuBarVisible() ?? false;
  });
  assert.equal(browserControlsVisible, true);
  assert.equal(sends.length, 1);
  assert.ok(sends[0].temporary);
  assert.equal(
    navigations.filter(
      (navigation) =>
        navigation.url === "/" ||
        navigation.url.includes("temporary-chat=true"),
    ).length,
    1,
    "A new temporary window must load its temporary destination directly, without a preceding home-page navigation",
  );
  assert.match(sends[0].text, /prior Codex context/);
  assert.doesNotMatch(
    await readFile(file, "utf8"),
    /temporary-canary|private-current-request|prior Codex/,
  );
  assert.deepEqual((await run("temporary-task", false)).results, [
    "TEMP_OK",
    "TEMP_OK",
  ]);
  assert.equal(sends.length, 2);
  assert.ok(sends.at(-1).temporary);
  await app.evaluate(() => globalThis.tempController.close());
  await setup();
  assert.deepEqual((await run("temporary-task", false)).results, [
    "TEMP_OK",
    "TEMP_OK",
  ]);
  assert.equal(sends.length, 3);
  behavior = "full";
  assert.deepEqual((await run("temporary-full", true, true)).results, [
    "TEMP_OK",
    "TEMP_OK",
  ]);
  // Live Full MCP can omit the user bubble entirely. Only a verified end_turn
  // for this owned generation may retain that response-only document.
  for (const variant of [
    "stream",
    "dom-only",
    "new-generation",
    "changed-message",
    "hydrated-full",
    "delayed-full",
  ]) {
    behavior =
      variant === "dom-only"
        ? "hidden-user-dom-only"
        : variant.endsWith("-full")
          ? "hidden-user-" + variant
          : "hidden-user-stream";
    const history = [{ role: "user", content: "HIDDEN_USER_PRIVATE_REQUEST" }];
    const hiddenTurn = () => {
      const compiled = compileResponsesPrompt({
        instructions: "HIDDEN_USER_RULES_ONCE",
        input: history,
      });
      return run(
        "temporary-hidden-" + variant,
        true,
        variant.endsWith("-full"),
        {
          operationId: "hidden-" + variant + "-" + turn,
          prompt: prepareBridgeWebTurn(compiled).prompt,
          context: compiled.context,
          contract: "HIDDEN_USER_CONTRACT_ONCE",
        },
      );
    };
    const previousWindowIds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => window.id),
    );
    await hiddenTurn();
    const hiddenWindowId = await app.evaluate(
      ({ BrowserWindow }, previousIds) =>
        BrowserWindow.getAllWindows().find(
          (window) => !previousIds.includes(window.id),
        )?.id,
      previousWindowIds,
    );
    assert.ok(
      hiddenWindowId,
      "A distinct task must own its own fixture window",
    );
    const beforeNavigation = navigations.length;
    history.push(
      { role: "assistant", content: "TEMP_OK" },
      { role: "user", content: "hidden follow-up" },
    );
    if (variant === "new-generation" || variant === "changed-message") {
      await app.evaluate(
        async ({ BrowserWindow }, { variant, id }) => {
          const window = BrowserWindow.fromId(id);
          await window.webContents.executeJavaScript(
            variant === "new-generation"
              ? "fetch('/backend-api/conversation', {method:'POST'})"
              : "document.querySelector('[data-message-id]').setAttribute('data-message-id','replaced-answer')",
          );
        },
        { variant, id: hiddenWindowId },
      );
    }
    await hiddenTurn();
    if (variant === "stream" || variant.endsWith("-full")) {
      assert.equal(
        navigations.length,
        beforeNavigation,
        "An owned stream-confirmed Full response must retain its temporary document without a user bubble",
      );
      assert.doesNotMatch(
        sends.at(-1).text,
        /HIDDEN_USER_RULES_ONCE|HIDDEN_USER_CONTRACT_ONCE|HIDDEN_USER_PRIVATE_REQUEST/,
      );
    } else {
      assert.ok(
        navigations.length > beforeNavigation,
        "Missing terminal proof or a changed generation/message must rebuild",
      );
      assert.match(
        sends.at(-1).text,
        /HIDDEN_USER_RULES_ONCE|HIDDEN_USER_PRIVATE_REQUEST/,
      );
    }
  }
  behavior = "simple-tools";
  const nativeInput = [{ role: "user", content: "run two tools then answer" }];
  const beforeTools = sends.length;
  let navigationCount;
  const continueTools = async (stage) => {
    const compiled = compileResponsesPrompt({
      instructions: "TEMP_RULES_ONCE",
      input: nativeInput,
    });
    return run("temporary-simple-tools", true, false, {
      turnId: "same-native-tool-turn",
      operationId: "simple-stage-" + stage,
      prompt: prepareBridgeWebTurn(compiled).prompt,
      context: compiled.context,
      contract: "TEMP_CONTRACT_ONCE",
    });
  };
  for (let stage = 1; stage <= 3; stage++) {
    const result = await continueTools(stage);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0], result.results[1]);
    if (stage === 1) navigationCount = navigations.length;
    else {
      assert.equal(
        navigations.length,
        navigationCount,
        "Simple tool follow-ups must not reload or replace Temporary Chat",
      );
      assert.doesNotMatch(
        sends.at(-1).text,
        /TEMP_RULES_ONCE|TEMP_CONTRACT_ONCE|run two tools then answer/,
        "Only new history and the current tool result should be sent",
      );
    }
    if (stage < 3) {
      assert.match(result.results[0], /<codex_tool_calls>/);
      nativeInput.push(
        {
          type: "custom_tool_call",
          call_id: "tool-" + stage,
          name: "exec",
          input: "text(" + stage + ")",
        },
        {
          type: "custom_tool_call_output",
          call_id: "tool-" + stage,
          output: "tool-result-" + stage,
        },
      );
    } else assert.equal(result.results[0], "TEMP_OK");
  }
  assert.equal(
    sends.length - beforeTools,
    3,
    "Reconnects must share one send per tool stage",
  );
  assert.match(sends[beforeTools].text, /TEMP_RULES_ONCE/);
  assert.match(sends[beforeTools + 1].text, /tool-result-1/);
  assert.match(sends[beforeTools + 2].text, /tool-result-2/);
  assert.doesNotMatch(
    await readFile(file, "utf8"),
    /TEMP_RULES_ONCE|TEMP_CONTRACT_ONCE|temporary-canary|tool-result/,
  );

  const retainedWindowId = await app.evaluate(async ({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (
        window.webContents.getURL().includes("/c/temporary-canary") &&
        (await window.webContents.executeJavaScript(
          "document.querySelector('#messages')?.textContent.includes('TEMP_RULES_ONCE')",
        ))
      )
        return window.id;
    }
    throw new Error("Retained tool fixture not found");
  });
  nativeInput.push(
    { role: "assistant", content: "TEMP_OK" },
    { role: "user", content: "continue on the retained page" },
  );
  for (const marker of [
    '<button aria-label="Turn on temporary chat">Off</button>',
    '<button aria-label="Turn off temporary chat">On</button>'.repeat(2),
    '<button aria-label="Turn off temporary chat">On</button><button aria-label="Turn on temporary chat">Off</button>',
  ]) {
    await app.evaluate(
      async ({ BrowserWindow }, { id, marker }) => {
        await BrowserWindow.fromId(id).webContents.executeJavaScript(
          `document.querySelector('#page-header').innerHTML = ${JSON.stringify(marker)}`,
        );
      },
      { id: retainedWindowId, marker },
    );
    const before = sends.length;
    await assert.rejects(continueTools("blocked-" + turn), /Temporary Chat/);
    assert.equal(sends.length, before, "explicit off/conflict must not submit");
    assert.equal(navigations.length, navigationCount);
  }

  // Reload, then restore exactly the old DOM and URL. Even matching messages
  // must not inherit temporary-mode proof from a different document.
  await app.evaluate(async ({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id);
    const body = await window.webContents.executeJavaScript(
      "document.querySelector('#page-header').replaceChildren(); document.body.innerHTML",
    );
    const loaded = new Promise((resolve) =>
      window.webContents.once("did-finish-load", resolve),
    );
    window.webContents.reload();
    await loaded;
    await window.webContents.executeJavaScript(
      `document.body.innerHTML = ${JSON.stringify(body)}`,
    );
  }, retainedWindowId);
  behavior = "missing";
  const beforeReload = sends.length;
  const afterReloadNavigation = navigations.length;
  await assert.rejects(continueTools("reloaded"), /Temporary Chat/);
  assert.equal(sends.length, beforeReload);
  assert.ok(
    navigations.length > afterReloadNavigation,
    "A replacement document must establish fresh temporary proof",
  );

  // The temporary page still disappears on restart; the next stage rebuilds
  // its context once, without persisting a private URL or receipt.
  await app.evaluate(() => globalThis.tempController.close());
  await setup();
  behavior = "simple-tools";
  await continueTools(4);
  assert.ok(navigations.length > navigationCount);
  assert.match(sends.at(-1).text, /TEMP_RULES_ONCE|tool-result-1/);
  for (const mode of ["zh-TW", "sprite-on"]) {
    behavior = mode;
    assert.deepEqual((await run("temporary-" + mode, true)).results, [
      "TEMP_OK",
      "TEMP_OK",
    ]);
  }
  for (const mode of [
    "missing",
    "drift",
    "unpersonalized",
    "sprite-off",
    "sprite-hidden",
    "sprite-conflict",
    "duplicate",
  ]) {
    behavior = mode;
    const before = sends.length;
    await assert.rejects(
      run("temporary-" + mode, true, mode === "unpersonalized"),
      /Temporary Chat/,
    );
    assert.equal(sends.length, before, "failed proof must not submit");
  }
  assert.ok(
    navigations.every((n) => !n.url.includes("/g/")),
    "temporary mode never navigates to Project",
  );
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(stored.conversations, []);
  assert.deepEqual(stored.receipts, []);
  assert.deepEqual(stored.projects, []);
  process.stdout.write(
    "Temporary Chat E2E passed: Simple tool stages reuse one verified document after its header toggle disappears, explicit off/conflict blocks continuation, restored DOM after reload requires fresh proof, no context replay, reconnect dedup, restart reconstruction, Project isolation, mode pinning, Full MCP App, no private URLs/receipts, and fresh missing/drift/unpersonalized fail-closed.\n",
  );
} finally {
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
