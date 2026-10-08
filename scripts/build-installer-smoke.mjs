import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { join } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { build, Platform, Arch } from "electron-builder";

if (process.platform !== "win32")
  throw new Error("Installer smoke requires Windows.");
const projectDir = fileURLToPath(new URL("../", import.meta.url));
const metadata = JSON.parse(
  await readFile(join(projectDir, "package.json"), "utf8"),
);
const productName = "CodexGPT Bridge Installer Smoke";
const appId = "io.codexgpt.bridge.installer-smoke";
const output = join(projectDir, "release", "installer-smoke");
const buildOptions = {
  projectDir,
  targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
  publish: "never",
  config: {
    ...metadata.build,
    appId,
    productName,
    extraMetadata: { name: "codexgpt-bridge-installer-smoke" },
    directories: { ...metadata.build.directories, output },
    nsis: {
      ...metadata.build.nsis,
      guid: "6bef75e6-75f4-4c0a-bcb8-3c6a1c9e0993",
      createDesktopShortcut: false,
      createStartMenuShortcut: false,
      runAfterFinish: false,
    },
  },
};
for (let attempt = 1; ; attempt += 1) {
  try {
    await build(buildOptions);
    break;
  } catch (error) {
    // Windows scanners can briefly lock resources while they are being copied.
    if (error?.code !== "EBUSY" || attempt >= 3) throw error;
    process.stdout.write(
      `Installer smoke build hit a temporary file lock; retrying (${attempt}/2).\n`,
    );
    await setTimeout(attempt * 2_000);
  }
}
await writeFile(
  join(output, "smoke-provenance.json"),
  JSON.stringify({ version: metadata.version, appId, productName }),
);
