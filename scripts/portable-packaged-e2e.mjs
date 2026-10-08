import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const executable =
  process.platform === "win32"
    ? join(root, "release", "win-unpacked", "CodexGPT Bridge.exe")
    : process.platform === "darwin"
      ? join(
          root,
          "release",
          process.arch === "arm64" ? "mac-arm64" : "mac",
          "CodexGPT Bridge.app",
          "Contents",
          "MacOS",
          "CodexGPT Bridge",
        )
      : process.platform === "linux"
        ? join(
            root,
            "release",
            process.arch === "arm64"
              ? "linux-arm64-unpacked"
              : "linux-unpacked",
            "codexgpt-bridge",
          )
        : undefined;
if (!executable)
  throw new Error(`Unsupported packaged E2E platform: ${process.platform}.`);
await access(executable);
const child = spawn(
  process.execPath,
  [join(root, "scripts", "desktop-e2e.mjs"), `--executable=${executable}`],
  { stdio: "inherit" },
);
const exitCode = await new Promise((resolvePromise, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) =>
    signal
      ? reject(new Error(`Packaged E2E ended with ${signal}.`))
      : resolvePromise(code ?? 1),
  );
});
process.exitCode = exitCode;
