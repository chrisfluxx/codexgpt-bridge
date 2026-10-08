import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { BRIDGE_WEB_TASK_CONCURRENCY } from "../apps/desktop/dist/main/turn-pool.js";
import { runChatGptDomChecks } from "./chatgpt-dom-checks.mjs";

const require = createRequire(import.meta.url);
const nativeSmoke = process.argv.includes("--native-smoke");
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, "..");
const explicitExecutableArgument = process.argv.find((argument) =>
  argument.startsWith("--executable="),
);
const explicitExecutable = explicitExecutableArgument?.slice(
  "--executable=".length,
);
const packaged =
  process.argv.includes("--packaged") || explicitExecutable !== undefined;
const electronExecutable =
  explicitExecutable ??
  (packaged
    ? join(repositoryRoot, "release", "win-unpacked", "CodexGPT Bridge.exe")
    : require("electron"));
const nativeModelFixture = {
  slug: "gpt-native-e2e",
  display_name: "Native E2E",
  description: "Native passthrough fixture",
  default_reasoning_level: "medium",
  supported_reasoning_levels: [
    { effort: "medium", description: "fixture" },
    { effort: "high", description: "fixture high" },
    { effort: "xhigh", description: "fixture extra high" },
  ],
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 0,
  base_instructions: "fixture",
  supports_reasoning_summaries: false,
  support_verbosity: false,
  supports_parallel_tool_calls: true,
  context_window: 32768,
  max_context_window: 32768,
  effective_context_window_percent: 95,
  input_modalities: ["text"],
};
const legacyWebModelFixtures = [
  ["chatgpt-web/light", "ChatGPT Web — Instant", "low", 7, 333_579],
  ["chatgpt-web/medium", "ChatGPT Web — Medium", "medium", 6, 333_579],
  ["chatgpt-web/high", "ChatGPT Web — High", "high", 6, 333_579],
  ["chatgpt-web/extra-high", "ChatGPT Web — Extra High", "xhigh", 6, 333_579],
  ["chatgpt-web/pro", "ChatGPT Web — Pro", "ultra", 6, 336_579],
].map(([slug, display_name, effort, priority, context_window]) => ({
  slug,
  display_name,
  visibility: "list",
  supported_in_api: true,
  priority,
  multi_agent_version: "v1",
  tool_mode: null,
  default_reasoning_level: effort,
  supported_reasoning_levels: [{ effort, description: display_name }],
  context_window,
  max_context_window: context_window,
  auto_compact_token_limit: 285_000,
  legacy_owner: "existing-provider",
  base_instructions: "fixture",
  supports_reasoning_summaries: true,
  supports_parallel_tool_calls: true,
}));
const arbitraryOriginalModelFixture = {
  ...nativeModelFixture,
  slug: "acme-router/special",
  display_name: "Acme Router Special",
  original_provider_metadata: "must-survive",
};
const originalProviderModelFixtures = [
  nativeModelFixture,
  ...legacyWebModelFixtures,
  arbitraryOriginalModelFixture,
];

// Renderer navigation follows Chromium's restricted-port policy. Windows can
// allocate one of these low ports when its dynamic range is customized, so an
// OS-assigned port is not automatically safe for the ChatGPT fixture page.
const chromiumRestrictedPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080,
]);

async function closeServer(server) {
  await new Promise((resolvePromise, rejectPromise) =>
    server.close((error) =>
      error === undefined ? resolvePromise() : rejectPromise(error),
    ),
  );
}

async function reserveFreePort() {
  while (true) {
    const server = net.createServer();
    await new Promise((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    await closeServer(server);
    if (!chromiumRestrictedPorts.has(port)) return port;
  }
}

async function launchDesktop(
  userDataDirectory,
  codexHome,
  port,
  responsesPort,
  chatGptUrl,
) {
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: packaged ? [] : [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CODEXGPT_BRIDGE_E2E_USER_DATA_DIR: userDataDirectory,
      CODEXGPT_BRIDGE_DESKTOP_PORT: String(port),
      CODEXGPT_BRIDGE_RESPONSES_PORT: String(responsesPort),
      CODEXGPT_BRIDGE_E2E_CHATGPT_URL: chatGptUrl,
      CODEXGPT_BRIDGE_E2E_NATIVE_MODELS_JSON: JSON.stringify({
        models: [nativeModelFixture],
      }),
      CODEXGPT_BRIDGE_E2E_EXISTING_MODELS_JSON: JSON.stringify({
        models: originalProviderModelFixtures,
      }),
      CODEXGPT_BRIDGE_E2E_STATE_DB: join(
        userDataDirectory,
        "state",
        "workspaces.sqlite",
      ),
      CODEXGPT_BRIDGE_WORKTREE_ROOT: join(
        userDataDirectory,
        "managed-worktrees",
      ),
      CODEX_HOME: codexHome,
    },
  });
  application.on("window", attachRendererDiagnostics);
  return application;
}

async function startHttpServer(handler) {
  while (true) {
    const server = createServer(handler);
    await new Promise((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    if (chromiumRestrictedPorts.has(address.port)) {
      await closeServer(server);
      continue;
    }
    return {
      url: `http://127.0.0.1:${address.port}`,
      close: () => {
        server.closeAllConnections();
        return closeServer(server);
      },
    };
  }
}

function fakeChatGptHtml(nativeToolSelected = false) {
  return `<!doctype html>
<html>
  <body>
    <main>
      <form data-chatgpt-composer onsubmit="return false">
      <button data-testid="model-switcher-dropdown-button">GPT</button>
      <div id="prompt-textarea" contenteditable="true"></div>
      <input type="file" multiple>
      <button type="submit">Send</button>
      </form>
      <div id="messages"></div>
    </main>
    <script>
      Object.defineProperty(window, '__providerSendCount', {
        get: () => Number(localStorage.getItem('provider-send-count') || 0),
        set: value => localStorage.setItem('provider-send-count', String(value))
      });
      window.__providerPendingImageRetry = false;
      window.__providerPendingTemplateRetry = false;
      window.__providerTemplateAlwaysFails = false;
      window.__providerNativeToolSelected = ${nativeToolSelected};
      if (window.__providerNativeToolSelected) {
        const nativeTool = document.createElement('span');
        nativeTool.dataset.id = 'plugin:fixture-native-app';
        nativeTool.dataset.keyword = 'Fixture Native App';
        nativeTool.contentEditable = 'false';
        nativeTool.textContent = 'Fixture Native App';
        document.querySelector('#prompt-textarea').append(nativeTool);
      }
      if (location.pathname.includes('/c/')) {
        document.querySelector('#messages').innerHTML = localStorage.getItem(location.pathname) || '';
      }
      if (localStorage.getItem('provider-stale-reload-armed') === '1') {
        localStorage.removeItem('provider-stale-reload-armed');
        localStorage.setItem('provider-stale-reload-observed', '1');
      }
      const picker = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
      document.querySelector('#prompt-textarea').addEventListener('keydown', event => {
        if (
          event.isTrusted
          && event.key === 'Backspace'
          && window.__providerNativeToolSelected
        ) {
          window.__providerNativeToolSelected = false;
          document.querySelectorAll('[data-id^="plugin:"][data-keyword]').forEach(element => element.remove());
          localStorage.setItem('provider-native-tool-cleared', '1');
        }
      });
      document.querySelector('#prompt-textarea').addEventListener('input', event => {
        const prompt = event.currentTarget.innerText;
        if (
          prompt.includes('provider-e2e-stale-control-reload')
          && document.querySelector('[data-testid="stop-button"]')
        ) {
          picker.disabled = true;
          picker.setAttribute('aria-disabled', 'true');
          localStorage.setItem('provider-stale-reload-armed', '1');
        }
      });
      picker.addEventListener('click', () => {
        if (document.querySelector('[role="menu"]')) return;
        const menu = document.createElement('div');
        menu.setAttribute('role', 'menu');
        for (const label of ['Instant', 'Medium', 'High', 'Extra High', 'Pro']) {
          const option = document.createElement('button');
          option.setAttribute('role', 'menuitem');
          option.textContent = label;
          option.addEventListener('click', () => {
            picker.textContent = label;
            menu.remove();
          });
          menu.append(option);
        }
        document.body.append(menu);
      });
      document.querySelector('input[type="file"]').addEventListener('change', event => {
        for (const file of event.target.files || []) {
          const attachment = document.createElement('button');
          attachment.type = 'button';
          attachment.className = 'composer-attachment-surface';
          attachment.setAttribute('aria-label', file.name);
          attachment.textContent = file.name;
          document.querySelector('form[data-chatgpt-composer]').append(attachment);
        }
      });
      document.querySelector('button[type="submit"]').addEventListener('click', () => {
        window.__providerSendCount += 1;
        if (!location.pathname.includes('/c/')) {
          const prefix = location.pathname.endsWith('/project') ? location.pathname.slice(0, -8) : '';
          history.replaceState({}, '', prefix + '/c/' + crypto.randomUUID());
        }
        const prompt = document.querySelector('#prompt-textarea').innerText;
        document.querySelector('#prompt-textarea').textContent = '';
        const userTurn = document.createElement('div');
        userTurn.dataset.testid = 'conversation-turn-user';
        userTurn.setAttribute('data-message-author-role', 'user');
        userTurn.textContent = prompt;
        document.querySelector('#messages').append(userTurn);
        let stop = document.querySelector('[data-testid="stop-button"]');
        if (!(stop instanceof HTMLButtonElement)) {
          stop = document.createElement('button');
          stop.dataset.testid = 'stop-button';
          stop.setAttribute('aria-label', 'Stop');
          document.body.append(stop);
        }
        if (prompt.includes('provider-completion-e2e')) {
          const id = crypto.randomUUID();
          const turn = document.createElement('div');
          turn.dataset.testid = 'conversation-turn-assistant';
          turn.dataset.turnId = id;
          const message = document.createElement('div');
          message.setAttribute('data-message-author-role', 'assistant');
          message.setAttribute('data-message-id', id);
          const copy = document.createElement('button');
          copy.dataset.testid = 'copy-turn-button';
          copy.textContent = 'Copy';
          turn.append(message, copy);
          document.querySelector('#messages').append(turn);
          const scenario = prompt.includes('live-generation') ? 'live' : prompt.includes('paused-generation') ? 'paused' : 'fast';
          void fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ id, scenario }) }).then(async response => {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let pending = '';
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              pending += decoder.decode(chunk.value, { stream: true });
              const lines = pending.split(String.fromCharCode(10));
              pending = lines.pop();
              for (const line of lines) {
                if (!line.startsWith('data: {')) continue;
                const event = JSON.parse(line.slice(6));
                message.textContent = event.message.content.parts.join('');
              }
            }
            localStorage.setItem(location.pathname, document.querySelector('#messages').innerHTML);
            localStorage.setItem('provider-stale-reload-armed', '1');
            // Deliberately never remove Stop, even if Bridge clicks it. The real
            // ChatGPT page can retain an inert control after end_turn, and the
            // completed surface must be reloaded without activating that control.
          });
          return;
        }
        setTimeout(() => {
          const templateStart = window.__providerNativeToolSelected
            || (prompt.includes('provider-template-failure-e2e') && !prompt.includes('[Codex tool protocol correction]'));
          const templateCorrection = window.__providerPendingTemplateRetry && prompt.includes('[Codex tool protocol correction]');
          if (!prompt.includes("provider-stream-e2e") && !templateStart) stop.remove();
          if (templateCorrection) document.querySelectorAll('[data-testid="stop-button"]').forEach(button => button.remove());
          const turn = document.createElement('div');
          turn.dataset.testid = 'conversation-turn-assistant';
          const responseId = crypto.randomUUID();
          turn.dataset.turnId = responseId;
          const message = document.createElement('div');
          message.setAttribute('data-message-author-role', 'assistant');
          message.setAttribute('data-message-id', responseId);
          const imageAttached = Boolean(document.querySelector('.composer-attachment-surface[aria-label="codex-input-image-1.png"]'));
          const bridgeClientTool = prompt.includes('custom_client__open_workspace');
          const transientImageFailure = prompt.includes('provider-transient-image-failure-e2e');
          const transientImageRetry = window.__providerPendingImageRetry
            && prompt.startsWith('Retry the immediately preceding image-generation request now');
          message.textContent = bridgeClientTool
              ? '<codex_tool_calls>[{"name":"custom_client__open_workspace","arguments":{"path":"C:/work"}}]</codex_tool_calls>'
              : prompt.includes('provider-image-e2e')
                ? (imageAttached ? 'PROVIDER_IMAGE_E2E_OK' : 'PROVIDER_IMAGE_E2E_MISSING')
                : prompt.includes('provider-e2e')
                  ? 'PROVIDER_E2E_OK:' + picker.textContent
                    + (prompt.includes('provider-e2e-stale-control-reload')
                      ? ':' + (localStorage.getItem('provider-stale-reload-observed') === '1'
                        ? 'STALE_RELOAD_OK'
                        : 'STALE_RELOAD_MISSING')
                      : '')
                  : 'PROVIDER_E2E_BAD_PROMPT';
          const copy = document.createElement('button');
          copy.dataset.testid = 'copy-response-button-v2';
          copy.setAttribute('aria-label', 'Copy response');
          copy.textContent = 'Copy';
          turn.append(message, copy);
          if(prompt.includes('provider-stream-e2e')) {
            message.textContent='<codex_text>STREAM_BEGIN';
            copy.style.display='none';
            setTimeout(()=>{message.textContent='<codex_text>STREAM_BEGIN STREAM_MIDDLE';},700);
            setTimeout(()=>{message.textContent='<codex_text>Temporary rendered prefix_';},2500);
            setTimeout(()=>{message.textContent='<codex_text>STREAM_BEGIN STREAM_MIDDLE STREAM_END</codex_text>';copy.style.display='';stop.remove();localStorage.setItem(location.pathname,document.querySelector('#messages').innerHTML);},4500);
          }
          if (prompt.includes('provider-generated-image-e2e')) {
            message.textContent = prompt.includes('retry') ? 'Worked for 41s' : 'Image reply';
            const generated = document.createElement('img');
            generated.width = 256;
            generated.height = 256;
            generated.src = 'https://chatgpt.com/__bridge_e2e__/image-' + window.__providerSendCount + '.png';
            turn.append(generated);
          }
          if (transientImageFailure) {
            window.__providerPendingImageRetry = true;
            message.textContent = "I couldn’t generate the image because the image generation tool hit an error just now.";
          }
          if (transientImageRetry) {
            window.__providerPendingImageRetry = false;
            message.textContent = 'Worked for 41s';
            const generated = document.createElement('img');
            generated.width = 256;
            generated.height = 256;
            generated.src = 'https://chatgpt.com/__bridge_e2e__/automatic-retry-' + window.__providerSendCount + '.png';
            turn.append(generated);
          }
          if (prompt.includes('provider-media-fallback-e2e')) {
            message.innerHTML = '<h2>Research answer</h2><p>COMPLETE_RESEARCH_TEXT</p><table><tr><th>Source</th><th>Result</th></tr><tr><td>A</td><td>B</td></tr></table>';
            if (prompt.includes('inline-protocol')) {
              message.innerHTML += '<p>你剛剛看到的 <code>&lt;codex_tool_calls&gt;</code> 是工具標記。</p><p>EXPLANATION_END</p>';
            }
            const media = document.createElement('img');
            media.width = prompt.includes('citation') ? 16 : 256;
            media.height = media.width;
            media.src = prompt.includes('download-failure')
              ? 'https://chatgpt.com/__bridge_e2e__/failed-transfer.png'
              : 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256"/></svg>');
            turn.append(media);
          }
          if (templateStart || templateCorrection) {
            if (templateStart) window.__providerTemplateAlwaysFails = prompt.includes('repeat-failure');
            const failed = templateStart || window.__providerTemplateAlwaysFails;
            window.__providerPendingTemplateRetry = failed;
            message.replaceChildren();
            if (failed) {
              const toolTurn = document.createElement('div');
              toolTurn.dataset.testid = 'conversation-turn-tool';
              toolTurn.setAttribute('data-message-author-role', 'tool');
              toolTurn.setAttribute('aria-busy', 'true');
              toolTurn.innerHTML = '<strong>載入應用程式時發生錯誤</strong><p>Failed to fetch template</p><button>重試</button>';
              document.querySelector('#messages').append(toolTurn);
            }
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.textContent = '<codex_tool_calls>' + JSON.stringify([{name: 'exec', input: failed ? 'MUST_NOT_EXECUTE' : 'CORRECTED_CLIENT_TOOL'}]) + '</codex_tool_calls>';
            pre.append(code);
            message.append(pre);
          }
          const messages = document.querySelector('#messages');
          messages.append(turn);
          while (messages.children.length > 8) messages.firstElementChild.remove();
          localStorage.setItem(location.pathname, messages.innerHTML);
        }, 150);
      });
    </script>
  </body>
</html>`;
}

function attachRendererDiagnostics(page) {
  page.on("pageerror", (error) => {
    process.stderr.write(`[renderer pageerror] ${error.message}\n`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      process.stderr.write(`[renderer console] ${message.text()}\n`);
    }
  });
}

async function waitForText(page, text, timeout = 10_000) {
  try {
    await page.getByText(text, { exact: true }).first().waitFor({ timeout });
  } catch (error) {
    process.stderr.write(`[renderer url] ${page.url()}\n`);
    process.stderr.write(
      `[renderer body] ${await page.locator("body").innerHTML()}\n`,
    );
    throw error;
  }
}

async function waitForChecked(locator, expected, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await locator.isChecked()) === expected) return;
    await new Promise((resolvePromise) =>
      globalThis.setTimeout(resolvePromise, 50),
    );
  }
  throw new Error(`Checkbox did not settle to ${String(expected)}.`);
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolvePromise) =>
      globalThis.setTimeout(resolvePromise, 100),
    );
  }
  throw new Error(
    `Desktop process ${pid} did not exit after its window closed.`,
  );
}

const userDataDirectory = await mkdtemp(
  join(tmpdir(), "codexgpt-desktop-e2e-"),
);
const codexHome = join(userDataDirectory, "codex-home");
const codexConfigPath = join(codexHome, "config.toml");
const legacyWebHome = join(userDataDirectory, "legacy-web-home");
const port = await reserveFreePort();
const responsesPort = await reserveFreePort();
let currentApp;
const completionFinalTimes = new Map();
let nativeToolFixtureArmed = false;
let serverSessionProbeCount = 0;
const directoryProjects = [
  { name: "Sidebar Project Name", path: "/g/g-p-sidebar-name/project" },
];
const createdProjects = [];
const fakeChatGpt = await startHttpServer((request, response) => {
  if (request.url === "/projects") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><main><h1>Projects</h1>
      <input id="projects-index-search" aria-label="搜尋專案" value=""><button id="new-project">Create</button><div id="results"></div>
      </main><dialog><form><input id="chatgpt-project-name" value=""><button disabled>建立專案</button></form></dialog><script>
      const projects=${JSON.stringify(directoryProjects)};
      const input=document.querySelector('#projects-index-search'), results=document.querySelector('#results');
      function render(){results.replaceChildren();const matches=projects.filter(p=>p.name.includes(input.value));
      if(!matches.length){const empty=document.createElement('p');empty.textContent='No projects';results.append(empty);}
      for(const p of matches){const row=document.createElement('div');row.setAttribute('role','presentation');row.setAttribute('data-project-row','true');
      const cell=document.createElement('span');cell.className='truncate';cell.textContent=p.name;
      const open=document.createElement('button');open.setAttribute('aria-label','Start new chat in project');open.textContent='+';
      open.onclick=(event)=>{event.stopPropagation();location.href=p.path;};row.append(cell,open);
      row.onclick=()=>row.setAttribute('data-expanded','true');results.append(row);}}
      let searchTimer;
      input.oninput=(event)=>{if(!event.isTrusted)return;input.setAttribute('value',input.value);clearTimeout(searchTimer);results.setAttribute('aria-busy','true');searchTimer=setTimeout(()=>{render();results.removeAttribute('aria-busy');},1400);};
      render();document.querySelector('#new-project').onclick=()=>document.querySelector('dialog').showModal();
      const projectName=document.querySelector('#chatgpt-project-name');
      projectName.oninput=(event)=>{if(!event.isTrusted)return;projectName.setAttribute('value',projectName.value);document.querySelector('form button').disabled=!projectName.value;};
      document.querySelector('form').onsubmit=async(event)=>{event.preventDefault();const response=await fetch('/__create-project',{method:'POST',body:projectName.value});location.href=(await response.json()).path;};
      </script>`);
    return;
  }
  if (request.method === "POST" && request.url === "/__create-project") {
    let name = "";
    request.on("data", (chunk) => {
      name += chunk.toString();
    });
    request.on("end", () => {
      createdProjects.push(name);
      const project = {
        name,
        path: `/g/g-p-created-${createdProjects.length}/project`,
      };
      directoryProjects.push(project);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(project));
    });
    return;
  }
  if (request.method === "GET" && request.url === "/api/auth/session") {
    serverSessionProbeCount++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        user: { id: "desktop-e2e-user" },
        expires: "2099-01-01T00:00:00.000Z",
      }),
    );
    return;
  }
  if (request.method === "POST" && request.url === "/__arm-native-tool") {
    nativeToolFixtureArmed = true;
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "POST" && request.url === "/__disarm-native-tool") {
    nativeToolFixtureArmed = false;
    response.writeHead(204);
    response.end();
    return;
  }
  if (
    request.method === "POST" &&
    request.url === "/backend-api/f/conversation"
  ) {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const { id, scenario } = JSON.parse(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = (text, finished) =>
        "data: " +
        JSON.stringify({
          message: {
            id,
            author: { role: "assistant" },
            recipient: "all",
            channel: "final",
            status: finished ? "finished_successfully" : "in_progress",
            end_turn: finished,
            content: { content_type: "text", parts: [text] },
          },
        }) +
        "\n\n";
      response.write(
        event(
          scenario === "live"
            ? "COMPLETION_"
            : "<codex_text>EARLY_COMPLETE_FRAME</codex_text>",
          false,
        ),
      );
      const timer = globalThis.setTimeout(
        () => {
          completionFinalTimes.set(scenario, Date.now());
          response.end(
            event(
              scenario === "live"
                ? "COMPLETION_FINAL_" + scenario
                : "<codex_text>COMPLETION_FINAL_" + scenario + "</codex_text>",
              true,
            ) + "data: [DONE]\n\n",
          );
        },
        scenario === "paused" ? 6_000 : scenario === "live" ? 1500 : 500,
      );
      response.once("close", () => globalThis.clearTimeout(timer));
    });
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  const html = fakeChatGptHtml(nativeToolFixtureArmed);
  const project = directoryProjects.find((p) => p.path === request.url);
  response.end(
    project
      ? html.replace(
          "<main>",
          "<main><h1>" +
            project.name.replaceAll("&", "&amp;").replaceAll("<", "&lt;") +
            "</h1>",
        )
      : html,
  );
});
const originalProviderRequests = [];
const fakeOriginalProvider = await startHttpServer((request, response) => {
  if (request.url?.startsWith("/v1/models") && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        models: originalProviderModelFixtures,
      }),
    );
    return;
  }
  if (request.url === "/v1/responses" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      originalProviderRequests.push({
        model: parsed.model,
        authorization: request.headers.authorization,
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `event: response.completed\ndata: ORIGINAL_PROVIDER_E2E_OK:${parsed.model}\n\n`,
      );
    });
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      error: { message: "fake original provider route missing" },
    }),
  );
});
const originalCodexConfig = [
  'model = "gpt-5.6-sol"',
  `openai_base_url = "${fakeOriginalProvider.url}/v1"`,
  "",
].join("\n");

try {
  await mkdir(codexHome, { recursive: true });
  await mkdir(legacyWebHome, { recursive: true });
  await writeFile(codexConfigPath, originalCodexConfig, "utf8");
  await writeFile(
    join(legacyWebHome, "config.json"),
    `${JSON.stringify({
      solAvailable: true,
      proAvailable: true,
      experimentalBiggerContext: true,
    })}\n`,
    "utf8",
  );
  await writeFile(
    join(userDataDirectory, "desktop-settings.json"),
    `${JSON.stringify(
      {
        locale: "en",
        webToolMode: "simple",
        webModelFamily: "GPT-6 Fixture",
        allowedRoots: [],
        permission: "execute",
        backgroundRuntime: false,
        chatGptProjects: {
          enabled: false,
          mappings: [
            {
              localPath: userDataDirectory,
              projectUrl: fakeChatGpt.url + "/g/g-p-legacy-manual/project",
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  currentApp = await launchDesktop(
    userDataDirectory,
    codexHome,
    port,
    responsesPort,
    `${fakeChatGpt.url}/`,
  );
  let page = await currentApp.firstWindow();
  attachRendererDiagnostics(page);
  await page.getByRole("button", { name: "Install Web models" }).waitFor();
  const language = page.locator(".languagePicker select");
  await language.waitFor();
  await language.selectOption("zh-TW");
  await waitForText(page, "把 ChatGPT Web 模型帶進 Codex。");
  await language.selectOption("zh-CN");
  await waitForText(page, "把 ChatGPT Web 模型带进 Codex。");
  await waitForText(
    page,
    "请登录 ChatGPT、安装 Web 模型，再重启 Codex；不需要设置文件夹。",
  );
  await page.reload();
  await waitForText(page, "把 ChatGPT Web 模型带进 Codex。");
  assert.equal(await language.inputValue(), "zh-CN");
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  await language.selectOption("en");
  await waitForText(page, "Bring ChatGPT Web models into Codex.");
  const temporaryToggle = page.getByLabel("Use Temporary Chat for new tasks", {
    exact: true,
  });
  assert.equal(await temporaryToggle.isChecked(), false);
  await temporaryToggle.click();
  await waitForText(
    page,
    "New tasks will use Temporary Chat; existing tasks are unchanged.",
  );
  assert.equal(
    (await page.evaluate(() => globalThis.codexgptBridge.getSettings()))
      .temporaryChat,
    true,
  );
  await page.reload();
  await temporaryToggle.waitFor();
  assert.equal(await temporaryToggle.isChecked(), true);
  // Controlled React input commits after the asynchronous settings IPC returns.
  await temporaryToggle.click();
  await waitForText(
    page,
    "New tasks will return to normal chat or Project mapping; existing tasks are unchanged.",
  );
  assert.equal(await temporaryToggle.isChecked(), false);
  await assert.rejects(
    page.evaluate(() => globalThis.codexgptBridge.setTemporaryChat("true")),
    /boolean/,
  );
  process.stdout.write(
    "Desktop E2E: Temporary Chat opt-in UI, persistence and validation passed\n",
  );
  assert.equal(await page.locator(".workspaceSettings").count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "Start runtime" }).count(),
    0,
  );
  const retiredApi = await page.evaluate(() =>
    Object.keys(globalThis.codexgptBridge),
  );
  for (const name of [
    "startRuntime",
    "getRuntimeStatus",
    "connectCodex",
    "approveRequest",
    "addAllowedRoot",
  ])
    assert.equal(retiredApi.includes(name), false);
  const migratedSettings = await page.evaluate(() =>
    globalThis.codexgptBridge.getSettings(),
  );
  for (const name of ["allowedRoots", "permission", "backgroundRuntime"])
    assert.equal(Object.hasOwn(migratedSettings, name), false);
  const persistedSettings = JSON.parse(
    await readFile(join(userDataDirectory, "desktop-settings.json"), "utf8"),
  );
  for (const name of ["allowedRoots", "permission", "backgroundRuntime"])
    assert.equal(Object.hasOwn(persistedSettings, name), false);
  assert.equal(
    await page.getByRole("button", { name: "Open ChatGPT login" }).isEnabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "Install Web models" }).isEnabled(),
    true,
  );
  if (process.argv.includes("--capture-web-ui")) {
    await mkdir(join(repositoryRoot, "release"), { recursive: true });
    await page.screenshot({
      path: join(repositoryRoot, "release", "web-model-onboarding.png"),
      fullPage: true,
    });
  }
  assert.equal(await page.locator("#web-model-family").count(), 0);
  assert.equal(
    await page.evaluate(
      () => typeof globalThis.codexgptBridge.setWebModelFamily,
    ),
    "undefined",
  );
  assert.equal(
    Object.hasOwn(
      await page.evaluate(() => globalThis.codexgptBridge.getSettings()),
      "webModelFamily",
    ),
    false,
    "legacy model-family preferences are ignored",
  );
  process.stdout.write(
    "Desktop E2E: installing Web provider without workspace runtime\n",
  );
  const projectToggle = page.getByLabel(
    "Put new tasks in a same-named ChatGPT Project (create it if missing)",
  );
  assert.equal(await projectToggle.isChecked(), false);
  assert.equal(
    await page
      .getByText("進階：手動指定不同的 ChatGPT Project", { exact: true })
      .count(),
    0,
  );
  assert.deepEqual(
    (await page.evaluate(() => globalThis.codexgptBridge.getSettings()))
      .chatGptProjects,
    { enabled: false },
    "legacy manual mappings are ignored",
  );
  assert.equal(
    await page.evaluate(
      () => typeof globalThis.codexgptBridge.chooseProjectFolder,
    ),
    "undefined",
  );
  await projectToggle.click();
  await waitForChecked(projectToggle, true);
  await waitForText(page, "Project mapping is enabled for new Codex tasks.");
  await page.getByRole("button", { name: "Open ChatGPT login" }).click();
  await page.getByRole("button", { name: "Install Web models" }).click();
  await page.getByRole("button", { name: "Remove Web models" }).waitFor();
  const webTaskQueue = page.locator('[aria-label="Web task queue"]');
  await webTaskQueue.waitFor();
  const idleQueueText = await webTaskQueue.innerText();
  assert.match(
    idleQueueText,
    new RegExp(`Active 0/${BRIDGE_WEB_TASK_CONCURRENCY}`),
  );
  assert.match(idleQueueText, /Queued 0/);
  assert.match(idleQueueText, /Cooldown ready/);
  process.stdout.write(
    "Desktop E2E: Web task queue summary is visible after provider installation\n",
  );
  const projectRequest = async (task, turn, cwd = userDataDirectory) => {
    const response = await globalThis.fetch(
      `http://127.0.0.1:${responsesPort}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer provider-e2e",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/high",
          input: "provider-e2e project mapping",
          metadata: { thread_id: task, turn_id: turn, cwd },
        }),
        signal: globalThis.AbortSignal.timeout(30_000),
      },
    );
    assert.equal(response.status, 200, await response.text());
    const mapping = JSON.parse(
      await readFile(
        join(userDataDirectory, "chatgpt-conversations.json"),
        "utf8",
      ),
    );
    return new Map(mapping.conversations).get(task);
  };
  // Exercise native task -> read-only sidebar registry -> automatic Web project,
  // using a worktree cwd that is not the saved project root.
  const projectRegistryPath = join(codexHome, "state_5.sqlite");
  const projectRegistry = new DatabaseSync(projectRegistryPath);
  projectRegistry.exec(
    "CREATE TABLE projects(id TEXT, name TEXT); CREATE TABLE project_roots(project_id TEXT, path TEXT); CREATE TABLE threads(id TEXT, project_id TEXT);",
  );
  projectRegistry
    .prepare("INSERT INTO projects VALUES (?, ?)")
    .run("sidebar-project", "Sidebar Project Name");
  projectRegistry
    .prepare("INSERT INTO project_roots VALUES (?, ?)")
    .run("sidebar-project", "C:/fixture-source");
  projectRegistry
    .prepare("INSERT INTO threads VALUES (?, ?)")
    .run("project-auto-native", "sidebar-project");
  projectRegistry
    .prepare("INSERT INTO threads VALUES (?, ?)")
    .run("project-loose-native", null);
  projectRegistry
    .prepare("INSERT INTO threads VALUES (?, ?)")
    .run("project-mixed-registry", null);
  projectRegistry
    .prepare("INSERT INTO threads VALUES (?, ?)")
    .run("project-mixed-registry-second", null);
  projectRegistry.close();
  const sidebarStatePath = join(codexHome, ".codex-global-state.json");
  await writeFile(
    sidebarStatePath,
    JSON.stringify({
      "local-projects": {
        legacy: {
          name: "Migrated Project Name",
          rootPaths: ["C:/fixture-source"],
        },
      },
      "thread-project-assignments": {
        "project-mixed-registry": { projectKind: "local", projectId: "legacy" },
        "project-mixed-registry-second": {
          projectKind: "local",
          projectId: "legacy",
        },
      },
    }),
  );
  const autoProjectChat = await projectRequest(
    "project-auto-native",
    "auto-first",
    "C:/unmapped-worktree",
  );
  assert.ok(
    autoProjectChat.startsWith(fakeChatGpt.url + "/g/g-p-sidebar-name/c/"),
    autoProjectChat,
  );
  const looseChat = await projectRequest(
    "project-loose-native",
    "loose-first",
    "C:/fixture-source",
  );
  assert.ok(looseChat.startsWith(fakeChatGpt.url + "/c/"), looseChat);
  const mixedChat = await projectRequest(
    "project-mixed-registry",
    "mixed-first",
    "\\\\?\\C:\\unmapped-worktree",
  );
  assert.ok(
    mixedChat.startsWith(fakeChatGpt.url + "/g/g-p-created-1/c/"),
    mixedChat,
  );
  assert.deepEqual(createdProjects, ["Migrated Project Name"]);
  const secondMixedChat = await projectRequest(
    "project-mixed-registry-second",
    "mixed-second",
    "C:/unmapped-worktree",
  );
  assert.ok(
    secondMixedChat.startsWith(fakeChatGpt.url + "/g/g-p-created-1/c/"),
    secondMixedChat,
  );
  assert.deepEqual(createdProjects, ["Migrated Project Name"]);
  process.stdout.write(
    "Desktop E2E: NULL native project_id plus exact sidebar assignment creates one Project, then reuses it\n",
  );
  await rm(projectRegistryPath);
  await rm(sidebarStatePath);
  await currentApp.close();
  currentApp = undefined;
  const oldJournalPath = join(
    userDataDirectory,
    "codex-provider-integration.json",
  );
  const oldJournal = JSON.parse(await readFile(oldJournalPath, "utf8"));
  const currentConfig = await readFile(oldJournal.configPath, "utf8");
  assert.equal(typeof oldJournal.interruptHook?.fragment, "string");
  assert.ok(currentConfig.includes(oldJournal.interruptHook.fragment));
  await writeFile(
    oldJournal.configPath,
    currentConfig.replace(oldJournal.interruptHook.fragment, ""),
    "utf8",
  );
  oldJournal.version = 3;
  delete oldJournal.upstreamBaseUrl;
  delete oldJournal.interruptHook;
  await writeFile(oldJournalPath, `${JSON.stringify(oldJournal, null, 2)}\n`);
  currentApp = await launchDesktop(
    userDataDirectory,
    codexHome,
    port,
    responsesPort,
    `${fakeChatGpt.url}/`,
  );
  page = await currentApp.firstWindow();
  attachRendererDiagnostics(page);
  await page.getByRole("button", { name: "Remove Web models" }).waitFor();
  assert.equal(
    await page
      .getByLabel(
        "Put new tasks in a same-named ChatGPT Project (create it if missing)",
      )
      .isChecked(),
    true,
  );
  await page
    .getByLabel(
      "Put new tasks in a same-named ChatGPT Project (create it if missing)",
    )
    .click();
  await waitForChecked(
    page.getByLabel(
      "Put new tasks in a same-named ChatGPT Project (create it if missing)",
    ),
    false,
  );
  await waitForText(
    page,
    "Project mapping is off; new tasks use normal ChatGPT conversations.",
  );
  assert.equal(
    await projectRequest("project-auto-native", "project-turn-resume"),
    autoProjectChat,
  );
  const disabledChat = await projectRequest(
    "project-task-disabled",
    "project-turn-disabled",
  );
  assert.ok(disabledChat.startsWith(fakeChatGpt.url + "/c/"), disabledChat);
  process.stdout.write(
    "Desktop E2E: project UI without manual mappings, automatic sidebar/worktree routing, projectless isolation, persistence and disable passed\n",
  );
  assert.equal(
    (
      await page.evaluate(() =>
        globalThis.codexgptBridge.getWebProviderStatus(),
      )
    ).running,
    true,
  );
  const migratedModelsResponse = await globalThis.fetch(
    `http://127.0.0.1:${responsesPort}/v1/models`,
    { headers: { authorization: "Bearer provider-e2e" } },
  );
  assert.equal(migratedModelsResponse.status, 200);
  assert.ok(
    (await migratedModelsResponse.json()).models.some(
      (model) => model.slug === "acme-router/special",
    ),
    "V3 journal did not recover the original provider after restart.",
  );
  process.stdout.write("Desktop E2E: standalone Web provider restart passed\n");
  assert.equal(
    Object.hasOwn(
      await page.evaluate(() => globalThis.codexgptBridge.getSettings()),
      "webModelFamily",
    ),
    false,
  );
  if (process.argv.includes("--capture-model-ui")) {
    await mkdir(join(repositoryRoot, "release"), { recursive: true });
    await page.locator(".providerCard").screenshot({
      path: join(repositoryRoot, "release", "model-verification-0.1.21.png"),
    });
  }
  await page.getByRole("button", { name: "Remove Web models" }).click();
  await page.getByRole("button", { name: "Install Web models" }).waitFor();

  const preMcpConfig = await readFile(codexConfigPath, "utf8");
  assert.deepEqual(
    preMcpConfig.split(/\r?\n/).filter(Boolean).sort(),
    originalCodexConfig.split(/\r?\n/).filter(Boolean).sort(),
  );
  await page.getByRole("button", { name: "Open ChatGPT login" }).click();
  await waitForText(page, "ChatGPT signed in", 5_000);
  const chatGptPage = currentApp
    .windows()
    .find((candidate) => candidate.url() === fakeChatGpt.url + "/");
  assert.ok(chatGptPage, "ChatGPT provider window was not found.");
  await page.getByRole("button", { name: "Install Web models" }).click();
  await page.getByRole("button", { name: "Remove Web models" }).waitFor();
  const providerInstalledConfig = await readFile(codexConfigPath, "utf8");
  assert.match(
    providerInstalledConfig,
    new RegExp(
      `# >>> CodexGPT Bridge managed Web provider\\r?\\nopenai_base_url = "http://127\\.0\\.0\\.1:${responsesPort}/v1"\\r?\\nmodel_catalog_json = .+\\r?\\n# <<< CodexGPT Bridge managed Web provider`,
    ),
  );
  assert.doesNotMatch(providerInstalledConfig, /CodexGPT Bridge managed MCP/);
  assert.doesNotMatch(
    providerInstalledConfig,
    new RegExp(fakeOriginalProvider.url),
  );
  const providerJournal = JSON.parse(
    await readFile(
      join(userDataDirectory, "codex-provider-integration.json"),
      "utf8",
    ),
  );
  assert.equal(providerJournal.version, 5);
  assert.match(
    providerInstalledConfig,
    /CodexGPT Bridge managed Interrupt hook/u,
  );
  assert.equal(
    providerJournal.upstreamBaseUrl,
    `${fakeOriginalProvider.url}/v1`,
  );
  const catalogAssignment = providerInstalledConfig.match(
    /^model_catalog_json\s*=\s*(.+)$/m,
  )?.[1];
  assert.ok(catalogAssignment);
  const managedCatalogPath = JSON.parse(catalogAssignment);
  const startupCatalog = JSON.parse(await readFile(managedCatalogPath, "utf8"));
  assert.deepEqual(
    startupCatalog.models.map((model) => model.slug),
    [
      "gpt-native-e2e",
      "chatgpt-web/light",
      "chatgpt-web/medium",
      "chatgpt-web/high",
      "chatgpt-web/extra-high",
      "chatgpt-web/pro",
      "acme-router/special",
      "codexgpt-bridge/instant",
      "codexgpt-bridge/medium",
      "codexgpt-bridge/high",
      "codexgpt-bridge/extra-high",
      "codexgpt-bridge/pro",
    ],
  );
  assert.deepEqual(
    startupCatalog.models.find((model) => model.slug === "chatgpt-web/high"),
    legacyWebModelFixtures.find((model) => model.slug === "chatgpt-web/high"),
  );
  assert.deepEqual(
    startupCatalog.models.find((model) => model.slug === "codexgpt-bridge/high")
      .input_modalities,
    ["text", "image"],
  );
  const modelsResponse = await globalThis.fetch(
    `http://127.0.0.1:${responsesPort}/v1/models?client_version=e2e`,
    { headers: { authorization: "Bearer provider-e2e" } },
  );
  assert.equal(modelsResponse.status, 200);
  const modelsPayload = await modelsResponse.json();
  assert.deepEqual(
    modelsPayload.models.map((model) => model.slug),
    [
      "gpt-native-e2e",
      "chatgpt-web/light",
      "chatgpt-web/medium",
      "chatgpt-web/high",
      "chatgpt-web/extra-high",
      "chatgpt-web/pro",
      "acme-router/special",
      "codexgpt-bridge/instant",
      "codexgpt-bridge/medium",
      "codexgpt-bridge/high",
      "codexgpt-bridge/extra-high",
      "codexgpt-bridge/pro",
    ],
  );

  for (const model of ["chatgpt-web/pro", "acme-router/special"]) {
    const originalProviderResponse = await globalThis.fetch(
      `http://127.0.0.1:${responsesPort}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer provider-e2e",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          stream: true,
          input: "original-provider-e2e",
        }),
      },
    );
    const originalProviderBody = await originalProviderResponse.text();
    assert.equal(originalProviderResponse.status, 200, originalProviderBody);
    assert.match(
      originalProviderBody,
      new RegExp(`ORIGINAL_PROVIDER_E2E_OK:${model.replace("/", "\\/")}`),
    );
  }
  assert.deepEqual(originalProviderRequests, [
    { model: "chatgpt-web/pro", authorization: "Bearer provider-e2e" },
    { model: "acme-router/special", authorization: "Bearer provider-e2e" },
  ]);

  for (const [model, label] of [
    ["codexgpt-bridge/instant", "Instant"],
    ["codexgpt-bridge/medium", "Medium"],
    ["codexgpt-bridge/high", "High"],
    ["codexgpt-bridge/extra-high", "Extra High"],
    ["codexgpt-bridge/pro", "Pro"],
  ]) {
    process.stdout.write(`Desktop E2E: testing ${model}\n`);
    const providerResponse = await globalThis.fetch(
      `http://127.0.0.1:${responsesPort}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer provider-e2e",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          stream: true,
          input: `provider-e2e ${model}`,
        }),
        signal: globalThis.AbortSignal.timeout(25_000),
      },
    );
    const providerBody = await providerResponse.text();
    assert.equal(providerResponse.status, 200, providerBody);
    assert.match(providerBody, new RegExp(`PROVIDER_E2E_OK:${label}`));
    assert.match(providerBody, /event: response\.completed/);
    process.stdout.write(`Desktop E2E: ${model} passed\n`);
  }

  process.stdout.write(
    "Desktop E2E: concurrent tasks, queued cancellation and settled DOM delivery\n",
  );
  for (const scenario of ["fast", "paused", "live"]) {
    await chatGptPage.evaluate(() => {
      globalThis.localStorage.removeItem("provider-stale-reload-armed");
      globalThis.localStorage.removeItem("provider-stale-reload-observed");
    });
    const response = await globalThis.fetch(
      `http://127.0.0.1:${responsesPort}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer provider-e2e",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/high",
          stream: true,
          input: "provider-completion-e2e " + `${scenario}-generation`,
          metadata: {
            thread_id: "completion-" + scenario,
            turn_id: "completion-turn-" + scenario,
          },
        }),
        signal: globalThis.AbortSignal.timeout(25_000),
      },
    );
    let body = "";
    if (scenario === "live") {
      const reader = response.body.getReader();
      const decoder = new globalThis.TextDecoder();
      let sawEarlyProgress = false;
      let sawFinalDelta = false;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        body += decoder.decode(chunk.value, { stream: true });
        if (
          !sawEarlyProgress &&
          body.includes("_bridge_working") &&
          body.includes("response.output_text.delta")
        ) {
          assert.equal(
            completionFinalTimes.has("live"),
            false,
            "Progress must arrive before ChatGPT finishes",
          );
          sawEarlyProgress = true;
        }
        if (!sawFinalDelta && body.includes('"delta":"COMPLETION_')) {
          assert.equal(
            completionFinalTimes.has("live"),
            true,
            "Plain answer text must wait for ChatGPT completion",
          );
          sawFinalDelta = true;
        }
      }
      assert.equal(sawEarlyProgress, true, "Expected live Bridge progress");
      assert.equal(sawFinalDelta, true, "Expected settled answer text");
      assert.doesNotMatch(body, /codex_text/u);
    } else body = await response.text();
    assert.match(
      body,
      /response.completed/,
      body
        .split("\n")
        .find((line) => line.includes('"type":"response.failed"')),
    );
    assert.doesNotMatch(body, /response.failed|EARLY_COMPLETE_FRAME/);
    assert.match(body, new RegExp("COMPLETION_FINAL_" + scenario));
    const finalAt = completionFinalTimes.get(scenario);
    assert.ok(
      finalAt,
      "Server must finish the correct response before delivery",
    );
    const deliveryMs = Date.now() - finalAt;
    assert.ok(
      deliveryMs >= 0 && deliveryMs < 1_900,
      "Bound final -> Codex delivery: " + deliveryMs + "ms",
    );
    process.stdout.write(
      `Desktop E2E: ${scenario} generation, stale Stop cleared, final delivery ${deliveryMs}ms\n`,
    );
    await chatGptPage
      .getByTestId("stop-button")
      .waitFor({ state: "detached", timeout: 5_000 });
    // A completed turn may keep its confirmed proof without reloading. If the
    // retained Stop blocks the next model check, the next turn must repair the
    // same conversation before it submits; the fast fixture asserts that below.
    const followup = await globalThis.fetch(
      `http://127.0.0.1:${responsesPort}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer provider-e2e",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/high",
          stream: true,
          input: [
            {
              role: "user",
              content: "provider-completion-e2e " + `${scenario}-generation`,
            },
            {
              role: "assistant",
              content: "COMPLETION_FINAL_" + scenario,
            },
            {
              role: "user",
              content:
                scenario === "fast"
                  ? "provider-e2e-stale-control-reload follow-up after stale stop"
                  : "provider-e2e follow-up after stale stop",
            },
          ],
          metadata: {
            thread_id: "completion-" + scenario,
            turn_id: "completion-followup-" + scenario,
          },
        }),
        signal: globalThis.AbortSignal.timeout(25_000),
      },
    );
    const nextBody = await followup.text();
    assert.match(nextBody, /PROVIDER_E2E_OK/);
    if (scenario === "fast") assert.match(nextBody, /STALE_RELOAD_OK/);
    assert.doesNotMatch(nextBody, /response.failed/);
  }
  process.stdout.write(
    "Desktop E2E: three completed surfaces and retained follow-ups passed\n",
  );
  const completionDiagnosticsText = await readFile(
    join(userDataDirectory, "completion-diagnostics.json"),
    "utf8",
  );
  const completionDiagnostics = JSON.parse(completionDiagnosticsText);
  assert.ok(
    completionDiagnostics.some((record) =>
      record.observations.some(
        (row) => row.reason === "completed-confirmed-message",
      ),
    ),
  );
  assert.ok(
    completionDiagnostics.some((record) =>
      record.preparationSteps?.some(
        (step) =>
          step.stage === "reload-confirmed-stale-stop" &&
          step.outcome === "completed",
      ),
    ),
  );
  assert.doesNotMatch(
    completionDiagnosticsText,
    /COMPLETION_FINAL|EARLY_COMPLETE_FRAME/,
  );
  assert.doesNotMatch(
    completionDiagnosticsText,
    /clear-completed-stop-control|settle-completed-page/,
  );
  for (const repeatFailure of [false, true]) {
    const before = await chatGptPage.evaluate(
      () => globalThis.__providerSendCount,
    );
    const response = await globalThis.fetch(
      `http://127.0.0.1:${responsesPort}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer provider-e2e",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/high",
          stream: true,
          input:
            "provider-template-failure-e2e " +
            (repeatFailure ? "repeat-failure" : "recover"),
          metadata: {
            thread_id: "template-recovery-" + repeatFailure,
            turn_id: "template-turn-" + repeatFailure,
          },
          tools: [{ type: "custom", name: "exec", format: { type: "text" } }],
        }),
        signal: globalThis.AbortSignal.timeout(30_000),
      },
    );
    const body = await response.text();
    const events = body
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)));
    const terminal = events.at(-1);
    assert.equal(
      terminal.type,
      repeatFailure ? "response.failed" : "response.completed",
      body,
    );
    assert.match(body, /"phase":"commentary"/);
    assert.match(body, /正在自動修正一次/);
    assert.doesNotMatch(body, /MUST_NOT_EXECUTE|<codex_tool_calls>/);
    assert.equal(
      (await chatGptPage.evaluate(() => globalThis.__providerSendCount)) -
        before,
      2,
      "Exactly one correction submission",
    );
    if (!repeatFailure) {
      const calls = terminal.response.output.filter(
        (item) => item.type === "custom_tool_call",
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].input, "CORRECTED_CLIENT_TOOL");
    } else
      assert.ok(
        terminal.response.output.every(
          (item) => item.type === "message" && item.phase === "commentary",
        ),
      );
  }
  process.stdout.write(
    "Desktop E2E: failed template repaired in the same conversation; repeated failure is explicit\n",
  );
  const parallelResponses = Array.from(
    { length: BRIDGE_WEB_TASK_CONCURRENCY + 1 },
    (_, index) => index + 1,
  ).map((index) =>
    globalThis.fetch(`http://127.0.0.1:${responsesPort}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer provider-e2e",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        stream: true,
        input: "provider-stream-e2e " + index,
        metadata: {
          thread_id: "parallel-task-" + index,
          turn_id: "parallel-turn-" + index,
        },
      }),
      // Includes opening an independent page, selecting its mode and settling
      // the whole answer, rather than just receiving the first text delta.
      signal: globalThis.AbortSignal.timeout(60_000),
    }),
  );
  const responses = await Promise.all(parallelResponses);
  let running;
  for (let attempt = 0; attempt < 60; attempt++) {
    running = await page.evaluate(() =>
      globalThis.codexgptBridge.getWebProviderStatus(),
    );
    if (
      running.tasks?.filter((task) => task.state === "generating").length ===
        BRIDGE_WEB_TASK_CONCURRENCY &&
      running.tasks?.filter((task) => task.state === "queued").length === 1
    )
      break;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  }
  assert.equal(
    running.tasks.filter((task) => task.state === "generating").length,
    BRIDGE_WEB_TASK_CONCURRENCY,
  );
  assert.equal(
    running.tasks.filter((task) => task.state === "queued").length,
    1,
  );
  const queued = running.tasks.find((task) => task.state === "queued");
  assert.ok(queued);
  await page.evaluate(
    (id) => globalThis.codexgptBridge.cancelWebTask(id),
    queued.threadId,
  );
  await Promise.all(
    responses.map(async (response, index) => {
      if (queued.threadId === "parallel-task-" + (index + 1)) {
        assert.match(await response.text(), /response.failed/);
        return;
      }
      const reader = response.body.getReader();
      let body = "";
      while (!body.includes("response.output_text.delta")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        body += new globalThis.TextDecoder().decode(chunk.value);
      }
      assert.match(body, /"phase":"commentary"/);
      assert.doesNotMatch(body, /STREAM_END|response.completed/);
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        body += new globalThis.TextDecoder().decode(chunk.value);
      }
      assert.match(body, /STREAM_END/);
      assert.match(body, /response.completed/);
      assert.doesNotMatch(body, /response.failed/);
    }),
  );
  process.stdout.write(
    "Desktop E2E: concurrent streaming and cancellation passed\n",
  );

  for (let round = 1; round <= (nativeSmoke ? 1 : 12); round += 1) {
    process.stdout.write(`Desktop E2E: endurance round ${round}/12\n`);
    const providerResponse = await globalThis.fetch(
      `http://127.0.0.1:${responsesPort}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer provider-e2e",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/extra-high",
          stream: true,
          input: `provider-e2e endurance round ${round}`,
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify({
              turn_id: `desktop-e2e-endurance-${round}`,
            }),
          },
        }),
        signal: globalThis.AbortSignal.timeout(25_000),
      },
    );
    const providerBody = await providerResponse.text();
    assert.equal(providerResponse.status, 200, providerBody);
    assert.match(providerBody, /PROVIDER_E2E_OK:Extra High/);
    assert.match(providerBody, /event: response\.completed/);
  }

  process.stdout.write(
    "Desktop E2E: testing transport reconnect deduplication\n",
  );
  const sendsBeforeReconnect = await chatGptPage.evaluate(
    () => globalThis.__providerSendCount,
  );
  const reconnectBody = JSON.stringify({
    model: "codexgpt-bridge/extra-high",
    stream: true,
    input: "provider-e2e reconnect once",
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        turn_id: "desktop-e2e-reconnect-once",
        thread_id: "thread-reconnect-once",
      }),
    },
  });
  const disconnectedController = new globalThis.AbortController();
  const disconnectedResponse = await globalThis.fetch(
    `http://127.0.0.1:${responsesPort}/v1/responses`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer provider-e2e",
        "content-type": "application/json",
      },
      body: reconnectBody,
      signal: disconnectedController.signal,
    },
  );
  assert.equal(disconnectedResponse.status, 200);
  assert.ok(disconnectedResponse.body);
  await disconnectedResponse.body.getReader().read();
  disconnectedController.abort();
  await new Promise((resolvePromise) =>
    globalThis.setTimeout(resolvePromise, 25),
  );
  const reconnectedResponse = await globalThis.fetch(
    `http://127.0.0.1:${responsesPort}/v1/responses`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer provider-e2e",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...JSON.parse(reconnectBody),
        // Native Codex may rebuild instruction metadata between transport
        // attempts. This is still the same logical browser turn.
        instructions: "provider-e2e refreshed reconnect instructions",
      }),
      signal: globalThis.AbortSignal.timeout(25_000),
    },
  );
  const reconnectedBody = await reconnectedResponse.text();
  assert.equal(reconnectedResponse.status, 200, reconnectedBody);
  assert.match(reconnectedBody, /PROVIDER_E2E_OK:Extra High/);
  assert.match(reconnectedBody, /event: response\.completed/);
  const sendsAfterReconnect = await chatGptPage.evaluate(
    () => globalThis.__providerSendCount,
  );
  assert.equal(sendsAfterReconnect, sendsBeforeReconnect + 1);
  process.stdout.write(
    "Desktop E2E: transport reconnect deduplication passed\n",
  );

  process.stdout.write("Desktop E2E: testing local tool isolation\n");
  const sendsBeforeNativeToolIsolation = await chatGptPage.evaluate(() => {
    globalThis.localStorage.removeItem("provider-native-tool-cleared");
    return globalThis.__providerSendCount;
  });
  const armed = await globalThis.fetch(fakeChatGpt.url + "/__arm-native-tool", {
    method: "POST",
  });
  assert.equal(armed.status, 204);
  const localToolResponse = await globalThis.fetch(
    `http://127.0.0.1:${responsesPort}/v1/responses`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer provider-e2e",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        stream: true,
        input: [{ role: "user", content: "C:\\work 新增檔案" }],
        tools: [
          {
            type: "namespace",
            name: "codex_apps",
            tools: [
              {
                type: "function",
                name: "devspace_open_workspace",
                description: "Local coding workspace through DevSpace MCP.",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
          {
            type: "namespace",
            name: "custom_client",
            tools: [
              {
                type: "function",
                name: "open_workspace",
                description: "Open an explicitly allowed local workspace.",
                parameters: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                },
              },
            ],
          },
        ],
      }),
      signal: globalThis.AbortSignal.timeout(60_000),
    },
  );
  const localToolBody = await localToolResponse.text();
  const disarmed = await globalThis.fetch(
    fakeChatGpt.url + "/__disarm-native-tool",
    { method: "POST" },
  );
  assert.equal(disarmed.status, 204);
  assert.equal(localToolResponse.status, 200, localToolBody);
  assert.match(localToolBody, /"name":"open_workspace"/);
  assert.match(localToolBody, /"namespace":"custom_client"/);
  assert.doesNotMatch(localToolBody, /devspace/i);
  assert.equal(
    await chatGptPage.evaluate(() => globalThis.__providerSendCount),
    sendsBeforeNativeToolIsolation + 1,
    "A selected ChatGPT App must be removed before the first submission, not repaired after a failed template turn",
  );
  assert.equal(
    await chatGptPage.evaluate(() =>
      globalThis.localStorage.getItem("provider-native-tool-cleared"),
    ),
    "1",
  );
  process.stdout.write(
    "Desktop E2E: selected native App cleared before local tool submission\n",
  );

  const imageProviderResponse = await globalThis.fetch(
    `http://127.0.0.1:${responsesPort}/v1/responses`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer provider-e2e",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        stream: true,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "provider-image-e2e" },
              {
                type: "input_image",
                image_url: "data:image/png;base64,aGVsbG8=",
              },
            ],
          },
        ],
      }),
      signal: globalThis.AbortSignal.timeout(25_000),
    },
  );
  const imageProviderBody = await imageProviderResponse.text();
  assert.equal(imageProviderResponse.status, 200, imageProviderBody);
  assert.match(imageProviderBody, /PROVIDER_IMAGE_E2E_OK/);
  await runChatGptDomChecks(currentApp);

  process.stdout.write(
    "Desktop E2E: testing generated-image/text round trips\n",
  );
  const fixturePng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  // This protocol override belongs only to the isolated E2E profile, never the signed-in profile.
  await currentApp.evaluate(({ session }, png) => {
    session
      .fromPartition("persist:codexgpt-bridge-chatgpt")
      .protocol.handle("https", (request) => {
        if (!request.url.startsWith("https://chatgpt.com/__bridge_e2e__/"))
          return new globalThis.Response(null, { status: 404 });
        return new globalThis.Response(globalThis.Buffer.from(png, "base64"), {
          headers: { "content-type": "image/png" },
        });
      });
  }, fixturePng);
  for (let round = 0; round < (nativeSmoke ? 2 : 6); round++) {
    const expectImage = round % 2 === 0;
    const response = await globalThis.fetch(
      `http://127.0.0.1:${responsesPort}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer provider-e2e",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/high",
          stream: true,
          input: expectImage
            ? "provider-generated-image-e2e"
            : "provider-e2e follow-up text only",
          metadata: { turn_id: `image-round-${round}` },
        }),
        signal: globalThis.AbortSignal.timeout(25_000),
      },
    );
    const body = await response.text();
    const events = body
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)));
    const completed = events.filter(
      (event) => event.type === "response.completed",
    );
    assert.equal(completed.length, 1, body);
    assert.equal(
      events.some((event) => event.type === "response.failed"),
      false,
      body,
    );
    const images = completed[0].response.output.filter(
      (item) => item.type === "image_generation_call",
    );
    assert.equal(
      images.length,
      expectImage ? 1 : 0,
      "An old image must not be replayed on a text-only follow-up",
    );
    const messages = completed[0].response.output.filter(
      (item) =>
        item.type === "message" &&
        item.role === "assistant" &&
        item.phase !== "commentary",
    );
    assert.equal(
      messages.length,
      1,
      "Every completed turn must have a visible assistant message",
    );
    const messageText = messages[0].content
      .map((part) => part.text ?? "")
      .join("");
    if (expectImage) {
      assert.equal(images[0].result, fixturePng);
      const match = /!\[Generated image 1\]\(<([^>]+)>\)/.exec(messageText);
      assert.ok(
        match,
        "Generated images must be embedded in the assistant message",
      );
      assert.equal((await readFile(match[1])).toString("base64"), fixturePng);
    } else assert.doesNotMatch(messageText, /!\[Generated image/);
  }
  process.stdout.write(
    `Desktop E2E: ${nativeSmoke ? 2 : 6} generated-image/text round trips passed\n`,
  );

  process.stdout.write(
    "Desktop E2E: testing one automatic retry after a transient image-tool failure\n",
  );
  const beforeAutomaticImageRetry = await chatGptPage.evaluate(
    () => globalThis.__providerSendCount,
  );
  const automaticRetryResponse = await globalThis.fetch(
    `http://127.0.0.1:${responsesPort}/v1/responses`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer provider-e2e",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        stream: true,
        input: "generate image provider-transient-image-failure-e2e",
        metadata: {
          turn_id: "automatic-image-generation-retry",
          thread_id: "thread-automatic-image-generation-retry",
        },
      }),
      signal: globalThis.AbortSignal.timeout(30_000),
    },
  );
  const automaticRetryBody = await automaticRetryResponse.text();
  assert.equal(automaticRetryResponse.status, 200, automaticRetryBody);
  assert.match(automaticRetryBody, /event: response\.completed/);
  assert.doesNotMatch(automaticRetryBody, /event: response\.failed/);
  assert.match(automaticRetryBody, /"type":"image_generation_call"/);
  assert.match(automaticRetryBody, /!\[Generated image 1\]/);
  assert.doesNotMatch(automaticRetryBody, /couldn.t generate the image/iu);
  assert.equal(
    await chatGptPage.evaluate(() => globalThis.__providerSendCount),
    beforeAutomaticImageRetry + 2,
    "A transient image failure should cause exactly one internal retry",
  );
  process.stdout.write("Desktop E2E: automatic transient image retry passed\n");

  process.stdout.write(
    "Desktop E2E: testing failed-image transfer retry without resubmission\n",
  );
  await currentApp.evaluate(({ session }) => {
    const target = session.fromPartition("persist:codexgpt-bridge-chatgpt");
    const fetch = target.fetch.bind(target);
    let failOnce = true;
    target.fetch = async (url, options) => {
      if (failOnce && String(url).includes("/__bridge_e2e__/")) {
        failOnce = false;
        return new globalThis.Response(null, { status: 503 });
      }
      return fetch(url, options);
    };
  });
  const beforeImageRetry = await chatGptPage.evaluate(
    () => globalThis.__providerSendCount,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await globalThis.fetch(
      `http://127.0.0.1:${responsesPort}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer provider-e2e",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/high",
          stream: true,
          input: "provider-generated-image-e2e retry",
          metadata: {
            turn_id: "image-transfer-retry",
            thread_id: "thread-image-retry",
          },
        }),
        signal: globalThis.AbortSignal.timeout(25_000),
      },
    );
    const body = await response.text();
    assert.match(
      body,
      attempt === 0 ? /event: response\.failed/ : /event: response\.completed/,
    );
    assert.doesNotMatch(
      body,
      attempt === 0 ? /event: response\.completed/ : /event: response\.failed/,
    );
  }
  assert.equal(
    await chatGptPage.evaluate(() => globalThis.__providerSendCount),
    beforeImageRetry + 1,
  );
  process.stdout.write("Desktop E2E: failed-image transfer retry passed\n");

  process.stdout.write(
    "Desktop E2E: testing research citations and partial-media failure\n",
  );
  await currentApp.evaluate(({ session }) => {
    const target = session.fromPartition("persist:codexgpt-bridge-chatgpt");
    const fetch = target.fetch.bind(target);
    target.fetch = async (url, options) =>
      String(url).includes("failed-transfer.png")
        ? new globalThis.Response(null, { status: 503 })
        : fetch(url, options);
  });
  for (const scenario of [
    "citation",
    "citation-inline-protocol",
    "unsupported-source",
    "download-failure",
    "citation-follow-up",
  ]) {
    const response = await globalThis.fetch(
      `http://127.0.0.1:${responsesPort}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer provider-e2e",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/high",
          stream: true,
          input: `provider-media-fallback-e2e ${scenario}`,
          metadata: { turn_id: `media-fallback-${scenario}` },
        }),
        signal: globalThis.AbortSignal.timeout(25_000),
      },
    );
    const body = await response.text();
    assert.equal(
      (body.match(/event: response\.completed/g) ?? []).length,
      1,
      body,
    );
    assert.doesNotMatch(body, /event: response\.failed/, body);
    assert.match(body, /COMPLETE_RESEARCH_TEXT/);
    assert.match(body, /\| Source \| Result \|/);
    if (scenario.includes("inline-protocol")) {
      assert.match(body, /`<codex_tool_calls>`/);
      assert.match(body, /EXPLANATION_END/);
      assert.doesNotMatch(body, /"type":"function_call"/);
    }
    assert.doesNotMatch(body, /"type":"image_generation_call"/);
    if (scenario.startsWith("citation"))
      assert.doesNotMatch(body, /圖片未能傳回 Codex/);
    else assert.match(body, /圖片未能傳回 Codex/);
  }
  process.stdout.write(
    "Desktop E2E: research citations and partial-media failure passed\n",
  );

  const taskUrls = new Map();
  for (const task of ["task-alpha", "task-beta", "task-alpha"]) {
    const response = await globalThis.fetch(
      `http://127.0.0.1:${responsesPort}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer provider-e2e",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/high",
          stream: true,
          input: "provider-e2e isolated task",
          metadata: { thread_id: task },
        }),
        signal: globalThis.AbortSignal.timeout(60_000),
      },
    );
    const body = await response.text();
    assert.match(body, /event: response\.completed/);
    const mappings = JSON.parse(
      await readFile(
        join(userDataDirectory, "chatgpt-conversations.json"),
        "utf8",
      ),
    );
    const url = new Map(mappings.conversations).get(task);
    assert.ok(url);
    if (taskUrls.has(task)) assert.equal(url, taskUrls.get(task));
    else taskUrls.set(task, url);
  }
  assert.notEqual(taskUrls.get("task-alpha"), taskUrls.get("task-beta"));
  process.stdout.write(
    "Desktop E2E: task A -> B -> A conversation isolation passed\n",
  );

  for (const appWindow of currentApp.windows()) {
    if (appWindow !== page) await appWindow.close();
  }

  const firstDesktopPid = currentApp.process().pid;
  await page.close();
  assert.doesNotThrow(() => process.kill(firstDesktopPid, 0));

  const providerStillRunning = await globalThis.fetch(
    `http://127.0.0.1:${responsesPort}/v1/models?client_version=after-close`,
    {
      headers: { authorization: "Bearer provider-e2e" },
      signal: globalThis.AbortSignal.timeout(1_500),
    },
  );
  assert.equal(providerStillRunning.status, 200);

  const reopenedWindow = currentApp.waitForEvent("window");
  await currentApp.evaluate(({ app }) => app.emit("activate"));
  page = await reopenedWindow;
  attachRendererDiagnostics(page);
  await page.getByRole("button", { name: "Remove Web models" }).waitFor();
  await page.getByRole("button", { name: "Remove Web models" }).click();
  await page.getByRole("button", { name: "Install Web models" }).waitFor();
  await page.close();
  // Explicit Quit stops the provider after the tray has kept the host alive.
  await currentApp.evaluate(({ app }) => app.quit());
  await waitForProcessExit(firstDesktopPid);
  currentApp = undefined;

  currentApp = await launchDesktop(
    userDataDirectory,
    codexHome,
    port,
    responsesPort,
    `${fakeChatGpt.url}/`,
  );
  page = await currentApp.firstWindow();
  attachRendererDiagnostics(page);
  await page.getByRole("button", { name: "Install Web models" }).waitFor();
  assert.equal(await page.locator(".workspaceSettings").count(), 0);
  await page.getByRole("button", { name: "Install Web models" }).click();
  await page.getByRole("button", { name: "Remove Web models" }).waitFor();
  const configWithUserEdit = `${await readFile(codexConfigPath, "utf8")}\n[features]\ngoals = true\n`;
  await writeFile(codexConfigPath, configWithUserEdit, "utf8");
  await writeFile(codexConfigPath, configWithUserEdit, "utf8");
  assert.doesNotMatch(configWithUserEdit, /CodexGPT Bridge managed MCP/);
  await page.getByRole("button", { name: "Remove Web models" }).click();
  await page.getByRole("button", { name: "Install Web models" }).waitFor();
  const providerRemovedConfig = await readFile(codexConfigPath, "utf8");
  assert.doesNotMatch(
    providerRemovedConfig,
    /CodexGPT Bridge managed Web provider/,
  );
  assert.match(
    providerRemovedConfig,
    new RegExp(
      `^openai_base_url = "${fakeOriginalProvider.url.replaceAll(".", "\\.")}/v1"$`,
      "m",
    ),
  );
  assert.match(providerRemovedConfig, /model = "gpt-5\.6-sol"/);
  assert.match(providerRemovedConfig, /\[features\]\r?\ngoals = true/);
  await currentApp.close();
  currentApp = undefined;

  assert.ok(
    serverSessionProbeCount >= 3,
    `Expected install and pre-submit server-session probes, observed ${serverSessionProbeCount}.`,
  );

  process.stdout.write(
    `Desktop E2E passed (${packaged ? "packaged" : "development"}): retired workspace settings/UI/API, reversible provider setup, five ChatGPT browser modes, client tool isolation, streaming, media transfer, conversation isolation, tray survival, reconnect and clean restart.\n`,
  );
} catch (error) {
  process.stderr.write(
    `[desktop e2e failure] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  const provider = currentApp
    ?.windows()
    .find((candidate) => candidate.url().startsWith(fakeChatGpt.url));
  if (provider)
    process.stderr.write(
      `[provider failure state] ${await provider
        .locator("body")
        .innerHTML()
        .catch(() => "unavailable")}\n`,
    );
  throw error;
} finally {
  if (currentApp !== undefined) {
    try {
      const [cleanupPage] = currentApp.windows();
      if (cleanupPage !== undefined) {
        const removeProvider = cleanupPage.getByRole("button", {
          name: "Remove Web models",
        });
        if (await removeProvider.isVisible().catch(() => false)) {
          await removeProvider.click().catch(() => undefined);
        }
      }
    } finally {
      await currentApp.close().catch(() => undefined);
    }
  }
  await fakeChatGpt.close().catch(() => undefined);
  await fakeOriginalProvider.close().catch(() => undefined);
  const cleanupPath = resolve(userDataDirectory);
  const withinTemp = relative(resolve(tmpdir()), cleanupPath);
  assert.ok(
    withinTemp &&
      !isAbsolute(withinTemp) &&
      withinTemp !== ".." &&
      !withinTemp.startsWith(`..${sep}`) &&
      cleanupPath === userDataDirectory,
  );
  await rm(cleanupPath, { recursive: true, force: true });
}
