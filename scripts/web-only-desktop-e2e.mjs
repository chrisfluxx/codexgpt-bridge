/* global window, document */
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import process from "node:process";
import { _electron as electron } from "playwright-core";
import { WebOnlyIntegration } from "../apps/desktop/dist/main/web-only-integration.js";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "bridge-web-only-retirement-"));
const taskCodexDirectory = join(directory, "codex");
const userData = join(directory, "bridge");
const configPath = join(taskCodexDirectory, "config.toml");
const executable = process.argv
  .find((arg) => arg.startsWith("--executable="))
  ?.slice(13);
let app;
const errors = [];
async function launch() {
  const application = await electron.launch({
    executablePath: executable ? resolve(executable) : require("electron"),
    args: executable ? ["--hidden"] : [root, "--hidden"],
    cwd: root,
    env: {
      ...process.env,
      CODEXGPT_BRIDGE_PROFILE: "dev",
      CODEXGPT_BRIDGE_DEV_CODEX_HOME: taskCodexDirectory,
      CODEXGPT_BRIDGE_E2E_USER_DATA_DIR: userData,
      CODEXGPT_BRIDGE_DESKTOP_PORT: "0",
      CODEXGPT_BRIDGE_RESPONSES_PORT: "0",
      CODEXGPT_BRIDGE_E2E_EXISTING_MODELS_JSON: '{"models":[]}',
      CODEXGPT_BRIDGE_E2E_NATIVE_MODELS_JSON: '{"models":[]}',
    },
  });
  const page = await application.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByRole("heading", { name: "CodexGPT Bridge", exact: true })
    .waitFor();
  await page.waitForFunction(() => document.documentElement.lang === "en");
  return application;
}
try {
  await mkdir(taskCodexDirectory);
  await mkdir(userData);
  await writeFile(
    join(userData, "desktop-settings.json"),
    JSON.stringify({ locale: "en", webToolMode: "simple" }),
  );
  const original =
    'model = "native-fixture"\nmodel_provider = "openai"\n# preserved user setting\n';
  await writeFile(configPath, original);
  app = await launch();
  let page = await app.firstWindow();
  assert.equal(
    await page
      .getByRole("button", { name: "Enable Web-only mode", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("heading", {
        name: "Web-only mode · Luna Reserve",
        exact: true,
      })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", {
        name: "Restore legacy connection settings",
        exact: true,
      })
      .count(),
    0,
  );
  const rejection = await page.evaluate(async () => {
    try {
      await window.codexgptBridge.setWebOnlyMode(true);
      return "unexpected success";
    } catch (error) {
      return error.message;
    }
  });
  assert.match(rejection, /Web-only mode has been removed/u);
  assert.equal(await readFile(configPath, "utf8"), original);
  await assert.rejects(access(join(userData, "web-only-integration.json")), {
    code: "ENOENT",
  });
  await app.close();
  app = undefined;

  // Seed a genuine previous-version configuration to verify its recovery path.
  const legacy = new WebOnlyIntegration(taskCodexDirectory, userData);
  await legacy.enable("http://127.0.0.1:7767/web/v1", {
    models: [
      { slug: "codexgpt-bridge/high", display_name: "Legacy Web fixture" },
    ],
  });
  const enabled = await readFile(configPath, "utf8");
  assert.match(enabled, /model_provider = "codexgpt_bridge_web"/u);
  const userEdit = "# user edit after legacy activation\n";
  await writeFile(configPath, enabled + userEdit);
  app = await launch();
  page = await app.firstWindow();
  const recovery = page.getByRole("button", {
    name: "Restore legacy connection settings",
    exact: true,
    includeHidden: true,
  });
  await recovery.waitFor({ state: "attached" });
  assert.equal(await recovery.isVisible(), false);
  assert.equal(
    (await page.evaluate(() => window.codexgptBridge.getWebProviderStatus()))
      .webOnly.managed,
    true,
  );
  await page
    .locator("summary")
    .filter({ hasText: /^Diagnostic information$/ })
    .click();
  await recovery.click();
  await recovery.waitFor({ state: "detached" });
  assert.equal(await readFile(configPath, "utf8"), original + userEdit);
  const restored = await page.evaluate(() =>
    window.codexgptBridge.getWebProviderStatus(),
  );
  assert.deepEqual(restored.webOnly, { enabled: false, managed: false });
  assert.equal(
    await page
      .getByRole("button", { name: "Enable Web-only mode", exact: true })
      .count(),
    0,
  );
  assert.deepEqual(errors, []);
  process.stdout.write(
    "Web-only retirement passed: no activation UI, activation API rejected without configuration writes, legacy recovery available in collapsed diagnostics, native settings and user edits restored.\n",
  );
} finally {
  if (app) await app.close();
  const checkedDirectory = resolve(directory);
  assert.ok(checkedDirectory.startsWith(resolve(tmpdir()) + sep));
  assert.equal(dirname(checkedDirectory), resolve(tmpdir()));
  await rm(checkedDirectory, { recursive: true, force: true });
}
