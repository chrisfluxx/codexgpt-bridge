/* global window */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron, chromium } from "playwright-core";

const directory = await mkdtemp(join(tmpdir(), "bridge-desktop-chrome-e2e-"));
const codexDirectory = join(directory, "codex");
await mkdir(codexDirectory);
let rejectSession = false;
let challengeRequired = true;
let pageLoads = 0;
let sessionProbes = 0;
let refreshedCookiesObserved = false;
const server = createServer((request, response) => {
  if (request.url === "/api/auth/session") {
    sessionProbes++;
    refreshedCookiesObserved ||= Boolean(
      request.headers.cookie?.includes("fixture_session_a=updated-a") &&
      request.headers.cookie?.includes("fixture_session_b=updated-b"),
    );
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Set-Cookie", [
      "fixture_session_a=updated-a; Path=/; HttpOnly; SameSite=Lax",
      "fixture_session_b=updated-b; Path=/; HttpOnly; SameSite=Lax",
    ]);
    response.end(
      JSON.stringify(
        !rejectSession &&
          request.headers.cookie?.includes("fixture_login=retained")
          ? { user: { id: "desktop-chrome-fixture" } }
          : {},
      ),
    );
  } else {
    if (request.url !== "/favicon.ico") pageLoads++;
    response.setHeader("Content-Type", "text/html");
    if (!request.headers.cookie?.includes("fixture_login=retained"))
      response.setHeader(
        "Set-Cookie",
        "fixture_login=retained; Path=/; Max-Age=3600; SameSite=Lax",
      );
    response.end(
      `<!doctype html><title>Bridge Chrome fixture</title><main><div id="prompt-textarea" contenteditable="true"> </div></main><script>
      if(navigator.webdriver && ${challengeRequired}) {
        document.title = 'Just a moment...';
        document.body.innerHTML = '<main id="challenge-running">Local verification fixture</main>';
      } else if(!navigator.webdriver)setTimeout(()=>window.close(),2500);
      </script>`,
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
const executable = process.argv
  .find((value) => value.startsWith("--executable="))
  ?.slice("--executable=".length);
let app;
let observer;
const launchApp = () =>
  electron.launch({
    executablePath: executable ?? createRequire(import.meta.url)("electron"),
    args: executable
      ? []
      : [
          fileURLToPath(
            new URL("../apps/desktop/dist/main/main.js", import.meta.url),
          ),
        ],
    env: {
      ...process.env,
      CODEX_HOME: codexDirectory,
      CODEXGPT_BRIDGE_E2E_USER_DATA_DIR: directory,
      CODEXGPT_BRIDGE_E2E_CHATGPT_URL: baseUrl,
    },
  });
try {
  app = await launchApp();
  let page = await app.firstWindow();
  const waitForBrowser = async (host) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const state = await page.evaluate(async () => ({
        settings: await window.codexgptBridge.getSettings(),
        provider: await window.codexgptBridge.getWebProviderStatus(),
      }));
      if (
        state.settings.chatGptBrowserHost === host &&
        state.provider.browserSignedIn === true
      )
        return;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    }
    throw new Error(`The ${host} browser did not become ready.`);
  };
  await page.locator("#chatgpt-browser-host").waitFor();
  await page.locator("#chatgpt-browser-host").selectOption("chrome");
  await page.locator('[data-testid="chrome-login-instructions"]').waitFor();
  assert.equal(
    (await page.evaluate(() => window.codexgptBridge.getWebProviderStatus()))
      .browserSignedIn,
    false,
  );
  assert.equal(
    await page.locator('[data-testid="browser-smoke"]').isDisabled(),
    true,
  );
  await assert.rejects(
    page.evaluate(() => window.codexgptBridge.runBrowserSmoke()),
    /Complete and verify Chrome login/u,
  );
  const continuedAt = Date.now();
  await page
    .locator('[data-testid="chrome-login-continue"]')
    .click({ timeout: 20_000 });
  const challengeDeadline = Date.now() + 10_000;
  while (
    (await page.evaluate(() => window.codexgptBridge.getWebProviderStatus()))
      .chromeLogin.phase !== "challenge"
  ) {
    assert.ok(
      Date.now() < challengeDeadline,
      "verification must pause promptly",
    );
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  }
  assert.ok(
    Date.now() - continuedAt < 10_000,
    "verification must pause promptly",
  );
  const profile = join(directory, "chrome-chatgpt-profile");
  const port = Number(
    (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
      /\r?\n/u,
    )[0],
  );
  // This CDP connection is confined to the test's own localhost fixture profile.
  observer = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = observer.contexts()[0];
  assert.equal(context.pages().length, 1);
  const fixturePage = context.pages()[0];
  const pausedLoads = pageLoads;
  const pausedProbes = sessionProbes;
  for (let attempt = 0; attempt < 3; attempt++) {
    const paused = await page.evaluate(() =>
      window.codexgptBridge.continueChromeLogin(),
    );
    assert.equal(paused.chromeLogin.phase, "challenge");
    assert.equal(paused.chromeLogin.verified, false);
    assert.equal(paused.browserSignedIn, false);
    await page.evaluate(() => window.codexgptBridge.openChatGptLogin());
    await assert.rejects(
      page.evaluate(() => window.codexgptBridge.runBrowserSmoke()),
      /Complete and verify Chrome login/u,
    );
    assert.equal(context.pages().length, 1);
    assert.equal(context.pages()[0], fixturePage);
  }
  assert.equal(
    pageLoads,
    pausedLoads,
    "Continue and Show must not reload verification",
  );
  assert.equal(
    sessionProbes,
    pausedProbes,
    "paused verification must not probe the account",
  );
  // Simulate completion only on the local fixture. No real CAPTCHA is operated.
  challengeRequired = false;
  await fixturePage.reload();
  const verified = await page.evaluate(() =>
    window.codexgptBridge.continueChromeLogin(),
  );
  assert.equal(verified.chromeLogin.verified, true);
  assert.equal(verified.chromeLogin.phase, "idle");
  assert.equal(context.pages().length, 1);
  await waitForBrowser("chrome");
  await page.evaluate(() => window.codexgptBridge.refreshChatGptUsage());
  assert.equal(
    refreshedCookiesObserved,
    true,
    "multiple session cookie updates must remain in the browser cookie jar",
  );
  await observer.close();
  observer = undefined;
  const probesBeforeRestart = sessionProbes;
  await app.evaluate(({ app }) => app.quit());
  await app.close();
  app = await launchApp();
  page = await app.firstWindow();
  await waitForBrowser("chrome");
  const restored = await page.evaluate(() =>
    window.codexgptBridge.getWebProviderStatus(),
  );
  assert.equal(restored.chromeLogin.verified, true);
  assert.equal(restored.chromeLogin.phase, "idle");
  assert.ok(
    sessionProbes > probesBeforeRestart,
    "restart must recheck the server session",
  );
  const settings = JSON.parse(
    await readFile(join(directory, "desktop-settings.json"), "utf8"),
  );
  assert.equal(settings.chatGptBrowserHost, "chrome");
  await page.locator("#chatgpt-browser-host").selectOption("embedded");
  await waitForBrowser("embedded");
  assert.equal(
    (await page.evaluate(() => window.codexgptBridge.getSettings()))
      .chatGptBrowserHost,
    "embedded",
  );
  rejectSession = true;
  await page.locator("#chatgpt-browser-host").selectOption("chrome");
  await page
    .locator('[data-testid="chrome-login-continue"]')
    .click({ timeout: 20_000 });
  await page
    .locator("footer")
    .filter({ hasText: /server session (?:has expired|is not authenticated)/u })
    .waitFor({ timeout: 20_000 });
  const rejected = await page.evaluate(() =>
    window.codexgptBridge.getWebProviderStatus(),
  );
  assert.equal(rejected.browserSignedIn, false);
  assert.equal(rejected.browserWindowOpen, false);
  assert.equal(rejected.chromeLogin.phase, "idle");
  const probesBeforeExpiredRestart = sessionProbes;
  await app.evaluate(({ app }) => app.quit());
  await app.close();
  app = await launchApp();
  page = await app.firstWindow();
  const expired = await page.evaluate(() =>
    window.codexgptBridge.getWebProviderStatus(),
  );
  assert.ok(sessionProbes > probesBeforeExpiredRestart);
  assert.equal(expired.chromeLogin.verified, false);
  assert.equal(expired.browserSignedIn, false);
  assert.equal(expired.browserWindowOpen, false);
  process.stdout.write(
    "Desktop Chrome E2E passed: verification pauses in one tab, testing is gated, same-tab completion proves the server session, multiple session cookies survive response conversion, restart verifies a saved session, and expired sessions fail despite a visible composer.\n",
  );
} catch (error) {
  if (app) {
    const diagnosticPage = app.windows()[0];
    const status = await diagnosticPage.evaluate(() =>
      window.codexgptBridge.getWebProviderStatus(),
    );
    process.stderr.write(
      JSON.stringify({
        chromeLogin: status.chromeLogin,
        footer: await diagnosticPage.locator("footer").innerText(),
        pageLoads,
        sessionProbes,
      }) + "\n",
    );
  }
  throw error;
} finally {
  await observer?.close().catch(() => undefined);
  await app?.evaluate(({ app }) => app.quit()).catch(() => undefined);
  await app?.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 30,
    retryDelay: 100,
  });
}
