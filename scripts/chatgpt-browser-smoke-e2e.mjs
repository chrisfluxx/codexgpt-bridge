import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron } from "playwright-core";

const page = `<!doctype html><style>
  button, #prompt-textarea { width: 240px; min-height: 36px; }
</style><header><button aria-label="Turn off temporary chat">Temporary</button></header>
<main>
  <button data-testid="model-switcher-dropdown-button" aria-haspopup="menu">High</button>
  <div id="prompt-textarea" data-testid="prompt-textarea" contenteditable="true"> </div>
  <button data-testid="send-button">Send</button><div id="messages"></div>
</main><script>
  const picker = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
  const prompt = document.querySelector('#prompt-textarea');
  let selected = 'High';
  window.sends = 0;
  picker.onclick = () => {
    const existing = document.querySelector('[role="menu"]');
    if (existing) { existing.remove(); return; }
    const menu = document.createElement('div');
    menu.role = 'menu';
    menu.innerHTML = '<button role="menuitemradio">GPT-5</button><button role="menuitem" id="effort"><span role="slider" aria-valuemin="0" aria-valuemax="3" aria-valuenow="2">High</span></button>';
    const slider = menu.querySelector('[role="slider"]');
    menu.querySelector('#effort').onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      const value = Math.max(0, Math.min(3, Number(slider.getAttribute('aria-valuenow')) + (event.key === 'ArrowRight' ? 1 : -1)));
      const labels = ['Instant', 'Medium', 'High', 'Extra High'];
      slider.setAttribute('aria-valuenow', value);
      selected = picker.textContent = slider.textContent = labels[value];
    };
    document.body.append(menu);
  };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') document.querySelector('[role="menu"]')?.remove();
  });
  document.querySelector('[data-testid="send-button"]').onclick = () => {
    window.sends++;
    const user = document.createElement('div');
    user.setAttribute('data-message-author-role', 'user');
    user.textContent = prompt.textContent;
    prompt.textContent = '';
    const reply = document.createElement('div');
    reply.setAttribute('data-testid', 'conversation-turn-' + window.sends);
    reply.innerHTML = '<div data-message-author-role="assistant">CODEX WEB GPT READY</div><button data-testid="copy-turn-button">Copy</button>';
    document.querySelector('#messages').append(user, reply);
  };
</script>`;

const server = createServer((request, response) => {
  if (request.url === "/api/auth/session") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ user: { id: "smoke-fixture" } }));
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(page);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
const directory = await mkdtemp(join(tmpdir(), "bridge-browser-smoke-e2e-"));
let app;
const useChrome = process.argv.includes("--chrome");
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [fileURLToPath(new URL("./chatgpt-mode-host.mjs", import.meta.url))],
    env: { ...process.env, CODEXGPT_BRIDGE_DOM_TEST_PROFILE: directory },
  });
  const completed = await app.evaluate(
    async (_electron, fixture) => {
      let windowsCreated = 0;
      const host = fixture.chrome
        ? new globalThis.ChromeChatGptHost(fixture.profile)
        : undefined;
      const controller = new globalThis.ChatGptBrowserController(
        fixture.baseUrl,
        fixture.conversationFile,
        undefined,
        undefined,
        undefined,
        undefined,
        host
          ? async (options, purpose) => {
              windowsCreated++;
              return host.createWindow(options, purpose);
            }
          : undefined,
      );
      try {
        const result = await controller.smokeTest();
        return { result, windowsCreated };
      } finally {
        await controller.close();
        await host?.close();
      }
    },
    {
      baseUrl,
      conversationFile: join(directory, "conversations.json"),
      profile: join(directory, "chrome"),
      chrome: useChrome,
    },
  );
  const { result } = completed;
  if (useChrome)
    assert.equal(
      completed.windowsCreated,
      1,
      "capability probe and test prompt must use the same tab",
    );
  assert.equal(result.ok, true);
  assert.equal(result.mode, "high");
  assert.equal(result.response, "CODEX WEB GPT READY");
  assert.deepEqual(
    result.checks.map((check) => check.id),
    [
      "private-session",
      "composer",
      "model-surface",
      "temporary-chat",
      "round-trip",
    ],
  );
  process.stdout.write(
    `Browser smoke E2E passed (${useChrome ? "Chrome, one reused tab" : "embedded"}): private session, model surface, Temporary Chat and exact response.\n`,
  );
} finally {
  await app?.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 30,
    retryDelay: 100,
  });
}
