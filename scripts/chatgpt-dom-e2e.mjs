import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron } from "playwright-core";
import { runChatGptDomChecks } from "./chatgpt-dom-checks.mjs";

const directory = await mkdtemp(join(tmpdir(), "bridge-dom-e2e-"));
let app;
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [fileURLToPath(new URL("./chatgpt-dom-host.mjs", import.meta.url))],
    env: { ...process.env, CODEXGPT_BRIDGE_DOM_TEST_PROFILE: directory },
  });
  await runChatGptDomChecks(app);
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
