import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron } from "playwright-core";

let authenticated = false;
let mainPageLoads = 0;
let nativeSessionRequests = 0;
let pageSessionRequests = 0;
const server = createServer((req, res) => {
  if (req.url === "/api/auth/session") {
    if (req.headers["sec-fetch-site"] !== "same-origin") {
      nativeSessionRequests += 1;
      res.writeHead(403, {
        "Content-Type": "text/html",
        "cf-mitigated": "challenge",
      });
      res.end("The separate native client was challenged");
      return;
    }
    pageSessionRequests += 1;
    res.statusCode = authenticated ? 200 : 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(authenticated ? { user: { id: "fixture" } } : {}));
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url === "/auth/provider" || req.url === "/auth/complete") {
    res.end(
      "<!doctype html><title>Owned authentication</title><p>Authentication provider</p>",
    );
    return;
  }
  if (req.url === "/") mainPageLoads += 1;
  res.end(
    authenticated
      ? '<!doctype html><title>ChatGPT fixture</title><main><div contenteditable="true"> </div></main>'
      : "<!doctype html><title>ChatGPT fixture</title><button id=login>Sign in</button>",
  );
});

const waitFor = async (read, predicate, label) => {
  const deadline = Date.now() + 10_000;
  let last;
  for (;;) {
    const value = await read();
    last = value;
    if (predicate(value)) return value;
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out waiting for ${label}: ${JSON.stringify(last)}`,
      );
    await delay(50);
  }
};

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
const directory = await mkdtemp(join(tmpdir(), "bridge-auth-popup-e2e-"));
const file = join(directory, "conversations.json");
let app;
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [fileURLToPath(new URL("./chatgpt-mode-host.mjs", import.meta.url))],
    env: { ...process.env, CODEXGPT_BRIDGE_DOM_TEST_PROFILE: directory },
  });
  await app.evaluate(
    async (_, { baseUrl, file }) => {
      globalThis.authController = new globalThis.ChatGptBrowserController(
        baseUrl,
        file,
      );
      await globalThis.authController.openLoginWindow();
    },
    { baseUrl, file },
  );
  const popupRequested = await app.evaluate(({ BrowserWindow }, baseUrl) => {
    const owner = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === baseUrl,
    );
    if (!owner) throw new Error("Login owner window is missing");
    return owner.webContents.executeJavaScript(
      `Boolean(window.open(${JSON.stringify(new URL("auth/provider", baseUrl).toString())}, "owned-auth"))`,
      true,
    );
  }, baseUrl);
  assert.equal(popupRequested, true);

  const ownership = await waitFor(
    () =>
      app.evaluate(async ({ BrowserWindow }, baseUrl) => {
        const windows = BrowserWindow.getAllWindows().filter(
          (window) => !window.isDestroyed() && window.webContents,
        );
        const owner = windows.find(
          (window) => window.webContents.getURL() === baseUrl,
        );
        const popup = windows.find((window) =>
          window.webContents.getURL().endsWith("/auth/provider"),
        );
        return {
          count: windows.length,
          parentOwned: popup?.getParentWindow() === owner,
          sharedSession:
            !!owner &&
            !!popup &&
            popup.webContents.session === owner.webContents.session,
          popupUrl: popup?.webContents.getURL() ?? "",
        };
      }, baseUrl),
    (value) => value.popupUrl.endsWith("/auth/provider"),
    "owned authentication popup",
  );
  assert.equal(ownership.parentOwned, true);
  assert.equal(ownership.sharedSession, true);

  await app.evaluate(({ BrowserWindow }) => {
    const popup = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes("/auth/provider"),
    );
    if (!popup) throw new Error("Authentication popup is missing");
    void popup.webContents.executeJavaScript(
      'window.open("https://example.com/", "unowned")',
      true,
    );
    void popup.webContents.executeJavaScript(
      'location.href = "https://example.com/blocked"',
      true,
    );
  });
  await delay(250);
  const constrained = await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows().filter(
      (window) => !window.isDestroyed() && window.webContents,
    );
    const popup = windows.find((window) =>
      window.webContents.getURL().includes("/auth/"),
    );
    return { count: windows.length, url: popup?.webContents.getURL() ?? "" };
  });
  assert.equal(constrained.count, ownership.count);
  assert.match(constrained.url, /\/auth\/provider$/);

  authenticated = true;
  await app.evaluate(({ BrowserWindow }, baseUrl) => {
    const popup = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes("/auth/"),
    );
    if (!popup) throw new Error("Authentication popup is missing");
    void popup.loadURL(new URL("auth/complete", baseUrl).toString());
  }, baseUrl);
  const completed = await waitFor(
    () =>
      app.evaluate(async ({ BrowserWindow }, baseUrl) => {
        const windows = BrowserWindow.getAllWindows().filter(
          (window) => !window.isDestroyed() && window.webContents,
        );
        const owner = windows.find(
          (window) => window.webContents.getURL() === baseUrl,
        );
        return {
          count: windows.length,
          ownerUrl: owner?.webContents.getURL() ?? "",
          ownerReady: owner
            ? await owner.webContents.executeJavaScript(
                'Boolean(document.querySelector("main [contenteditable=true]"))',
              )
            : false,
          authPopupCount: windows.filter((window) =>
            window.webContents.getURL().includes("/auth/"),
          ).length,
        };
      }, baseUrl),
    (value) =>
      value.count === ownership.count - 1 &&
      value.ownerUrl === baseUrl &&
      value.ownerReady &&
      value.authPopupCount === 0,
    "authentication completion and owner refresh",
  );
  assert.equal(completed.count, ownership.count - 1);

  const loadsBeforeReadyPopup = mainPageLoads;
  await app.evaluate(({ BrowserWindow }, baseUrl) => {
    const owner = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === baseUrl,
    );
    return owner.webContents.executeJavaScript(
      `Boolean(window.open(${JSON.stringify(new URL("auth/provider", baseUrl).toString())}, "ready-auth"))`,
      true,
    );
  }, baseUrl);
  await waitFor(
    () =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    (count) => count === completed.count,
    "already-ready owner preserved after popup completion",
  );
  await delay(250);
  assert.equal(mainPageLoads, loadsBeforeReadyPopup);

  const loadsBeforeChallengePopup = mainPageLoads;
  await app.evaluate(({ BrowserWindow }, baseUrl) => {
    const owner = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === baseUrl,
    );
    return owner.webContents.executeJavaScript(
      `document.title = '請稍候...';
       document.body.innerHTML = '<main><div id="challenge-running">Checking</div></main>';
       Boolean(window.open(${JSON.stringify(new URL("auth/provider", baseUrl).toString())}, "challenge-auth"))`,
      true,
    );
  }, baseUrl);
  await waitFor(
    () =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    (count) => count === completed.count,
    "challenge page preserved after popup completion",
  );
  await delay(250);
  assert.equal(mainPageLoads, loadsBeforeChallengePopup);
  assert.equal(nativeSessionRequests, 0);
  assert.ok(pageSessionRequests >= 3);

  await app.evaluate(async () => globalThis.authController.close());
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  );
  process.stdout.write(
    "Authentication popup E2E passed: owned parent, private session, constrained navigation, page session verification, no ready-page reload, and cleanup.\n",
  );
} finally {
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
