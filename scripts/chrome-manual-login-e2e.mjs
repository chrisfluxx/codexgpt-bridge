import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import process from "node:process";
import { chromium } from "playwright-core";
import { ChromeChatGptHost } from "../apps/desktop/dist/main/chrome-chatgpt-window.js";

// All browser activity in this test is an owned localhost fixture. No real
// account, Google page, Cloudflare challenge or authentication form is used.
const directory = await mkdtemp(join(tmpdir(), "bridge-manual-login-e2e-"));
let manualLoads = 0;
let controlledLoads = 0;
const server = createServer((request, response) => {
  if (request.url === "/manual-ready") {
    manualLoads++;
    response.end("ok");
  } else if (request.url === "/controlled-ready") {
    controlledLoads++;
    response.end("ok");
  } else {
    response.setHeader("Content-Type", "text/html");
    if (!manualLoads)
      response.setHeader("Set-Cookie", [
        "fixture_persistent=retained; Path=/; Max-Age=3600; SameSite=Lax",
      ]);
    response.end(`<!doctype html><title>Bridge manual login fixture</title>
      <main><div id="prompt-textarea" contenteditable="true"> </div></main>
      <script>
        if (navigator.webdriver) fetch('/controlled-ready');
        else fetch('/manual-ready').then(() => setTimeout(() => window.close(), 2500));
      </script>`);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const host = new ChromeChatGptHost(directory, undefined, true);
let observer;
let restartedHost;
const poll = async (check, label, timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out.`);
};
try {
  assert.equal(await host.restoreSavedLogin(), false);
  await assert.rejects(
    host.createWindow({ show: true }),
    /Verify Chrome login/u,
  );
  await assert.rejects(
    host.createWindow({ show: true }, "login"),
    /Complete Chrome login/u,
  );
  const opening = host.beginManualLogin(url);
  assert.equal(await host.restoreSavedLogin(), false);
  await assert.rejects(
    host.createWindow({ show: true }, "login"),
    /sign-in is waiting/u,
  );
  await opening;
  await poll(() => manualLoads > 0, "ordinary Chrome fixture");
  assert.equal(host.manualLoginStatus().phase, "waiting");
  assert.equal(controlledLoads, 0);
  await assert.rejects(readFile(join(directory, "DevToolsActivePort")), {
    code: "ENOENT",
  });
  await assert.rejects(
    host.createWindow({ show: true }, "login"),
    /sign-in is waiting/u,
  );
  assert.throws(() => host.finishManualLogin(), /close the dedicated Chrome/u);
  await host.beginManualLogin(url);
  assert.equal(manualLoads, 1, "reopening login must not spawn another Chrome");
  await poll(
    () => host.manualLoginStatus().phase === "ready",
    "normal Chrome close",
  );
  await assert.rejects(
    host.createWindow({ show: true }, "login"),
    /sign-in is waiting/u,
  );
  host.finishManualLogin();
  await assert.rejects(
    host.createWindow({ show: true }),
    /Verify Chrome login/u,
  );
  const window = await host.createWindow({ show: true }, "login");
  await window.loadURL(url);
  const cookies = await window.webContents.executeJavaScript("document.cookie");
  assert.match(cookies, /fixture_persistent=retained/u);
  assert.ok(controlledLoads > 0);
  assert.equal(host.manualLoginStatus().phase, "idle");
  assert.equal(host.manualLoginStatus().verified, false);
  host.confirmVerifiedLogin();
  assert.equal(host.manualLoginStatus().verified, true);
  const endpoint = async () =>
    `http://127.0.0.1:${Number((await readFile(join(directory, "DevToolsActivePort"), "utf8")).split(/\r?\n/u)[0])}`;
  observer = await chromium.connectOverCDP(await endpoint());
  const context = observer.contexts()[0];
  assert.equal(context.pages().length, 1, "Chrome must not restore old tabs");
  for (const path of ["stale-one", "stale-two"]) {
    const stale = await context.newPage();
    await stale.goto(new URL(path, url).href);
  }
  assert.equal(context.pages().length, 3);
  await host.close();
  assert.equal(host.manualLoginStatus().verified, false);
  await observer.close();
  observer = undefined;
  // Neither the ordinary login nor controlled reopening may resurrect old tabs.
  restartedHost = new ChromeChatGptHost(directory, undefined, true);
  assert.equal(await restartedHost.restoreSavedLogin(), true);
  assert.equal(restartedHost.manualLoginStatus().verified, false);
  await assert.rejects(
    restartedHost.createWindow({ show: false }),
    /Verify Chrome login/u,
  );
  const restoredWindow = await restartedHost.createWindow(
    { show: false },
    "login",
  );
  await restoredWindow.loadURL(url);
  assert.match(
    await restoredWindow.webContents.executeJavaScript("document.cookie"),
    /fixture_persistent=retained/u,
  );
  await restartedHost.close();
  const manualLoadsBeforeRestart = manualLoads;
  await restartedHost.beginManualLogin(url);
  await poll(
    () => restartedHost.manualLoginStatus().phase === "ready",
    "ordinary Chrome restart",
  );
  assert.equal(
    manualLoads,
    manualLoadsBeforeRestart + 1,
    "ordinary login must not restore stale tabs",
  );
  restartedHost.finishManualLogin();
  const restartedWindow = await restartedHost.createWindow(
    { show: true },
    "login",
  );
  await restartedWindow.loadURL(url);
  observer = await chromium.connectOverCDP(await endpoint());
  assert.equal(observer.contexts()[0].pages().length, 1);
  assert.match(
    await restartedWindow.webContents.executeJavaScript("document.cookie"),
    /fixture_persistent=retained/u,
  );
  process.stdout.write(
    "Manual Chrome login E2E passed: no driver during login, startup and test guards, explicit Continue and verification required, persistent cookie retained, only one tab after restarting a profile containing three tabs.\n",
  );
} catch (error) {
  process.stderr.write(
    `${error.stack}\nLogin fixture state: ${JSON.stringify({ status: host.manualLoginStatus(), manualLoads, controlledLoads })}\n`,
  );
  throw error;
} finally {
  await host.close();
  await restartedHost?.close();
  await observer?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 30,
    retryDelay: 100,
  });
}
