import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "bridge-provider-repair-"));
const codexDirectory = join(temporary, "codex");
const profile = join(temporary, "profile");
const configPath = join(codexDirectory, "config.toml");
const packaged = process.argv
  .find((arg) => arg.startsWith("--executable="))
  ?.slice(13);
let application;

async function runInterruptHook(command) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, {
      cwd: root,
      shell: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Interrupt hook exited ${code}: ${stderr}`));
    });
    child.stdin.end(
      JSON.stringify({
        hook_event_name: "Interrupt",
        session_id: "thread_native_hook",
        turn_id: "turn_native_hook",
      }),
    );
  });
}

try {
  await mkdir(codexDirectory);
  await mkdir(profile);
  await writeFile(
    join(profile, "desktop-settings.json"),
    JSON.stringify({ locale: "en", webToolMode: "simple" }),
  );
  await writeFile(
    configPath,
    'openai_base_url = "https://initial-provider.example/v1"\nmodel = "gpt-native-test"\n',
  );
  application = await electron.launch({
    executablePath: packaged ?? require("electron"),
    args: packaged ? [] : [root],
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: codexDirectory,
      CODEXGPT_BRIDGE_E2E_USER_DATA_DIR: profile,
      CODEXGPT_BRIDGE_RESPONSES_PORT: "47767",
      CODEXGPT_BRIDGE_E2E_EXISTING_MODELS_JSON: JSON.stringify({
        models: [
          {
            slug: "gpt-native-test",
            display_name: "Native test",
            base_instructions: "Test",
            supports_reasoning_summaries: false,
            supports_parallel_tool_calls: true,
          },
        ],
      }),
      CODEXGPT_BRIDGE_E2E_AVAILABLE_WEB_MODES_JSON: JSON.stringify([
        "instant",
        "medium",
        "high",
        "extra-high",
        "pro",
      ]),
    },
  });
  const page = await application.firstWindow();
  await page
    .getByRole("button", { name: "Install Web models", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove Web models", exact: true })
    .waitFor();
  const installed = await readFile(configPath, "utf8");
  const installedJournal = JSON.parse(
    await readFile(join(profile, "codex-provider-integration.json"), "utf8"),
  );
  const withoutHook = installed.replace(
    installedJournal.interruptHook.fragment,
    "",
  );
  assert.notEqual(withoutHook, installed);
  await writeFile(configPath, withoutHook);
  await page
    .getByRole("button", { name: "Repair connection", exact: true })
    .waitFor();
  const missingHook = await page.evaluate(() =>
    globalThis.codexgptBridge.getWebProviderStatus(),
  );
  assert.equal(missingHook.installed, false);
  assert.equal(missingHook.repairable, true);
  await page
    .getByRole("button", { name: "Repair connection", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove Web models", exact: true })
    .waitFor();
  const hookRepaired = await readFile(configPath, "utf8");
  assert.match(hookRepaired, /CodexGPT Bridge managed Interrupt hook/u);
  const userHook = [
    "# Existing user Interrupt hook",
    "[[hooks.Interrupt]]",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    'command = "user-interrupt-hook"',
    "timeout = 3",
    "",
  ].join("\n");
  const reordered = hookRepaired
    .replace(
      "# >>> CodexGPT Bridge managed Interrupt hook",
      userHook + "# >>> CodexGPT Bridge managed Interrupt hook",
    )
    .replace(":interrupt:0:0", ":interrupt:1:0");
  const voice =
    'experimental_realtime_webrtc_call_base_url = "https://chatgpt.com/backend-api/codex"\n';
  const changed = reordered.replace(
    'openai_base_url = "http://127.0.0.1:47767/v1"',
    '# User-selected original provider\nopenai_base_url = "http://127.0.0.1:43123/custom/v1"\n' +
      voice.trimEnd(),
  );
  await writeFile(configPath, changed);
  await page
    .getByRole("button", { name: "Repair connection", exact: true })
    .waitFor();
  const conflict = await page.evaluate(() =>
    globalThis.codexgptBridge.getWebProviderStatus(),
  );
  assert.equal(conflict.installed, false);
  assert.equal(conflict.repairable, true);
  await page
    .getByRole("button", { name: "Repair connection", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove Web models", exact: true })
    .waitFor();
  assert.match(
    await page.getByRole("status").innerText(),
    /Connection repaired/u,
  );
  const repaired = await readFile(configPath, "utf8");
  assert.match(
    repaired,
    /openai_base_url = "http:\/\/127\.0\.0\.1:47767\/v1"/u,
  );
  assert.ok(repaired.includes(voice));
  assert.ok(
    repaired.indexOf(voice) >
      repaired.indexOf("# <<< CodexGPT Bridge managed Web provider"),
  );
  assert.equal((await readdir(join(profile, "provider-backups"))).length, 4);
  const repairedJournal = JSON.parse(
    await readFile(join(profile, "codex-provider-integration.json"), "utf8"),
  );
  assert.equal(repairedJournal.version, 5);
  assert.match(repaired, /CodexGPT Bridge managed Interrupt hook/u);
  assert.equal(repairedJournal.interruptHook.groupIndex, 1);
  assert.ok(repaired.includes(userHook));
  await runInterruptHook(repairedJournal.interruptHook.command);
  assert.equal(
    repairedJournal.upstreamBaseUrl,
    "http://127.0.0.1:43123/custom/v1",
  );
  const configBackups = (
    await readdir(join(profile, "provider-backups"))
  ).filter((name) => name.endsWith(".config.toml"));
  const backupContents = await Promise.all(
    configBackups.map((name) =>
      readFile(join(profile, "provider-backups", name), "utf8"),
    ),
  );
  assert.ok(backupContents.includes(changed));
  await page
    .getByRole("button", { name: "Remove Web models", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Install Web models", exact: true })
    .waitFor();
  const removed = await readFile(configPath, "utf8");
  assert.match(
    removed,
    /openai_base_url = "http:\/\/127\.0\.0\.1:43123\/custom\/v1"/u,
  );
  assert.ok(removed.includes(voice));
  assert.match(removed, /model = "gpt-native-test"/u);
  assert.doesNotMatch(removed, /model_catalog_json/u);
  assert.doesNotMatch(removed, /CodexGPT Bridge managed Interrupt hook/u);
  assert.ok(removed.includes(userHook));
  process.stdout.write(
    "Provider repair E2E passed: rebased hook recognized, visible repair, route restored, exact backup, other hook, voice and model preserved after uninstall.\n",
  );
} catch (error) {
  const page = application?.windows()[0];
  if (page) {
    process.stderr.write(
      `${(await page.locator("body").innerText()).slice(0, 8000)}\n`,
    );
  }
  throw error;
} finally {
  await application?.close();
  await rm(temporary, { recursive: true, force: true });
}
