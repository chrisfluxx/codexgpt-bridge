import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  process.stdout.write(
    "Windows installer smoke skipped on non-Windows host.\n",
  );
  process.exit(0);
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, "..");
const packageMetadata = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
);
assert.equal(typeof packageMetadata.version, "string");
const installer = join(
  repositoryRoot,
  "release",
  "installer-smoke",
  `CodexGPT-Bridge-Setup-${packageMetadata.version}.exe`,
);
const smokeProvenance = JSON.parse(
  await readFile(
    join(repositoryRoot, "release", "installer-smoke", "smoke-provenance.json"),
    "utf8",
  ),
);
assert.equal(smokeProvenance.appId, "io.codexgpt.bridge.installer-smoke");
assert.equal(smokeProvenance.productName, "CodexGPT Bridge Installer Smoke");
assert.equal(smokeProvenance.version, packageMetadata.version);
const stagingRoot = await mkdtemp(join(tmpdir(), "codexgpt-installer-smoke-"));
const installDirectory = join(stagingRoot, "app");
const installedExecutable = join(
  installDirectory,
  "CodexGPT Bridge Installer Smoke.exe",
);
let uninstaller;

function run(file, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, {
      cwd: repositoryRoot,
      shell: false,
      windowsHide: true,
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(
          new Error(
            `${file} failed with ${signal === null ? `exit ${String(code)}` : `signal ${signal}`}.`,
          ),
        );
    });
  });
}

async function waitUntilMissing(path) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const names = await readdir(path);
      if (names.length === 0) return;
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await new Promise((resolvePromise) =>
      globalThis.setTimeout(resolvePromise, 100),
    );
  }
  throw new Error("Installed application directory remained after uninstall.");
}

try {
  await run(installer, ["/S", `/D=${installDirectory}`]);
  const installedNames = await readdir(installDirectory);
  assert.ok(installedNames.includes("CodexGPT Bridge Installer Smoke.exe"));
  uninstaller = installedNames.find(
    (name) => name.startsWith("Uninstall") && name.endsWith(".exe"),
  );
  assert.ok(uninstaller, "NSIS uninstaller was not installed.");

  await run(process.execPath, [
    join(repositoryRoot, "scripts", "desktop-e2e.mjs"),
    `--executable=${installedExecutable}`,
  ]);

  await run(join(installDirectory, uninstaller), ["/S"]);
  await waitUntilMissing(installDirectory);
  process.stdout.write(
    "Windows isolated installer smoke passed: install, launch/Web provider E2E, uninstall; separate app identity and no shortcuts.\n",
  );
} finally {
  if (uninstaller !== undefined) {
    try {
      await run(join(installDirectory, uninstaller), ["/S"]);
    } catch {
      // Best-effort cleanup after a failed smoke run.
    }
  }
  const cleanupPath = resolve(stagingRoot);
  const withinTemp = relative(resolve(tmpdir()), cleanupPath);
  assert.ok(
    withinTemp &&
      !isAbsolute(withinTemp) &&
      withinTemp !== ".." &&
      !withinTemp.startsWith(`..${sep}`) &&
      cleanupPath === stagingRoot,
    "Installer smoke cleanup must remain inside its temporary directory.",
  );
  await rm(cleanupPath, { recursive: true, force: true });
}
