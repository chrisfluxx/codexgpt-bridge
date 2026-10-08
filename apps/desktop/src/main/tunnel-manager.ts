import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface FullMcpTunnelSettings {
  readonly tunnelId: string;
  readonly runtimeKeyFile: string;
  readonly tunnelClientPath?: string;
}

export interface FullMcpTunnelStatus {
  readonly configured: boolean;
  readonly running: boolean;
  readonly ready: boolean;
  readonly detail?: string;
}

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

type CommandRunner = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<CommandResult>;

interface ParsedTunnelStatus extends FullMcpTunnelStatus {
  readonly healthy: boolean;
}

const ALIAS = "codexgpt-bridge";
const PROFILE = "codexgpt-bridge";
const MAX_OUTPUT_BYTES = 1024 * 1024;
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 500;

function stoppedOrMissing(result: CommandResult): boolean {
  return (
    result.status === 0 ||
    /not found|not running|unknown alias/iu.test(
      `${result.stdout}\n${result.stderr}`,
    )
  );
}

function safeDetail(value: string): string {
  return value
    .replace(/tunnel_[a-f0-9]{32}/gu, "[tunnel-id]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/gu, "[redacted-key]")
    .slice(0, 2_000);
}

function nestedBoolean(value: unknown, key: string): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)[key] === true
  );
}

function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function parseTunnelStatusOutput(output: string): ParsedTunnelStatus {
  try {
    const parsed = JSON.parse(output) as unknown;
    const running =
      nestedBoolean(parsed, "process_running") ||
      nestedBoolean(parsed, "running");
    const healthy = nestedBoolean(parsed, "healthy");
    const ready = running && healthy && nestedBoolean(parsed, "ready");
    return {
      configured: true,
      running,
      healthy,
      ready,
      detail: safeDetail(output),
    };
  } catch {
    return {
      configured: true,
      running: false,
      healthy: false,
      ready: false,
      detail: safeDetail(output || "Tunnel client returned no status."),
    };
  }
}

export class TunnelManager {
  readonly #profileDirectory: string;
  readonly #commandRunner: CommandRunner | undefined;
  #binary: string | undefined;
  #connected = false;

  constructor(dataDirectory: string, commandRunner?: CommandRunner) {
    this.#profileDirectory = join(dataDirectory, "tunnel", "profiles");
    this.#commandRunner = commandRunner;
  }

  validate(settings: FullMcpTunnelSettings): void {
    if (!/^tunnel_[a-f0-9]{32}$/u.test(settings.tunnelId)) {
      throw new Error(
        "Full MCP tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters.",
      );
    }
    if (
      !isAbsolute(settings.runtimeKeyFile) ||
      !isExistingFile(settings.runtimeKeyFile)
    ) {
      throw new Error(
        "Full MCP runtime key file must be an existing absolute path.",
      );
    }
    if (
      settings.tunnelClientPath &&
      (!isAbsolute(settings.tunnelClientPath) ||
        !isExistingFile(settings.tunnelClientPath))
    ) {
      throw new Error("Tunnel client path must be an existing absolute path.");
    }
  }

  async connect(
    settings: FullMcpTunnelSettings,
    mcpServerUrl: string,
  ): Promise<FullMcpTunnelStatus> {
    this.validate(settings);
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/u.test(mcpServerUrl)) {
      throw new Error("Full MCP server must be a loopback HTTP endpoint.");
    }
    const binary = this.#resolveBinary(settings.tunnelClientPath);
    await mkdir(this.#profileDirectory, { recursive: true, mode: 0o700 });

    // `runtimes connect` updates the profile and runtime registry, but an
    // already-running tunnel-client keeps the MCP target it loaded at launch.
    // The desktop MCP server uses a new ephemeral port after every restart, so
    // reusing that process produces a misleading ready state followed by 502s.
    // Replace the alias process before writing and loading the current target.
    const stopped = await this.#run(
      binary,
      ["runtimes", "stop", ALIAS, "--json"],
      15_000,
    );
    if (!stoppedOrMissing(stopped)) {
      throw new Error(
        `OpenAI Tunnel failed to replace its previous runtime: ${safeDetail(stopped.stderr || stopped.stdout || `exit ${stopped.status}`)}`,
      );
    }

    const result = await this.#run(
      binary,
      [
        "runtimes",
        "connect",
        "--alias",
        ALIAS,
        "--profile",
        PROFILE,
        "--profile-dir",
        this.#profileDirectory,
        "--tunnel-client-bin",
        binary,
        "--tunnel-id",
        settings.tunnelId,
        "--runtime-api-key",
        `file:${settings.runtimeKeyFile}`,
        "--mcp-server-url",
        mcpServerUrl,
        "--json",
      ],
      120_000,
    );
    if (result.status !== 0) {
      throw new Error(
        `OpenAI Tunnel failed to start: ${safeDetail(result.stderr || result.stdout || `exit ${result.status}`)}`,
      );
    }
    const launch = parseTunnelStatusOutput(result.stdout || result.stderr);
    if (!launch.running || !launch.healthy) {
      throw new Error(
        `OpenAI Tunnel did not start a healthy runtime: ${launch.detail ?? "unknown status"}`,
      );
    }
    this.#binary = binary;
    this.#connected = true;
    try {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      let status = await this.status();
      while (!status.ready && Date.now() < deadline) {
        await new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, READY_POLL_MS),
        );
        status = await this.status();
      }
      if (!status.ready) {
        throw new Error(
          `OpenAI Tunnel did not become ready: ${status.detail ?? "unknown status"}`,
        );
      }
      return status;
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async status(): Promise<FullMcpTunnelStatus> {
    if (!this.#binary || !this.#connected) {
      return { configured: false, running: false, ready: false };
    }
    const result = await this.#run(
      this.#binary,
      ["runtimes", "status", ALIAS, "--json"],
      15_000,
    );
    if (result.status !== 0) {
      return {
        configured: true,
        running: false,
        ready: false,
        detail: safeDetail(result.stderr || result.stdout),
      };
    }
    const status = parseTunnelStatusOutput(result.stdout || result.stderr);
    return {
      configured: status.configured,
      running: status.running,
      ready: status.ready,
      ...(status.detail ? { detail: status.detail } : {}),
    };
  }

  async stop(): Promise<void> {
    const binary = this.#binary;
    this.#binary = undefined;
    this.#connected = false;
    if (!binary) return;
    const result = await this.#run(
      binary,
      ["runtimes", "stop", ALIAS, "--json"],
      15_000,
    );
    if (!stoppedOrMissing(result)) {
      throw new Error(
        `OpenAI Tunnel failed to stop: ${safeDetail(result.stderr || result.stdout)}`,
      );
    }
  }

  #resolveBinary(configured?: string): string {
    const candidates = [
      configured,
      process.env.CODEXGPT_BRIDGE_TUNNEL_CLIENT?.trim(),
      join(
        homedir(),
        ".codexgpt-bridge",
        "bin",
        process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client",
      ),
    ].filter((value): value is string => Boolean(value));
    const binary = candidates.find((candidate) => isExistingFile(candidate));
    if (!binary) {
      throw new Error(
        "OpenAI tunnel-client was not found. Set its absolute path in Full MCP settings.",
      );
    }
    return binary;
  }

  #run(
    executable: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<CommandResult> {
    if (this.#commandRunner) {
      return this.#commandRunner(executable, args, timeoutMs);
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(executable, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        action();
      };
      const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
        bytes += chunk.byteLength;
        if (bytes > MAX_OUTPUT_BYTES) {
          child.kill();
          finish(() =>
            rejectPromise(new Error("Tunnel client output exceeded 1 MiB.")),
          );
          return;
        }
        if (target === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };
      child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
      child.once("error", (error) => finish(() => rejectPromise(error)));
      child.once("close", (status) =>
        finish(() => resolvePromise({ status: status ?? -1, stdout, stderr })),
      );
      const timeout = setTimeout(() => {
        child.kill();
        finish(() =>
          rejectPromise(
            new Error(`Tunnel client timed out after ${timeoutMs} ms.`),
          ),
        );
      }, timeoutMs);
      timeout.unref?.();
    });
  }
}
