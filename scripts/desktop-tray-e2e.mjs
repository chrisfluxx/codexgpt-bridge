import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { _electron as electron } from "playwright-core";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");
const executable = process.argv
  .find((value) => value.startsWith("--executable="))
  ?.slice(13);
const directory = await mkdtemp(join(tmpdir(), "bridge-tray-"));
let application;

async function trayAction(action) {
  return application.evaluate(({ app, BrowserWindow }, action) => {
    const require = process
      .getBuiltinModule("module")
      .createRequire(`${app.getAppPath()}/package.json`);
    const {
      BridgeSystemTray,
    } = require("./apps/desktop/dist/main/system-tray.js");
    const systemTray = BridgeSystemTray.current;
    if (!systemTray || systemTray.tray.isDestroyed())
      throw new Error("Bridge tray is missing");
    if (action === "click") systemTray.tray.emit("click");
    else if (action === "double-click") systemTray.tray.emit("double-click");
    else if (action === "open") systemTray.menu.getMenuItemById("open").click();
    else if (action === "quit") systemTray.menu.getMenuItemById("quit").click();
    return {
      labels: systemTray.menu.items.map((item) => item.label),
      bounds: systemTray.tray.getBounds(),
      mainWindows: BrowserWindow.getAllWindows().filter(
        (window) => window.getTitle() === "CodexGPT Bridge",
      ).length,
    };
  }, action);
}

try {
  const codexHome = join(directory, "codex");
  await mkdir(codexHome);
  await writeFile(join(codexHome, "config.toml"), "");
  await writeFile(
    join(directory, "desktop-settings.json"),
    JSON.stringify({
      locale: "zh-TW",
      allowedRoots: [],
      permission: "read_only",
      backgroundRuntime: false,
    }),
  );
  application = await electron.launch({
    executablePath: executable ?? require("electron"),
    args: executable ? [] : [root],
    cwd: root,
    env: {
      ...process.env,
      CODEXGPT_BRIDGE_E2E_USER_DATA_DIR: directory,
      CODEX_HOME: codexHome,
      CODEXGPT_BRIDGE_E2E_STATE_DB: join(directory, "state.sqlite"),
      CODEXGPT_BRIDGE_E2E_NATIVE_MODELS_JSON: '{"models":[]}',
      CODEXGPT_BRIDGE_E2E_EXISTING_MODELS_JSON: '{"models":[]}',
    },
  });
  let page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const initial = await trayAction("inspect");
  assert.ok(initial.labels.includes("開啟主視窗"));
  assert.ok(initial.labels.includes("結束"));
  if (process.platform === "win32") {
    assert.ok(
      initial.bounds.width > 0 && initial.bounds.height > 0,
      "Windows did not register the tray icon",
    );
  }
  for (const [locale, open, quit] of [
    ["en", "Open main window", "Quit"],
    ["ja", "メインウィンドウを開く", "終了"],
    ["ko", "기본 창 열기", "종료"],
    ["zh-TW", "開啟主視窗", "結束"],
    ["zh-CN", "打开主窗口", "退出"],
  ]) {
    await page.evaluate(
      (locale) => globalThis.codexgptBridge.setLocale(locale),
      locale,
    );
    const state = await trayAction("inspect");
    assert.ok(state.labels.includes(open) && state.labels.includes(quit));
  }
  for (const action of ["click", "open", "double-click"]) {
    await page.close();
    assert.equal(
      application.process().exitCode,
      null,
      "Closing the main window stopped Bridge",
    );
    const reopened = application.waitForEvent("window");
    await trayAction(action);
    page = await reopened;
    await page.waitForLoadState("domcontentloaded");
    await trayAction("click");
    await trayAction("double-click");
    assert.equal(
      (await trayAction("inspect")).mainWindows,
      1,
      "Tray activation created duplicate windows",
    );
  }
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].minimize(),
  );
  await trayAction("open");
  assert.equal(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMinimized(),
    ),
    false,
  );
  assert.equal(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible(),
    ),
    true,
  );
  await page.close();
  const child = application.process();
  await trayAction("quit");
  for (let attempt = 0; child.exitCode === null && attempt < 100; attempt++)
    await setTimeout(100);
  assert.equal(child.exitCode, 0, "Tray Quit did not finish a clean shutdown");
  application = undefined;
  process.stdout.write(
    "Tray E2E passed: registered icon, five locales, close/reopen, restore, no duplicate windows, clean Quit\n",
  );
} finally {
  await application?.close().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
