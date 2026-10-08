import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type BrowserContext } from "playwright-core";
import {
  validatePasskeyLoginState,
  type PasskeyLoginState,
} from "./passkey-login-state.js";

const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
const DEFAULT_CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const STOP_TIMEOUT_MS = 5_000;

export interface MacOsPasskeyLoginStatus {
  readonly available: boolean;
  readonly phase: "idle" | "waiting" | "importing";
  readonly error?: string;
}

interface ActiveLogin {
  readonly child: ChildProcess;
  readonly transferRoot: string;
  readonly profileDirectory: string;
  stopping: boolean;
  earlyExit?: Error;
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (exited(child)) return true;
  return await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

async function stopOwnedChrome(child: ChildProcess): Promise<void> {
  if (exited(child) || !Number.isInteger(child.pid)) return;
  const graceful = waitForExit(child, STOP_TIMEOUT_MS);
  if (!child.kill() && !exited(child)) {
    throw new Error("The dedicated Chrome passkey window refused to close.");
  }
  if (await graceful) return;
  const forced = waitForExit(child, STOP_TIMEOUT_MS);
  if (!child.kill("SIGKILL") && !exited(child)) {
    throw new Error(
      "The dedicated Chrome passkey window refused forced termination.",
    );
  }
  if (!(await forced)) {
    throw new Error("The dedicated Chrome passkey window did not exit.");
  }
}

async function removeChromeTabSessions(
  profileDirectory: string,
): Promise<void> {
  const defaultProfile = join(profileDirectory, "Default");
  await rm(join(defaultProfile, "Sessions"), { recursive: true, force: true });
  await Promise.all(
    ["Current Session", "Current Tabs", "Last Session", "Last Tabs"].map(
      (name) => rm(join(defaultProfile, name), { force: true }),
    ),
  );
}

export class MacOsPasskeyLogin {
  #active: ActiveLogin | undefined;
  #phase: MacOsPasskeyLoginStatus["phase"] = "idle";
  #error: string | undefined;

  constructor(
    private readonly userDataDirectory: string,
    private readonly platform = process.platform,
    private readonly chromePath = process.env.CODEXGPT_BRIDGE_CHROME_PATH?.trim() ||
      DEFAULT_CHROME_PATH,
  ) {}

  status(): MacOsPasskeyLoginStatus {
    return {
      available: this.platform === "darwin",
      phase: this.#phase,
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  async begin(): Promise<MacOsPasskeyLoginStatus> {
    if (this.platform !== "darwin") {
      throw new Error(
        "Passkey-assisted Chrome login is available only on macOS.",
      );
    }
    if (this.#active) {
      throw new Error("A passkey-assisted login is already active.");
    }
    await access(this.chromePath, constants.X_OK).catch(() => {
      throw new Error(`Google Chrome is unavailable at ${this.chromePath}.`);
    });
    const parent = join(this.userDataDirectory, "passkey-login");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700).catch(() => undefined);
    const transferRoot = await mkdtemp(join(parent, "transfer-"));
    await chmod(transferRoot, 0o700).catch(() => undefined);
    const profileDirectory = join(transferRoot, "chrome-profile");
    await mkdir(profileDirectory, { mode: 0o700 });
    const child = spawn(
      this.chromePath,
      [
        `--user-data-dir=${profileDirectory}`,
        "--new-window",
        "--disable-background-mode",
        "--no-first-run",
        "--no-default-browser-check",
        CHATGPT_TEMPORARY_CHAT_URL,
      ],
      { env: process.env, stdio: "ignore" },
    );
    const active: ActiveLogin = {
      child,
      transferRoot,
      profileDirectory,
      stopping: false,
    };
    this.#active = active;
    this.#phase = "waiting";
    this.#error = undefined;
    child.once("error", (error) => {
      active.earlyExit = error;
      this.#error = error.message;
    });
    child.once("exit", (code, signal) => {
      if (active.stopping) return;
      active.earlyExit = new Error(
        signal
          ? `Dedicated Chrome passkey login exited from signal ${signal}.`
          : `Dedicated Chrome passkey login closed before Continue (status ${code ?? 0}).`,
      );
      this.#error = active.earlyExit.message;
    });
    return this.status();
  }

  async continue(): Promise<PasskeyLoginState> {
    const active = this.#active;
    if (!active || this.#phase !== "waiting") {
      throw new Error("No passkey-assisted login is waiting for Continue.");
    }
    this.#phase = "importing";
    this.#error = undefined;
    try {
      if (active.earlyExit || exited(active.child)) {
        throw (
          active.earlyExit ??
          new Error("Dedicated Chrome closed before Continue was selected.")
        );
      }
      active.stopping = true;
      await stopOwnedChrome(active.child);
      await removeChromeTabSessions(active.profileDirectory);
      return await this.#captureOffline(active.profileDirectory);
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      active.stopping = true;
      await stopOwnedChrome(active.child).catch(() => undefined);
      await rm(active.transferRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (this.#active === active) this.#active = undefined;
      this.#phase = "idle";
    }
  }

  async close(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    active.stopping = true;
    await stopOwnedChrome(active.child).catch(() => undefined);
    await rm(active.transferRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
    if (this.#active === active) this.#active = undefined;
    this.#phase = "idle";
  }

  async #captureOffline(profileDirectory: string): Promise<PasskeyLoginState> {
    let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(profileDirectory, {
        executablePath: this.chromePath,
        headless: true,
        chromiumSandbox: true,
        offline: true,
        serviceWorkers: "block",
        ignoreDefaultArgs: [
          "--no-sandbox",
          "--enable-automation",
          "--password-store=basic",
          "--use-mock-keychain",
        ],
        args: [
          "--disable-background-mode",
          "--disable-background-networking",
          "--no-first-run",
          "--no-default-browser-check",
          "--restore-last-session",
        ],
        timeout: 30_000,
      });
      await context.setOffline(true);
      await context.route("**/*", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: '<!doctype html><meta charset="utf-8"><title>Private passkey-state capture</title>',
        }),
      );
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      if (new URL(page.url()).origin !== "https://chatgpt.com") {
        throw new Error(
          "Offline passkey-state capture reached an unexpected origin.",
        );
      }
      return validatePasskeyLoginState(await context.storageState());
    } finally {
      await context?.close().catch(() => undefined);
    }
  }
}
