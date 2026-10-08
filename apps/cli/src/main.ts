import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { defaultControlFile, desktopCommand } from "./provider-client.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const packageJson = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as { version?: unknown };
const VERSION =
  typeof packageJson.version === "string" ? packageJson.version : "unknown";
const execFileAsync = promisify(execFile);

function printHelp(): void {
  process.stdout.write(`CodexGPT Bridge ${VERSION}\n\n`);
  process.stdout.write("Usage:\n");
  process.stdout.write("  codexgpt-bridge doctor [--output PATH]\n");
  process.stdout.write("  codexgpt-bridge health [URL]\n");
  process.stdout.write("  codexgpt-bridge --version\n");
  process.stdout.write(
    "  codexgpt-bridge status|setup|repair|remove|native|models|usage|subagents [--control-file PATH] [--dev]\n",
  );
  process.stdout.write(
    "  codexgpt-bridge settings [--set JSON | --file PATH] [--control-file PATH]\n",
  );
  process.stdout.write(
    "  codexgpt-bridge tunnel status|configure --file PATH\n",
  );
  process.stdout.write("  codexgpt-bridge cancel THREAD_ID\n");
  process.stdout.write(
    "  codexgpt-bridge service status|stop|start --executable PATH [--dev]\n",
  );
  process.stdout.write(
    "  codexgpt-bridge lab --input RESPONSES_JSON [--output PROMPT_FILE]\n",
  );
}

function flagValues(args: readonly string[], flag: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`${flag} requires a value.`);
      values.push(value);
      index += 1;
    }
  }
  return values;
}

function singleFlag(args: readonly string[], flag: string): string | undefined {
  const values = flagValues(args, flag);
  if (values.length > 1) throw new Error(`${flag} may only be specified once.`);
  return values[0];
}

async function binaryVersion(
  name: string,
  args: readonly string[],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(name, [...args], {
      encoding: "utf8",
      windowsHide: true,
    });
    return stdout.trim().split(/\r?\n/, 1)[0] ?? "ok";
  } catch {
    return "missing";
  }
}

async function pathState(
  path: string,
): Promise<"file" | "directory" | "missing" | "unreadable"> {
  try {
    const info = await stat(path);
    return info.isFile()
      ? "file"
      : info.isDirectory()
        ? "directory"
        : "unreadable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unreadable";
  }
}

async function runDoctor(args: readonly string[]): Promise<void> {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--output")
      throw new Error(`Unknown doctor argument: ${args[index]}`);
    index += 1;
  }
  const nodeMajor = Number.parseInt(
    process.versions.node.split(".")[0] ?? "0",
    10,
  );
  const codexDirectory = process.env.CODEX_HOME?.trim()
    ? resolve(process.env.CODEX_HOME.trim())
    : join(homedir(), ".codex");
  const config = join(codexDirectory, "config.toml");
  const [git, rg, codexHomeState, configState] = await Promise.all([
    binaryVersion("git", ["--version"]),
    binaryVersion("rg", ["--version"]),
    pathState(codexDirectory),
    pathState(config),
  ]);
  const checks = [
    {
      id: "node",
      status: nodeMajor >= 22 ? "pass" : "fail",
      detail: process.version,
    },
    {
      id: "platform",
      status: ["win32", "darwin", "linux"].includes(process.platform)
        ? "pass"
        : "fail",
      detail: `${process.platform}/${process.arch}`,
    },
    {
      id: "git",
      status: git === "missing" ? "warning" : "pass",
      detail: git,
    },
    {
      id: "ripgrep",
      status: rg === "missing" ? "warning" : "pass",
      detail: rg,
    },
    {
      id: "codex-home",
      status: codexHomeState === "directory" ? "pass" : "warning",
      detail: codexHomeState,
    },
    {
      id: "codex-config",
      status: configState === "file" ? "pass" : "warning",
      detail: configState,
    },
  ] as const;
  const report = {
    schemaVersion: 1,
    service: "codexgpt-bridge",
    version: VERSION,
    generatedAt: new Date().toISOString(),
    status: checks.some((check) => check.status === "fail")
      ? "broken"
      : checks.some((check) => check.status === "warning")
        ? "attention"
        : "ok",
    checks,
    privacy: {
      promptsIncluded: false,
      responsesIncluded: false,
      credentialsIncluded: false,
      absolutePathsIncluded: false,
    },
  };
  const body = `${JSON.stringify(report, null, 2)}\n`;
  const output = singleFlag(args, "--output");
  if (output) {
    await writeFile(output, body, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`Doctor report written to ${output}\n`);
  } else {
    process.stdout.write(body);
  }
  if (report.status === "broken") process.exitCode = 1;
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const dev = rawArgs.includes("--dev");
  const controlFile = singleFlag(rawArgs, "--control-file");
  const filtered = rawArgs.filter(
    (arg, index) =>
      arg !== "--dev" &&
      arg !== "--control-file" &&
      rawArgs[index - 1] !== "--control-file",
  );
  const [command, ...args] = filtered;
  const call = async (name: string, values: readonly unknown[] = []) =>
    desktopCommand(
      controlFile ?? (await defaultControlFile(dev)),
      name,
      values,
    );
  const print = (value: unknown) =>
    process.stdout.write(`${JSON.stringify(value ?? null, null, 2)}\n`);
  switch (command) {
    case "status":
      print(await call("provider:status"));
      return;
    case "setup":
      print(await call("provider:install"));
      return;
    case "repair":
      print(await call("provider:repair"));
      return;
    case "native":
    case "remove":
      print(await call("provider:remove"));
      return;
    case "cancel":
      if (!args[0]) throw new Error("cancel requires THREAD_ID.");
      print(await call("provider:cancel-task", [args[0]]));
      return;
    case "settings": {
      const value = singleFlag(args, "--set");
      const file = singleFlag(args, "--file");
      if (value && file) throw new Error("Use either --set or --file.");
      const body = file ? await readFile(file, "utf8") : value;
      print(
        body
          ? await call("settings:set-advanced", [JSON.parse(body) as unknown])
          : await call("settings:get"),
      );
      return;
    }
    case "models":
    case "usage":
    case "subagents": {
      const result = (await call("provider:status")) as Record<string, unknown>;
      print(
        command === "models"
          ? result.modelIds
          : command === "usage"
            ? result.officialUsage
            : result.subagents,
      );
      return;
    }
    case "tunnel": {
      if (args[0] === "status") {
        print(
          ((await call("provider:status")) as Record<string, unknown>).fullMcp,
        );
        return;
      }
      if (args[0] !== "configure")
        throw new Error("Use tunnel status or tunnel configure --file PATH.");
      const file = singleFlag(args, "--file");
      if (!file) throw new Error("Tunnel configuration requires --file PATH.");
      print(
        await call("settings:set-full-mcp", [
          JSON.parse(await readFile(file, "utf8")) as unknown,
        ]),
      );
      return;
    }
    case "service": {
      if (args[0] === "status") {
        print(await call("provider:status"));
        return;
      }
      if (args[0] === "stop") {
        print(await call("provider:stop"));
        return;
      }
      if (args[0] !== "start")
        throw new Error("Use service status, start, or stop.");
      const executable = singleFlag(args, "--executable");
      if (!executable || (await pathState(resolve(executable))) !== "file")
        throw new Error(
          "service start requires an existing --executable PATH.",
        );
      const child = spawn(
        resolve(executable),
        ["--hidden", "--start-provider", ...(dev ? ["--dev"] : [])],
        { detached: true, windowsHide: true, stdio: "ignore" },
      );
      await new Promise<void>((resolveStarted, reject) => {
        child.once("spawn", resolveStarted);
        child.once("error", reject);
      });
      child.unref();
      print({
        launched: true,
        pid: child.pid,
        profile: dev ? "dev" : "production",
      });
      return;
    }
    case "lab": {
      const file = singleFlag(args, "--input");
      if (!file) throw new Error("lab requires --input RESPONSES_JSON.");
      const { compileResponsesPrompt, prepareBridgeWebTurn } =
        await import("../../../packages/responses-gateway/dist/index.js");
      const input = await readFile(file, "utf8");
      if (input.length > 2000000) throw new Error("Lab input exceeds 2 MB.");
      const compiled = compileResponsesPrompt(JSON.parse(input) as unknown);
      const prepared = prepareBridgeWebTurn(compiled);
      const output = singleFlag(args, "--output");
      if (output)
        await writeFile(
          output,
          [
            compiled.context.instructions,
            ...compiled.context.history,
            prepared.contract,
            prepared.prompt,
          ].join("\n\n"),
          { encoding: "utf8", mode: 0o600 },
        );
      print({
        mode: "offline",
        historyItems: compiled.context.history.length,
        currentImages: compiled.images.length,
        historyImages: compiled.context.images.length,
        tools: prepared.tools.length,
        verbosity: compiled.verbosity,
        output,
      });
      return;
    }
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return;
    case "doctor":
      await runDoctor(args);
      return;
    case "health": {
      const url = args[0] ?? "http://127.0.0.1:7767/health";
      const response = await fetch(url);
      process.stdout.write(`${await response.text()}\n`);
      if (!response.ok) process.exitCode = 1;
      return;
    }
    case undefined:
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Command failed."}\n`,
  );
  process.exitCode = 1;
});
