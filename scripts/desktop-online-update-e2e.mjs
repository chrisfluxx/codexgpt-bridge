import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { _electron as electron } from "playwright-core";

if (process.platform !== "win32") {
  process.stdout.write("Online update desktop E2E requires Windows.\n");
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const executable = process.argv
  .find((arg) => arg.startsWith("--executable="))
  ?.slice(13);
const directory = await mkdtemp(join(tmpdir(), "bridge-online-update-e2e-"));
const profile = join(directory, "profile");
const codex = join(directory, "codex");
const launchRecord = join(directory, "installer-launch.json");
const bytes = Buffer.from("Isolated update fixture; never execute this file.");
let version = "99.0.0-test";
let application;

const server = createServer((request, response) => {
  const file = `CodexGPT-Bridge-Setup-${version}.exe`;
  if (request.url === "/latest/release-manifest.json") {
    response.writeHead(302, {
      location: `/releases/${version}/release-manifest.json`,
    });
    response.end();
  } else if (request.url === `/releases/${version}/release-manifest.json`) {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        schemaVersion: 1,
        version,
        publishedAt: "2026-10-08T00:00:00.000Z",
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
  } else if (request.url === `/releases/${version}/${file}`) {
    response.write(bytes.subarray(0, 8));
    response.end(bytes.subarray(8));
  } else {
    response.writeHead(404);
    response.end();
  }
});

async function launch(source) {
  const environment = { ...process.env };
  delete environment.CODEXGPT_BRIDGE_E2E_UPDATE_MANIFEST_PATH;
  delete environment.CODEXGPT_BRIDGE_UPDATE_PUBLIC_KEY_FILE;
  return electron.launch({
    executablePath: executable ?? require("electron"),
    args: executable ? [] : [root],
    cwd: root,
    env: {
      ...environment,
      CODEX_HOME: codex,
      CODEXGPT_BRIDGE_E2E_USER_DATA_DIR: profile,
      CODEXGPT_BRIDGE_UPDATE_MANIFEST_URL: source,
      CODEXGPT_BRIDGE_E2E_NATIVE_MODELS_JSON: '{"models":[]}',
      CODEXGPT_BRIDGE_E2E_EXISTING_MODELS_JSON: '{"models":[]}',
    },
  });
}

async function waitForUpdatePhase(page, phase) {
  let status;
  const deadline = Date.now() + 30_000;
  do {
    status = await page.evaluate(() =>
      globalThis.codexgptBridge.getUpdateStatus(),
    );
    if (status.phase === phase) return status;
    await setTimeout(100);
  } while (Date.now() < deadline);
  throw new Error(
    `Expected update phase ${phase}, received ${status?.phase}: ${status?.error ?? "no error"}`,
  );
}

try {
  await mkdir(profile);
  await mkdir(codex);
  await writeFile(join(codex, "config.toml"), "");
  await writeFile(
    join(profile, "desktop-settings.json"),
    JSON.stringify({ locale: "en", backgroundRuntime: false }),
  );
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const source = `http://127.0.0.1:${address.port}/latest/release-manifest.json`;
  application = await launch(source);
  let page = await application.firstWindow();
  const status = () =>
    page.evaluate(() => globalThis.codexgptBridge.getUpdateStatus());
  await page.getByRole("status").filter({ hasText: version }).waitFor();
  assert.equal((await status()).manifestPath, undefined);
  assert.equal((await status()).manifestUrl, source);
  const receiptPath = join(profile, "update-notifications.json");
  await waitForUpdatePhase(page, "available");
  let receipt;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      if (receipt[source] === version) break;
    } catch {
      // The startup check writes the receipt after showing the notice.
    }
    await setTimeout(100);
  }
  assert.ok(receipt);
  assert.equal(receipt[source], version);
  await application.close();
  application = await launch(source);
  page = await application.firstWindow();
  await page.getByRole("status").filter({ hasText: version }).waitFor();
  assert.deepEqual(JSON.parse(await readFile(receiptPath, "utf8")), receipt);

  // Capture notifications and installation requests inside this isolated app only.
  await application.evaluate(({ app }, launchRecord) => {
    const module = process.getBuiltinModule("module");
    const require = module.createRequire(`${app.getAppPath()}/package.json`);
    const {
      BridgeSystemTray,
    } = require("./apps/desktop/dist/main/system-tray.js");
    globalThis.__onlineUpdateBalloons = [];
    BridgeSystemTray.current.tray.displayBalloon = (options) =>
      globalThis.__onlineUpdateBalloons.push(options);
    const childProcess = require("node:child_process");
    const originalSpawn = childProcess.spawn;
    const { EventEmitter } = require("node:events");
    const { writeFileSync } = require("node:fs");
    childProcess.spawn = (file, args, options) => {
      if (!String(file).includes("CodexGPT-Bridge-Setup-99."))
        return originalSpawn(file, args, options);
      writeFileSync(launchRecord, JSON.stringify({ file, args, options }));
      const child = new EventEmitter();
      child.unref = () => undefined;
      globalThis.setImmediate(() => child.emit("spawn"));
      return child;
    };
    module.syncBuiltinESMExports();
  }, launchRecord);
  version = "99.0.1-test";
  const card = page.locator("#bridge-updates");
  await card
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  await page.getByRole("status").filter({ hasText: version }).waitFor();
  await page.waitForFunction(
    () => !globalThis.document.querySelector("#bridge-updates button").disabled,
  );
  const tray = await application.evaluate(({ app }) => {
    const require = process
      .getBuiltinModule("module")
      .createRequire(`${app.getAppPath()}/package.json`);
    const {
      BridgeSystemTray,
    } = require("./apps/desktop/dist/main/system-tray.js");
    return {
      labels: BridgeSystemTray.current.menu.items.map((item) => item.label),
      balloons: globalThis.__onlineUpdateBalloons,
    };
  });
  assert.equal(tray.balloons.length, 1);
  assert.ok(tray.labels.some((label) => label.includes(version)));
  await card
    .getByRole("button", { name: "Download verified update", exact: true })
    .click();
  const ready = await waitForUpdatePhase(page, "ready");
  assert.equal(typeof ready.downloadedPath, "string");
  assert.deepEqual(await readFile(ready.downloadedPath), bytes);
  const tampered = Buffer.from(bytes);
  tampered[0] ^= 1;
  await writeFile(ready.downloadedPath, tampered);
  await card
    .getByRole("button", { name: "Install verified update", exact: true })
    .click();
  await waitForUpdatePhase(page, "failed");
  await assert.rejects(readFile(launchRecord), { code: "ENOENT" });
  await page.waitForFunction(() =>
    [...globalThis.document.querySelectorAll("#bridge-updates button")].some(
      (button) =>
        button.textContent === "Install verified update" && button.disabled,
    ),
  );
  await card
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  await card
    .getByRole("button", { name: "Download verified update", exact: true })
    .click();
  await waitForUpdatePhase(page, "ready");
  const closed = application.waitForEvent("close");
  await card
    .getByRole("button", { name: "Install verified update", exact: true })
    .click();
  await closed;
  application = undefined;
  const install = JSON.parse(await readFile(launchRecord, "utf8"));
  assert.equal(install.file, ready.downloadedPath);
  assert.deepEqual(install.args, []);
  assert.equal(install.options.detached, true);
  process.stdout.write(
    "Online update desktop E2E passed: redirected feed, startup notice, restart receipts, tray notification, verified download, tamper rejection and install handoff/quit. Fixture installer was never executed.\n",
  );
} finally {
  await application?.close().catch(() => undefined);
  server.closeAllConnections();
  if (server.listening)
    await new Promise((resolvePromise, reject) =>
      server.close((error) => (error ? reject(error) : resolvePromise())),
    );
  const withinTemp = relative(resolve(tmpdir()), resolve(directory));
  assert.ok(
    withinTemp &&
      !isAbsolute(withinTemp) &&
      withinTemp !== ".." &&
      !withinTemp.startsWith(`..${sep}`),
  );
  await rm(directory, { recursive: true, force: true });
}
