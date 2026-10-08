import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { _electron as electron } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const executable = process.argv
  .find((value) => value.startsWith("--executable="))
  ?.slice(13);
const directory = await mkdtemp(join(tmpdir(), "bridge-update-reminder-e2e-"));
const profile = join(directory, "profile");
const release = join(directory, "release");
const manifestPath = join(release, "release-manifest.json");
const receiptPath = join(profile, "update-notifications.json");
const version = "99.0.0-test";
const bytes = Buffer.from(
  "Isolated fixture installer; this file must never be executed.",
);
let application;

async function writeManifest(nextVersion) {
  const file = `CodexGPT-Bridge-Setup-${nextVersion}.exe`;
  await writeFile(join(release, file), bytes);
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      version: nextVersion,
      publishedAt: "2026-10-01T00:00:00.000Z",
      artifacts: [
        {
          platform: "win32",
          arch: "x64",
          kind: "nsis",
          file,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          url: `./${file}`,
        },
      ],
    }),
  );
}

async function launch(useEnvironmentSource = true) {
  const environment = { ...process.env };
  delete environment.CODEXGPT_BRIDGE_E2E_UPDATE_MANIFEST_PATH;
  return electron.launch({
    executablePath: executable ?? require("electron"),
    args: executable ? [] : [root],
    cwd: root,
    env: {
      ...environment,
      CODEX_HOME: join(profile, "codex"),
      CODEXGPT_BRIDGE_E2E_USER_DATA_DIR: profile,
      ...(useEnvironmentSource
        ? { CODEXGPT_BRIDGE_E2E_UPDATE_MANIFEST_PATH: manifestPath }
        : {}),
      CODEXGPT_BRIDGE_E2E_NATIVE_MODELS_JSON: '{"models":[]}',
      CODEXGPT_BRIDGE_E2E_EXISTING_MODELS_JSON: '{"models":[]}',
    },
  });
}

async function trayAction(action) {
  return application.evaluate(({ app }, action) => {
    const require = process
      .getBuiltinModule("module")
      .createRequire(`${app.getAppPath()}/package.json`);
    const {
      BridgeSystemTray,
    } = require("./apps/desktop/dist/main/system-tray.js");
    const tray = BridgeSystemTray.current;
    if (action === "spy") {
      globalThis.__updateBalloons = [];
      // Capture the actual Windows notification request without showing fake releases.
      tray.tray.displayBalloon = (options) =>
        globalThis.__updateBalloons.push(options);
    } else if (action === "click") tray.tray.emit("balloon-click");
    return {
      labels: tray.menu.items.map((item) => item.label),
      balloons: globalThis.__updateBalloons ?? [],
    };
  }, action);
}

try {
  await mkdir(join(profile, "codex"), { recursive: true });
  await mkdir(release);
  await writeFile(join(profile, "codex", "config.toml"), "");
  await writeFile(
    join(profile, "desktop-settings.json"),
    JSON.stringify({
      locale: "zh-TW",
      allowedRoots: [],
      permission: "read_only",
      backgroundRuntime: false,
    }),
  );
  await writeManifest("0.0.0");
  application = await launch();
  let page = await application.firstWindow();
  await page.waitForFunction(
    async () =>
      (await globalThis.codexgptBridge.getUpdateStatus()).phase ===
      "up-to-date",
  );
  await trayAction("spy");
  await page.close();
  await writeManifest(version);
  process.stdout.write(
    "Update reminder E2E: waiting for the real background minute check with the main window closed\n",
  );
  const deadline = Date.now() + 75_000;
  let state;
  while (Date.now() < deadline) {
    state = await trayAction("inspect");
    if (state.balloons.length) break;
    await setTimeout(1_000);
  }
  assert.equal(
    state.balloons.length,
    1,
    "The background check did not request a Windows notification",
  );
  assert.match(state.balloons[0].content, /99\.0\.0-test/);
  assert.equal(state.balloons[0].respectQuietTime, true);
  assert.ok(state.labels.includes(`查看更新 ${version}`));
  const reopened = application.waitForEvent("window");
  await trayAction("click");
  page = await reopened;
  await page.getByRole("status").filter({ hasText: version }).waitFor();
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt[manifestPath], version);
  const before = (await stat(receiptPath)).mtimeMs;
  await page.evaluate(() => globalThis.codexgptBridge.checkForUpdate());
  assert.equal((await trayAction("inspect")).balloons.length, 1);
  const ready = await page.evaluate(() =>
    globalThis.codexgptBridge.downloadUpdate(),
  );
  assert.equal(ready.phase, "ready");
  assert.deepEqual(await readFile(ready.downloadedPath), bytes);
  assert.equal(
    (await page.evaluate(() => globalThis.codexgptBridge.checkForUpdate()))
      .phase,
    "ready",
  );
  assert.ok(
    (await trayAction("inspect")).labels.includes(`查看更新 ${version}`),
  );
  await application.close();
  const settingsPath = join(profile, "desktop-settings.json");
  const savedSettings = JSON.parse(await readFile(settingsPath, "utf8"));
  await writeFile(
    settingsPath,
    JSON.stringify({ ...savedSettings, updateManifestPath: manifestPath }),
  );
  application = await launch(false);
  page = await application.firstWindow();
  await page.waitForFunction(
    async () =>
      (await globalThis.codexgptBridge.getUpdateStatus()).phase === "available",
  );
  assert.equal(
    (await page.evaluate(() => globalThis.codexgptBridge.getUpdateStatus()))
      .manifestPath,
    manifestPath,
  );
  assert.equal(
    (await stat(receiptPath)).mtimeMs,
    before,
    "Restart repeated the already-announced version",
  );
  await application.close();
  application = undefined;
  process.stdout.write(
    "Update reminder E2E passed: background notification, tray entry, click/reopen, banner, restart deduplication and verified local copy; no installer executed\n",
  );
} finally {
  await application?.close().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
