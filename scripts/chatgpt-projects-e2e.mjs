import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron } from "playwright-core";

const fixture = `<!doctype html><main>
  <button data-testid="model-switcher-dropdown-button" aria-haspopup="menu">High</button>
  <div id="prompt-textarea" contenteditable="true"></div>
  <button data-testid="send-button">Send</button><div id="messages"></div>
  </main><script>
  const composer = document.querySelector('#prompt-textarea');
  const messages = document.querySelector('#messages');
  messages.innerHTML = localStorage.getItem(location.pathname) || '';
  document.querySelector('[data-testid="send-button"]').onclick = () => {
    const start = location.pathname;
    if (!start.includes('/c/')) {
      const prefix = start.endsWith('/project') ? start.slice(0, -8) : '';
      history.replaceState({}, '', prefix + '/c/' + crypto.randomUUID());
    }
    const user = document.createElement('div');
    user.setAttribute('data-message-author-role', 'user'); user.textContent = composer.textContent;
    composer.textContent = '';
    const reply = document.createElement('div'); reply.setAttribute('data-testid', 'conversation-turn-' + crypto.randomUUID());
    reply.innerHTML = '<div data-message-author-role="assistant">PROJECT_OK</div><button data-testid="copy-turn-button">Copy</button>';
    messages.append(user, reply);
    localStorage.setItem(location.pathname, messages.innerHTML);
    fetch('/fixture-send', {method:'POST', body:JSON.stringify({start, url:location.pathname})});
  };
  </script>`;
const sends = [];
const projects = [
  { name: "Existing", path: "/g/g-p-existing/project" },
  { name: "Duplicate", path: "/g/g-p-duplicate-one/project" },
  { name: "Duplicate", path: "/g/g-p-duplicate-two/project" },
  { name: "Partial match", path: "/g/g-p-partial/project" },
];
const creates = [];
let sessionValid = true;
let listRequests = 0;
let searchMode = "controlled";
let projectLocale = "zh-TW";
let directoryLayout = "legacy";
const directoryPage = () => `<!doctype html><main>
  <h1>Projects</h1><input id="${searchMode === "missing-control" ? "unsupported-search" : directoryLayout === "index" ? "projects-index-search" : "projects-page-search"}" aria-label="Search projects" value="">
  <button id="new-project">${directoryLayout === "index" ? "Create" : projectLocale === "zh-TW" ? "新增" : "New"}</button><div id="results"></div>
  </main><dialog><form data-testid="create-new-project-form"><input id="${directoryLayout === "index" ? "chatgpt-project-name" : "project-name"}" aria-label="Project name" value=""><button disabled>${projectLocale === "zh-TW" ? "建立專案" : "Create project"}</button></form></dialog>
  <script>
  const projects = ${JSON.stringify(projects)};
  const search = document.querySelector('main input');
  const results = document.querySelector('#results');
  const mode = ${JSON.stringify(searchMode)};
  const layout = ${JSON.stringify(directoryLayout)};
  const hydratedAt = Date.now() + (mode === 'late-hydration' ? 2400 : 0);
  let query = '', timer;
  function render() {
    results.replaceChildren();
    const matches = projects.filter(p=>p.name.toLowerCase().includes(query.toLowerCase()));
    if (!matches.length) { const empty=document.createElement('p'); empty.textContent=${JSON.stringify(directoryLayout === "index" ? "No projects" : projectLocale === "zh-TW" ? "沒有符合的專案" : "No matching projects")};results.append(empty); }
    for (const p of matches) {
      const row=document.createElement('div');
      if (layout === 'index') {
        row.setAttribute('data-project-row','true');row.setAttribute('role','presentation');
        const cell=document.createElement('span');cell.className='truncate';cell.textContent=p.name;
        const updated=document.createElement('div');updated.textContent='2w';
        const toggle=document.createElement('button');toggle.setAttribute('aria-label','Toggle project');
        row.append(cell,toggle,updated);
        // Clicking an index row expands chats and never navigates. The
        // dedicated action must open the Project instead of its chat list.
        row.onclick=()=>{row.setAttribute('data-expanded','true');};
        if (mode !== 'missing-open-control') {
          const open=document.createElement('button');open.setAttribute('aria-label','Start new chat in project');
          open.textContent='+';open.onclick=(event)=>{event.stopPropagation();location.href=p.path;};row.append(open);
        }
      } else {
        row.setAttribute('role','row');row.setAttribute('data-page-table-selectable-row','true');
        const cell=document.createElement('div');cell.setAttribute('role','gridcell');cell.textContent=p.name;
        row.append(cell);row.onclick=()=>location.href=p.path;
      }
      results.append(row);
    }
  }
  // The fixture must reject synthetic setters/events, just as a not-yet-hydrated
  // controlled UI can leave its input value and rendered results out of sync.
  search.oninput=(event)=>{
    if (!event.isTrusted || mode === 'unacknowledged' || Date.now() < hydratedAt) return;
    search.setAttribute('value', search.value); query=search.value;
    if (mode === 'stale-results') return;
    clearTimeout(timer); results.setAttribute('aria-busy','true');
    timer=setTimeout(()=>{render();results.removeAttribute('aria-busy');}, 1400);
  }; render();
  const projectName=document.querySelector('dialog input');
  projectName.oninput=(event)=>{
    if (!event.isTrusted) return;
    projectName.setAttribute('value', projectName.value);
    document.querySelector('form button').disabled=!projectName.value;
  };
  document.querySelector('#new-project').onclick=()=>document.querySelector('dialog').showModal();
  document.querySelector('form').onsubmit=async(event)=>{
    event.preventDefault();
    const response=await fetch('/fixture-create',{method:'POST',body:projectName.value});
    const value=await response.json();if(value.path)location.href=value.path;
  };
  </script>`;
const server = createServer(async (request, response) => {
  if (request.url === "/api/auth/session") {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(sessionValid ? { user: { id: "project-fixture" } } : {}),
    );
  } else if (request.url === "/projects") {
    listRequests++;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(directoryPage());
  } else if (request.url === "/fixture-create") {
    let name = "";
    for await (const chunk of request) name += chunk.toString();
    creates.push(name);
    const project = { name, path: `/g/g-p-auto-${creates.length}/project` };
    if (name !== "Uncertain") projects.push(project);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(name === "Uncertain" ? {} : project));
  } else if (request.url === "/g/g-p-missing/project") {
    response.writeHead(302, { location: "/" });
    response.end();
  } else if (request.url === "/fixture-send") {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    sends.push(JSON.parse(body));
    response.end("OK");
  } else {
    response.setHeader("content-type", "text/html; charset=utf-8");
    const project = projects.find((p) => p.path === request.url);
    response.end(
      project
        ? fixture.replace(
            "<main>",
            "<main><h1>" +
              project.name.replaceAll("&", "&amp;").replaceAll("<", "&lt;") +
              "</h1>",
          )
        : fixture,
    );
  }
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
const directory = await mkdtemp(join(tmpdir(), "bridge-projects-e2e-"));
const conversationFile = join(directory, "conversations.json");
let app;
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [fileURLToPath(new URL("./chatgpt-mode-host.mjs", import.meta.url))],
    env: { ...process.env, CODEXGPT_BRIDGE_DOM_TEST_PROFILE: directory },
  });
  const createController = () =>
    app.evaluate(
      async (_electron, config) => {
        globalThis.projectController = new globalThis.ChatGptBrowserController(
          config.baseUrl,
          config.conversationFile,
        );
      },
      { baseUrl, conversationFile },
    );
  const run = (
    threadId,
    turnId,
    projectUrl,
    context,
    projectName,
    timeoutMs = 20_000,
  ) =>
    app.evaluate(
      async (_electron, input) => {
        try {
          const output = await globalThis.projectController.runTurn({
            ...input,
            operationId: input.turnId,
            prompt: "project fixture request",
            mode: "high",
            images: [],
            signal: globalThis.AbortSignal.timeout(input.timeoutMs),
          });
          return { output };
        } catch (error) {
          return { error: error.message, diagnosticCode: error.diagnosticCode };
        }
      },
      { threadId, turnId, projectUrl, context, projectName, timeoutMs },
    );
  const urlA = baseUrl + "g/g-p-project-a/project";
  const urlB = baseUrl + "g/g-p-project-b/project";
  await createController();
  assert.deepEqual(await run("task-aaa", "turn-aaa-1", urlA), {
    output: "PROJECT_OK",
  });
  assert.deepEqual(await run("task-bbb", "turn-bbb-1", urlB), {
    output: "PROJECT_OK",
  });
  assert.deepEqual(await run("task-normal", "turn-normal-1"), {
    output: "PROJECT_OK",
  });
  assert.equal(sends[0].start, "/g/g-p-project-a/project");
  assert.equal(sends[1].start, "/g/g-p-project-b/project");
  assert.equal(sends[2].start, "/");
  const firstChatA = sends[0].url;
  await app.evaluate(async () => globalThis.projectController.close());
  await createController();
  assert.deepEqual(await run("task-aaa", "turn-aaa-2", urlB), {
    output: "PROJECT_OK",
  });
  assert.equal(sends.at(-1).url, firstChatA);
  assert.deepEqual(await run("task-normal", "turn-normal-2", urlA), {
    output: "PROJECT_OK",
  });
  assert.equal(sends.at(-1).url, sends[2].url);
  // A context reset after restart must rebuild inside the original Project.
  assert.deepEqual(
    await run("task-aaa", "turn-aaa-reset", undefined, {
      instructions: "fixture",
      history: [],
      ledger: ["a".repeat(64)],
      images: [],
    }),
    { output: "PROJECT_OK" },
  );
  assert.equal(sends.at(-1).start, "/g/g-p-project-a/project");
  assert.notEqual(sends.at(-1).url, firstChatA);
  const stored = JSON.parse(await readFile(conversationFile, "utf8"));
  assert.equal(new Map(stored.projects).get("task-aaa"), urlA);
  const before = sends.length;
  const missing = await run(
    "task-missing",
    "turn-missing",
    baseUrl + "g/g-p-missing/project",
  );
  assert.match(missing.error, /無法確認 ChatGPT Project/);
  assert.equal(sends.length, before);
  const draft = await app.evaluate(async ({ BrowserWindow }, base) => {
    const window = BrowserWindow.getAllWindows().find(
      (w) => w.webContents.getURL() === base,
    );
    return window?.webContents.executeJavaScript(
      "document.querySelector('#prompt-textarea').textContent",
    );
  }, baseUrl);
  assert.equal(draft, "");
  const autoRun = (thread, name, timeoutMs) =>
    run(thread, thread + "-turn", undefined, undefined, name, timeoutMs);
  assert.deepEqual(await autoRun("auto-existing", "Existing"), {
    output: "PROJECT_OK",
  });
  assert.equal(sends.at(-1).start, "/g/g-p-existing/project");
  assert.equal(creates.length, 0);
  const autoName = "Bridge test project";
  assert.deepEqual(
    await Promise.all([
      autoRun("auto-new-1", autoName),
      autoRun("auto-new-2", autoName),
    ]),
    [{ output: "PROJECT_OK" }, { output: "PROJECT_OK" }],
  );
  assert.deepEqual(creates, [autoName]);
  assert.equal(sends.at(-1).start, "/g/g-p-auto-1/project");
  assert.equal(sends.at(-2).start, "/g/g-p-auto-1/project");
  searchMode = "late-hydration";
  assert.deepEqual(await autoRun("auto-hydration", autoName), {
    output: "PROJECT_OK",
  });
  assert.deepEqual(creates, [autoName]);
  searchMode = "controlled";
  projectLocale = "en";
  assert.deepEqual(await autoRun("auto-english", autoName), {
    output: "PROJECT_OK",
  });
  assert.deepEqual(creates, [autoName]);
  projectLocale = "zh-TW";
  const sendsBeforeErrors = sends.length;
  assert.match(
    (await autoRun("auto-duplicate", "Duplicate")).error,
    /多個同名/,
  );
  assert.match((await autoRun("auto-partial", "Partial")).error, /部分相符/);
  searchMode = "unacknowledged";
  assert.match(
    (await autoRun("auto-unacknowledged", "Never create")).error,
    /尚未接收專案搜尋/,
  );
  searchMode = "stale-results";
  assert.match(
    (await autoRun("auto-stale-results", "Never create")).error,
    /搜尋結果尚未更新/,
  );
  searchMode = "controlled";
  sessionValid = false;
  assert.ok((await autoRun("auto-expired", "Expired")).error);
  sessionValid = true;
  assert.equal(creates.length, 1);
  assert.equal(sends.length, sendsBeforeErrors);
  assert.ok((await autoRun("auto-uncertain", "Uncertain", 8_000)).error);
  assert.deepEqual(creates, [autoName, "Uncertain"]);
  await app.evaluate(async () => globalThis.projectController.close());
  // Cancellation returns to the caller before the browser worker has persisted
  // its final journal entry. Wait for that cleanup before simulating a restart.
  const cleanupDeadline = Date.now() + 5_000;
  for (;;) {
    const journal = JSON.parse(
      await readFile(conversationFile + ".operations.json", "utf8"),
    );
    if (journal.at(-1)?.phase === "failed") break;
    assert.ok(Date.now() < cleanupDeadline, "Cancelled worker did not settle.");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  }
  await createController();
  assert.match(
    (await autoRun("auto-uncertain-retry", "Uncertain")).error,
    /上次建立/,
  );
  assert.deepEqual(creates, [autoName, "Uncertain"]);
  // Existing tasks bypass discovery after restart, even with a changed requested name.
  const searchesBeforeRetained = listRequests;
  assert.deepEqual(
    await run(
      "auto-new-1",
      "auto-new-1-turn-2",
      undefined,
      undefined,
      "Different name",
    ),
    {
      output: "PROJECT_OK",
    },
  );
  assert.equal(listRequests, searchesBeforeRetained);
  assert.deepEqual(await autoRun("auto-new-3", autoName), {
    output: "PROJECT_OK",
  });
  assert.deepEqual(creates, [autoName, "Uncertain"]);
  directoryLayout = "index";
  projectLocale = "en";
  assert.deepEqual(await autoRun("index-existing", "Existing"), {
    output: "PROJECT_OK",
  });
  assert.equal(sends.at(-1).start, "/g/g-p-existing/project");
  assert.deepEqual(creates, [autoName, "Uncertain"]);
  const indexName = "Index new project";
  assert.deepEqual(
    await Promise.all([
      autoRun("index-new-1", indexName),
      autoRun("index-new-2", indexName),
    ]),
    [{ output: "PROJECT_OK" }, { output: "PROJECT_OK" }],
  );
  assert.deepEqual(creates, [autoName, "Uncertain", indexName]);
  assert.equal(sends.at(-1).start, "/g/g-p-auto-3/project");
  assert.equal(sends.at(-2).start, "/g/g-p-auto-3/project");
  const sendsBeforeIndexErrors = sends.length;
  assert.match(
    (await autoRun("index-duplicate", "Duplicate")).error,
    /多個同名/,
  );
  assert.match((await autoRun("index-partial", "Partial")).error, /部分相符/);
  searchMode = "missing-open-control";
  assert.match(
    (await autoRun("index-no-open", "Existing")).error,
    /新對話入口不可用/,
  );
  searchMode = "missing-control";
  const missingControl = await autoRun("index-no-search", "Existing");
  assert.match(missingControl.error, /專案搜尋欄位未就緒/);
  assert.equal(missingControl.diagnosticCode, "timeout");
  assert.equal(sends.length, sendsBeforeIndexErrors);
  assert.deepEqual(creates, [autoName, "Uncertain", indexName]);
  process.stdout.write(
    "Projects E2E passed: legacy and index layouts, native controlled input, delayed results/hydration, mappings, isolation, rebuild, reuse/create, concurrent deduplication, duplicates, partial matches, expired session, uncertain-create restart recovery, missing-control timeout diagnostics and zero-send failures.\n",
  );
} finally {
  await app
    ?.evaluate(async () => globalThis.projectController?.close())
    .catch(() => undefined);
  await app?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
