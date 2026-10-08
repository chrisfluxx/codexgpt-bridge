import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron } from "playwright-core";

const chats = new Map();
const renames = [];
const sends = [];
let behavior = "normal";
let locale = "zh-TW";
function fixture(path) {
  const id = path.match(/\/c\/([^/]+)$/)?.[1];
  return `<!doctype html><nav></nav><main>
    <button data-testid="model-switcher-dropdown-button" aria-haspopup="menu">High</button>
    <div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button><div id="messages"></div>
    </main><script>
    let chat=${JSON.stringify(id ? { id, title: chats.get(id) } : null)};
    const mode=${JSON.stringify(behavior)}, locale=${JSON.stringify(locale)};
    let composer=document.querySelector('#prompt-textarea');const messages=document.querySelector('#messages');
    composer.onkeydown=(event)=>{if(mode==='empty-reset'&&event.ctrlKey&&event.key.toLowerCase()==='a'&&!composer.textContent)composer.remove();};
    let unsafeKeys=0;
    if(mode.startsWith('retained-')){
      composer.innerHTML='<span contenteditable="false" data-id="plugin:fixture" data-keyword="Fixture App">Fixture App</span> ';
      if(mode==='retained-duplicate')composer.append(composer.firstChild.cloneNode(true));
      if(mode==='retained-draft')composer.append('old draft');
      composer.onkeydown=(event)=>{if(event.key==='Backspace'||(event.ctrlKey&&event.key.toLowerCase()==='a')){unsafeKeys++;event.preventDefault();}};
    }
    if(mode.startsWith('remount-')){
      composer.innerHTML='<span data-id="plugin:fixture" data-keyword="Fixture App">Fixture App</span>';
      document.addEventListener('keydown',event=>{if(!composer.isConnected&&(event.key==='Backspace'||(event.ctrlKey&&event.key.toLowerCase()==='a')))unsafeKeys++;},true);
      composer.onkeydown=(event)=>{
        const trigger=mode==='remount-select'?(event.ctrlKey&&event.key.toLowerCase()==='a'):event.key==='Backspace';
        if(!trigger||!event.isTrusted)return;event.preventDefault();composer.remove();
        setTimeout(()=>{composer=document.createElement('div');composer.id='prompt-textarea';composer.contentEditable='true';composer.innerHTML='<br>';document.querySelector('main').insertBefore(composer,document.querySelector('[data-testid="send-button"]'));},3500);
      };
    }
    messages.innerHTML=localStorage.getItem(location.pathname)||'';
    function sidebar(){
      const nav=document.querySelector('nav');nav.replaceChildren();
      const decoy=document.createElement('a');decoy.setAttribute('data-sidebar-item','true');decoy.href='/c/unrelated';
      decoy.innerHTML='<span data-marquee-text>Automatic title</span><button data-conversation-options-trigger="unrelated">Options</button>';nav.append(decoy);
      if(!chat)return;
      const modern=mode.startsWith('modern');
      const link=document.createElement('a');link.setAttribute(modern?'data-interactive-row-link':'data-sidebar-item','true');link.href='/c/'+chat.id;
      const label=document.createElement('span');label.setAttribute('data-marquee-text','true');label.textContent=chat.title;
      const trigger=document.createElement('button');trigger.id='options-'+chat.id;if(!modern)trigger.setAttribute('data-conversation-options-trigger',chat.id);trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-label',locale==='zh-TW'?'對話動作':'Chat actions');trigger.textContent='Options';
      trigger.onclick=(event)=>{event.preventDefault();
        const menu=document.createElement('div');menu.setAttribute('role','menu');menu.setAttribute('aria-labelledby',trigger.id);
        const item=document.createElement('div');item.setAttribute('role','menuitem');item.textContent=mode==='missing-menu'?'Other action':locale==='zh-TW'?'重新命名':'Rename';menu.append(item);document.body.append(menu);
        item.onclick=()=>{if(mode==='missing-menu')return;menu.remove();
          const row=document.createElement('div');
          if(modern){row.setAttribute('role','dialog');row.setAttribute('aria-modal','true');const heading=document.createElement('h2');heading.id='rename-heading';heading.textContent=locale==='zh-TW'?'重新命名對話':'Rename chat';row.setAttribute('aria-labelledby',heading.id);row.append(heading);document.body.append(row);}else{row.setAttribute('data-sidebar-item','true');link.replaceWith(row);}
          const form=modern?document.createElement('form'):row;if(modern)row.append(form);
          const input=document.createElement('input');if(modern)input.setAttribute('aria-label',locale==='zh-TW'?'對話標題':'Chat title');else input.name='title-editor';input.maxLength=128;input.value=chat.title;input.setAttribute('value',chat.title);form.append(input);input.focus();input.select();
          input.oninput=(event)=>{if(!event.isTrusted)return;if(mode==='delayed-clear'&&!input.value){setTimeout(()=>input.setAttribute('value',''),150);return;}input.setAttribute('value',input.value);if(mode==='lost-focus'||mode==='modern-lost-focus')composer.focus();};
          const save=async(event)=>{
            event.preventDefault();
            const response=await fetch('/rename',{method:'POST',body:JSON.stringify({id:chat.id,title:input.value})});
            if(!response.ok){const alert=document.createElement('div');alert.setAttribute('role','alert');alert.textContent='Rename failed';document.body.append(alert);sidebar();return;}
            chat.title=input.value;row.remove();sidebar();
          };
          input.onkeydown=(event)=>{
            if(event.key==='Escape'){event.preventDefault();row.remove();sidebar();return;}
            if(!modern&&event.key==='Enter'&&event.isTrusted)void save(event);
          };
          if(modern){const cancel=document.createElement('button');cancel.type='button';cancel.textContent=locale==='zh-TW'?'取消':'Cancel';form.append(cancel);const submit=document.createElement('button');submit.type='submit';submit.textContent=locale==='zh-TW'?'儲存':'Save';form.append(submit);form.onsubmit=save;if(mode==='modern-ambiguous-save')form.append(submit.cloneNode(true));if(mode==='modern-disabled-save'){submit.disabled=true;setTimeout(()=>submit.disabled=false,500);}}
        };
      };
      // Radix opens its dropdown on keydown, not a synthetic DOM click.
      trigger.onkeydown=(event)=>{if(event.key==='Enter'&&event.isTrusted){event.preventDefault();trigger.click();}};
      if(modern){const row=document.createElement('div');row.setAttribute('role','group');row.setAttribute('aria-current','page');link.append(label);row.append(link,trigger);nav.append(row);if(mode==='modern-duplicate'){const duplicate=row.cloneNode(true);duplicate.removeAttribute('aria-current');duplicate.querySelector('button').remove();nav.append(duplicate);}}else{link.append(label,trigger);nav.append(link);}
    }sidebar();
    if(mode==='collapsed'){
      const nav=document.querySelector('nav');nav.style.display='none';
      const toggle=document.createElement('button');toggle.setAttribute('aria-controls','stage-slideover-sidebar');toggle.setAttribute('aria-expanded','false');toggle.textContent='Open sidebar';
      toggle.onclick=()=>{nav.style.display='';toggle.setAttribute('aria-expanded','true');};document.body.append(toggle);
    }
    document.querySelector('[data-testid="send-button"]').onclick=async()=>{
      if(!chat){chat={id:crypto.randomUUID(),title:'Automatic title'};history.replaceState({},'','/c/'+chat.id);sidebar();}
      await fetch('/sent',{method:'POST',body:JSON.stringify({...chat,unsafeKeys})});
      const user=document.createElement('div');user.setAttribute('data-message-author-role','user');user.textContent=composer.textContent;composer.textContent='';
      const reply=document.createElement('div');reply.setAttribute('data-testid','conversation-turn-'+crypto.randomUUID());reply.innerHTML='<div data-message-author-role="assistant">TITLE_OK</div><button data-testid="copy-turn-button">Copy</button>';
      messages.append(user,reply);localStorage.setItem(location.pathname,messages.innerHTML);
    };
    </script>`;
}
const server = createServer(async (request, response) => {
  if (request.url === "/api/auth/session") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ user: { id: "title-fixture" } }));
    return;
  }
  if (request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const value = JSON.parse(body);
    if (request.url === "/sent") {
      assert.equal(
        value.unsafeKeys,
        0,
        "never delete into an unmounted editor",
      );
      sends.push(value.id);
      if (!chats.has(value.id)) chats.set(value.id, value.title);
    }
    if (request.url === "/rename") {
      if (behavior === "reject" || behavior === "modern-reject") {
        response.writeHead(500);
        response.end();
        return;
      }
      if (behavior === "modern-slow-save")
        await new Promise((resolve) => globalThis.setTimeout(resolve, 9_000));
      renames.push(value);
      chats.set(value.id, value.title);
    }
    response.end("OK");
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(fixture(request.url));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
const directory = await mkdtemp(join(tmpdir(), "bridge-title-e2e-"));
let app;
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [fileURLToPath(new URL("./chatgpt-mode-host.mjs", import.meta.url))],
    env: { ...process.env, CODEXGPT_BRIDGE_DOM_TEST_PROFILE: directory },
  });
  const setup = () =>
    app.evaluate(
      async (_electron, config) => {
        globalThis.titles ??= {};
        globalThis.titleController = new globalThis.ChatGptBrowserController(
          config.baseUrl,
          config.file,
          undefined,
          undefined,
          async (id) => globalThis.titles[id],
        );
      },
      { baseUrl, file: join(directory, "conversations.json") },
    );
  await setup();
  let turn = 0;
  let preSubmitFailures = 0;
  const run = (id, title, full = false, connector = "Fixture App") =>
    app.evaluate(
      async (_electron, input) => {
        globalThis.titles[input.id] = input.title;
        const result = await globalThis.titleController.runTurn({
          threadId: input.id,
          turnId: input.turn,
          prompt: "title fixture",
          mode: "high",
          ...(input.full
            ? { allowWebNativeTools: true, connectorName: input.connector }
            : {}),
          images: [],
          signal: globalThis.AbortSignal.timeout(25000),
        });
        return {
          result,
          warning: globalThis.titleController
            .tasks()
            .find((t) => t.threadId === input.id)?.titleSyncWarning,
        };
      },
      { id, title, full, connector, turn: "turn-" + ++turn },
    );
  const restart = async () => {
    await app.evaluate(async () => globalThis.titleController.close());
    await setup();
  };
  for (const language of ["zh-TW", "en"]) {
    behavior = "modern";
    locale = language;
    assert.deepEqual(
      await run("task-modern-" + language, "新版同步 " + language),
      { result: "TITLE_OK", warning: undefined },
    );
    assert.equal(
      chats.get(sends.at(-1)),
      "新版同步 " + language,
      "new sidebar and rename dialog sync the exact chat",
    );
  }
  locale = "zh-TW";
  for (const mode of ["modern-disabled-save", "modern-slow-save"]) {
    behavior = mode;
    assert.deepEqual(await run("task-" + mode, "保存確認 " + mode), {
      result: "TITLE_OK",
      warning: undefined,
    });
    assert.equal(chats.get(sends.at(-1)), "保存確認 " + mode);
  }
  behavior = "modern-ambiguous-save";
  const beforeAmbiguous = renames.length;
  const ambiguous = await run("task-ambiguous-save", "Do not save");
  assert.equal(ambiguous.result, "TITLE_OK");
  assert.match(ambiguous.warning, /儲存按鈕不明確/);
  assert.equal(renames.length, beforeAmbiguous);
  assert.equal(chats.get(sends.at(-1)), "Automatic title");
  behavior = "modern-reject";
  const rejectedForm = await run("task-form-reject", "Rejected form");
  assert.equal(rejectedForm.result, "TITLE_OK");
  assert.match(rejectedForm.warning, /名稱同步未完成/);
  assert.equal(chats.get(sends.at(-1)), "Automatic title");
  behavior = "modern-duplicate";
  assert.deepEqual(
    await run("task-modern-duplicate", "Project 和最近項目的相同對話"),
    { result: "TITLE_OK", warning: undefined },
  );
  assert.equal(chats.get(sends.at(-1)), "Project 和最近項目的相同對話");
  behavior = "modern-lost-focus";
  const modernRenames = renames.length;
  const modernLostFocus = await run(
    "task-modern-lost-focus",
    "Do not type into composer",
  );
  assert.equal(modernLostFocus.result, "TITLE_OK");
  assert.match(modernLostFocus.warning, /焦點/);
  assert.equal(
    renames.length,
    modernRenames,
    "modern dialog focus loss never submits a rename",
  );
  behavior = "retained-connector";
  assert.deepEqual(await run("task-retained", "Retained Full MCP App", true), {
    result: "TITLE_OK",
    warning: undefined,
  });
  for (const [mode, full, connector] of [
    ["retained-connector", false, "Fixture App"],
    ["retained-connector", true, "Different App"],
    ["retained-duplicate", true, "Fixture App"],
    ["retained-draft", true, "Fixture App"],
  ]) {
    behavior = mode;
    const before = sends.length;
    await assert.rejects(
      run("task-guard-" + preSubmitFailures, "Do not send", full, connector),
      /No prompt was submitted/,
    );
    preSubmitFailures++;
    assert.equal(sends.length, before);
  }
  behavior = "normal";
  assert.deepEqual(await run("task-alpha", "Test"), {
    result: "TITLE_OK",
    warning: undefined,
  });
  const firstId = sends.at(-1);
  assert.equal(chats.get(firstId), "Test");
  assert.deepEqual(await run("task-beta", "Test"), {
    result: "TITLE_OK",
    warning: undefined,
  });
  const secondId = sends.at(-1);
  assert.notEqual(firstId, secondId);
  const count = renames.length;
  assert.deepEqual(await run("task-alpha", "Test"), {
    result: "TITLE_OK",
    warning: undefined,
  });
  assert.equal(renames.length, count, "same title is not repeatedly saved");
  const renamed = '手動改名 "引號" <tag> & 🚀';
  assert.deepEqual(await run("task-alpha", renamed), {
    result: "TITLE_OK",
    warning: undefined,
  });
  assert.equal(sends.at(-1), firstId);
  assert.equal(chats.get(firstId), renamed);
  assert.equal(chats.get(secondId), "Test");
  await restart();
  locale = "en";
  assert.deepEqual(await run("task-alpha", "After restart"), {
    result: "TITLE_OK",
    warning: undefined,
  });
  assert.equal(sends.at(-1), firstId);
  assert.equal(chats.get(firstId), "After restart");
  behavior = "missing-menu";
  const missing = await run("task-missing", "No save");
  assert.equal(missing.result, "TITLE_OK");
  assert.match(missing.warning, /名稱同步未完成/);
  const missingId = sends.at(-1);
  assert.equal(chats.get(missingId), "Automatic title");
  behavior = "normal";
  await restart();
  assert.deepEqual(await run("task-missing", "Retry title"), {
    result: "TITLE_OK",
    warning: undefined,
  });
  assert.equal(chats.get(missingId), "Retry title");
  behavior = "lost-focus";
  const focus = await run("task-focus", "Do not send");
  assert.equal(focus.result, "TITLE_OK");
  assert.match(focus.warning, /焦點/);
  assert.equal(chats.get(sends.at(-1)), "Automatic title");
  behavior = "reject";
  const rejected = await run("task-reject", "Rejected");
  assert.equal(rejected.result, "TITLE_OK");
  assert.match(rejected.warning, /名稱同步未完成/);
  behavior = "collapsed";
  assert.deepEqual(await run("task-collapsed", "Collapsed sidebar"), {
    result: "TITLE_OK",
    warning: undefined,
  });
  assert.equal(chats.get(sends.at(-1)), "Collapsed sidebar");
  behavior = "empty-reset";
  assert.deepEqual(await run("task-empty", "Empty retained composer"), {
    result: "TITLE_OK",
    warning: undefined,
  });
  for (const remount of ["remount-select", "remount-delete"]) {
    behavior = remount;
    assert.deepEqual(await run("task-" + remount, "Remounted editor"), {
      result: "TITLE_OK",
      warning: undefined,
    });
  }
  behavior = "normal";
  const long = await run("task-long", "x".repeat(129));
  assert.equal(long.result, "TITLE_OK");
  assert.match(long.warning, /128/);
  behavior = "delayed-clear";
  assert.deepEqual(await run("task-clear", "Acknowledged clear"), {
    result: "TITLE_OK",
    warning: undefined,
  });
  assert.equal(
    sends.length,
    turn - preSubmitFailures,
    "rename failures never resubmit the prompt",
  );
  assert.equal(
    chats.has("unrelated"),
    false,
    "duplicate display text never targets another chat",
  );
  process.stdout.write(
    "Title E2E passed: native form Save in Chinese/English, delayed/disabled/ambiguous/rejected Save, exact chat ID, Codex rename, unchanged title, restart, failure/retry, focus/length guards, collapsed sidebar, editor remount, exact Full MCP reuse, four reuse rejection guards, acknowledged clear and no duplicate sends.\n",
  );
} catch (error) {
  const last = app?.windows().at(-1);
  if (last)
    process.stderr.write(
      await last
        .locator("#prompt-textarea")
        .evaluate((el) => el.outerHTML)
        .catch(() => "fixture editor unavailable"),
    );
  throw error;
} finally {
  await app
    ?.evaluate(async () => globalThis.titleController?.close())
    .catch(() => undefined);
  await app?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
