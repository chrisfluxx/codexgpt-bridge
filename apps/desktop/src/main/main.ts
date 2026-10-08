import { createHash, randomBytes } from "node:crypto";
import { parseAdvancedSettings } from "./advanced-settings.js";
import { ManualTurns } from "./manual-turns.js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell,
} from "electron";
import {
  CODEXGPT_BRIDGE_WEB_MODEL_ROUTES,
  bridgeCatalogNativeFamilies,
  bridgeCatalogWebModes,
  FullTurnBroker,
  LunaCheckpointStore,
  FullTurnMcpServer,
  ResponsesGateway,
  buildStartupModelsPayload,
  buildWebOnlyModelsPayload,
  type BridgeAccountContextProfile,
  type BridgeWebMode,
  type BridgeNativeModelFamily,
  type ResponsesGatewayAddress,
} from "@codexgpt-bridge/responses-gateway";
import type { DesktopSettings, WebProviderStatus } from "./preload.cjs";
import { retireWorkspaceService } from "./retired-workspace-service.js";
import { ChatGptBrowserController } from "./chatgpt-browser.js";
import { ChromeChatGptHost } from "./chrome-chatgpt-window.js";
import { ChatGptVerificationRequiredError } from "./chatgpt-page-access.js";
import { MacOsPasskeyLogin } from "./macos-passkey-login.js";
import type { BrowserSmokeResult } from "./browser-smoke.js";
import { resolveCodexProjectName } from "./codex-projects.js";
import { readCodexThreadTitle } from "./codex-thread-title.js";
import { parseChatGptProjectSettings } from "./chatgpt-projects.js";
import { discoverCodexCliExecutables } from "./codex-cli.js";
import { WebOnlyIntegration } from "./web-only-integration.js";
import {
  planProviderRepair,
  type ProviderRepairPlan,
} from "./provider-repair.js";
import {
  normalizeOriginalProviderBaseUrl,
  originalProviderBaseUrlFromConfig,
  parseOriginalProviderAssignment,
} from "./provider-upstream.js";
import { ModelReceiptStore } from "./model-receipts.js";
import { ChatGptUsageStore } from "./chatgpt-usage.js";
import { CompletionDiagnosticStore } from "./completion-diagnostics.js";
import { installMainProcessErrorBoundary } from "./transport-error-boundary.js";
import {
  codexInterruptHookCommand,
  installCodexInterruptHook,
  isCodexInterruptHookFullyAbsent,
  reinstallCodexInterruptHook,
  restoreCodexInterruptHook,
  verifyCodexInterruptHook,
  type InstalledCodexInterruptHook,
} from "./codex-interrupt-hook.js";
import {
  ProviderControlStore,
  type ProviderControlMetadata,
} from "./provider-control.js";
import {
  TunnelManager,
  type FullMcpTunnelSettings,
  type FullMcpTunnelStatus,
} from "./tunnel-manager.js";
import {
  normalizeUpdateManifestUrl,
  ReleaseUpdateManager,
} from "./release-update.js";
import { BUNDLED_UPDATE_MANIFEST_URL } from "./release-channel.generated.js";
import {
  runDesktopDoctor,
  type DesktopDoctorReport,
} from "./desktop-doctor.js";
import { BridgeSystemTray } from "./system-tray.js";
import { bridgeAppIcon } from "./app-icon.js";
import { UpdateReminders } from "./update-reminders.js";
import { probeChatGptPageSession } from "./chatgpt-session-probe.js";
import { importStartupChatGptSession } from "./startup-session-handoff.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const developmentProfile =
  process.env.CODEXGPT_BRIDGE_PROFILE === "dev" ||
  process.argv.includes("--dev");
if (process.platform === "win32") {
  const originalUserDataDirectory = app.getPath("userData");
  app.setName("CodexGPT Bridge");
  app.setPath("userData", originalUserDataDirectory);
}
// Some Windows display drivers lose the Chromium compositor while the DOM and
// IPC remain healthy, leaving an empty main window. Configure software rendering
// before app readiness so reopening the window does not reuse that compositor.
if (process.platform === "win32") app.disableHardwareAcceleration();
if (developmentProfile) {
  app.setPath("userData", `${app.getPath("userData")}-dev`);
  app.setName("CodexGPT Bridge DEV");
}
const e2eUserDataDirectory = process.env.CODEXGPT_BRIDGE_E2E_USER_DATA_DIR;
if (e2eUserDataDirectory !== undefined) {
  if (!isAbsolute(e2eUserDataDirectory)) {
    throw new Error("CODEXGPT_BRIDGE_E2E_USER_DATA_DIR must be absolute.");
  }
  app.setPath("userData", e2eUserDataDirectory);
}
// E2E profiles are isolated by an explicit absolute userData directory and
// dedicated ports. They must not be redirected to a user's installed Bridge.
const ownsSingleInstance =
  e2eUserDataDirectory !== undefined || app.requestSingleInstanceLock();
if (!ownsSingleInstance) app.quit();
installMainProcessErrorBoundary({
  onPeerDisconnect: (error) => {
    // A local Codex/MCP client may reset a completed or superseded stream.
    // This is a connection lifecycle event, not a fatal desktop failure.
    console.warn("Bridge peer disconnected", error);
  },
  onUnexpectedError: (error) => {
    console.error("Bridge main process failed", error);
    app.exit(1);
  },
});
const DEFAULT_SETTINGS: DesktopSettings = {
  locale: preferredUiLocale(),
  chatGptProjects: { enabled: false },
  temporaryChat: false,
  interactionMode: "automatic",
  webToolMode: "full",
  fullMcpConnectorName: "CodexGPT Bridge",
};

function preferredUiLocale(value?: unknown): DesktopSettings["locale"] {
  if (
    value === "en" ||
    value === "zh-TW" ||
    value === "zh-CN" ||
    value === "ja" ||
    value === "ko"
  )
    return value;
  const system = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
  if (/^zh-(?:cn|sg|hans)(?:-|$)/u.test(system)) return "zh-CN";
  if (system.startsWith("zh")) return "zh-TW";
  if (system.startsWith("ja")) return "ja";
  if (system.startsWith("ko")) return "ko";
  return "en";
}

let mainWindow: BrowserWindow | undefined;
let systemTray: BridgeSystemTray | undefined;
let focusUpdatePending = false;
let responsesGateway: ResponsesGateway | undefined;
let responsesAddress: ResponsesGatewayAddress | undefined;
let responsesStartupError: string | undefined;
const providerControlStore = new ProviderControlStore(
  join(app.getPath("userData"), "provider-control.json"),
);
let providerControlMetadata: ProviderControlMetadata | undefined;
const fullTurnBroker = new FullTurnBroker();
const manualTurns = new ManualTurns(fullTurnBroker);
const fullTurnMcpServer = new FullTurnMcpServer(
  fullTurnBroker,
  (token, text) => manualTurns.complete(token, text),
  (token) => manualTurns.assertSent(token),
);
const tunnelManager = new TunnelManager(app.getPath("userData"));
let fullMcpAddress: Awaited<ReturnType<FullTurnMcpServer["start"]>> | undefined;
let fullMcpTunnelStatus: FullMcpTunnelStatus | undefined;
const modelReceipts = new ModelReceiptStore(
  join(app.getPath("userData"), "model-executions.json"),
);
const chatGptUsage = new ChatGptUsageStore(
  join(app.getPath("userData"), "chatgpt-accepted-usage.json"),
);
const environmentUpdateManifestUrl = normalizeUpdateManifestUrl(
  process.env.CODEXGPT_BRIDGE_UPDATE_MANIFEST_URL,
);
const bundledUpdateManifestUrl = normalizeUpdateManifestUrl(
  BUNDLED_UPDATE_MANIFEST_URL,
);
const managedUpdateManifestUrl =
  environmentUpdateManifestUrl ?? bundledUpdateManifestUrl;
function trustedUpdateManifestPublicKey(): string | undefined {
  const path = process.env.CODEXGPT_BRIDGE_UPDATE_PUBLIC_KEY_FILE?.trim();
  if (!path) return undefined;
  if (!isAbsolute(path))
    throw new Error("CODEXGPT_BRIDGE_UPDATE_PUBLIC_KEY_FILE must be absolute.");
  const value = readFileSync(path, "utf8");
  if (value.length === 0 || value.length > 16_384)
    throw new Error("Update manifest public key is invalid.");
  return value;
}
const environmentUpdateManifestPublicKey = trustedUpdateManifestPublicKey();
const portableReleaseDirectory = dirname(dirname(app.getPath("exe")));
const isWinUnpackedBuild =
  app.isPackaged && basename(dirname(app.getPath("exe"))) === "win-unpacked";
const portableReleaseManifests = [
  join(portableReleaseDirectory, "release-manifest.json"),
  ...(basename(dirname(portableReleaseDirectory)) === "release"
    ? [join(dirname(portableReleaseDirectory), "release-manifest.json")]
    : []),
];
const localReleaseManifestPath =
  e2eUserDataDirectory !== undefined
    ? process.env.CODEXGPT_BRIDGE_E2E_UPDATE_MANIFEST_PATH
    : isWinUnpackedBuild
      ? (portableReleaseManifests.find(existsSync) ??
        portableReleaseManifests[0])
      : undefined;
const releaseUpdates = new ReleaseUpdateManager(
  app.getVersion(),
  join(app.getPath("userData"), "updates"),
  managedUpdateManifestUrl,
  process.platform,
  process.arch,
  environmentUpdateManifestPublicKey,
  localReleaseManifestPath,
);
const updateReminders = new UpdateReminders(
  releaseUpdates,
  join(app.getPath("userData"), "update-notifications.json"),
  (status) => systemTray?.setUpdateStatus(status),
  (version) => systemTray?.notifyUpdate(version) ?? false,
);
const completionDiagnostics = new CompletionDiagnosticStore(
  join(app.getPath("userData"), "completion-diagnostics.json"),
);
const webOnlyIntegration = new WebOnlyIntegration(
  codexHome(),
  app.getPath("userData"),
  currentCodexInterruptHookCommand(),
);
let providerMutation: Promise<unknown> = Promise.resolve();
function mutateProvider<T>(action: () => Promise<T>): Promise<T> {
  const result = providerMutation.then(action);
  providerMutation = result.catch(() => undefined);
  return result;
}
const chromeChatGptHost = new ChromeChatGptHost(
  join(app.getPath("userData"), "chrome-chatgpt-profile"),
  undefined,
  true,
);
function createChatGptBrowser(): ChatGptBrowserController {
  return new ChatGptBrowserController(
    process.env.CODEXGPT_BRIDGE_E2E_CHATGPT_URL?.trim() || undefined,
    join(app.getPath("userData"), "chatgpt-conversations.json"),
    (receipt) => modelReceipts.record(receipt),
    (record) => completionDiagnostics.record(record),
    (threadId) => readCodexThreadTitle(codexHome(), threadId),
    (accepted) => chatGptUsage.recordAccepted(accepted),
    async (options, purpose) =>
      (await loadSettings()).chatGptBrowserHost === "chrome"
        ? chromeChatGptHost.createWindow(options, purpose)
        : new BrowserWindow(options),
  );
}
let chatGptBrowser = createChatGptBrowser();
let chromeLoginVerifying = false;
let chromeVerificationPending = false;
async function restoreChromeLogin(): Promise<void> {
  if ((await loadSettings()).interactionMode === "manual") return;
  if ((await loadSettings()).chatGptBrowserHost !== "chrome") return;
  chromeLoginVerifying = true;
  try {
    if (!(await chromeChatGptHost.restoreSavedLogin())) return;
    await chatGptBrowser.refreshUsageAccount();
    chromeChatGptHost.confirmVerifiedLogin();
  } catch (error) {
    chromeChatGptHost.invalidateVerifiedLogin();
    if (error instanceof ChatGptVerificationRequiredError) {
      chromeVerificationPending = true;
    } else {
      await chatGptBrowser.close();
      await chromeChatGptHost.close();
      chatGptBrowser = createChatGptBrowser();
      console.warn(
        "Saved Chrome session could not be verified; sign in again.",
      );
    }
  } finally {
    chromeLoginVerifying = false;
  }
}
const passkeyLogin = new MacOsPasskeyLogin(app.getPath("userData"));
let browserSmokeResult: BrowserSmokeResult | undefined;
let browserSmokePassedAt: string | undefined;
let browserSmokeRunning = false;
let browserSmokeError: string | undefined;

const CODEX_PROVIDER_START = "# >>> CodexGPT Bridge managed Web provider";
const CODEX_PROVIDER_END = "# <<< CodexGPT Bridge managed Web provider";

interface CodexProviderIntegrationJournalV1 {
  readonly version: 1;
  readonly configPath: string;
  readonly baseUrl: string;
  readonly blockHash: string;
  readonly createdConfig: boolean;
}

interface CodexProviderIntegrationJournalV2 {
  readonly version: 2;
  readonly configPath: string;
  readonly baseUrl: string;
  readonly blockHash: string;
  readonly createdConfig: boolean;
  readonly replacedOpenAiBaseUrl: string;
}

interface CodexProviderIntegrationJournalV3 {
  readonly version: 3;
  readonly configPath: string;
  readonly baseUrl: string;
  readonly catalogPath: string;
  readonly catalogHash: string;
  readonly blockHash: string;
  readonly createdConfig: boolean;
  readonly replacedOpenAiBaseUrl: string;
  readonly replacedModelCatalogJson: string;
}

interface CodexProviderIntegrationJournalV4 {
  readonly version: 4;
  readonly configPath: string;
  readonly baseUrl: string;
  readonly upstreamBaseUrl: string | null;
  readonly catalogPath: string;
  readonly catalogHash: string;
  readonly blockHash: string;
  readonly createdConfig: boolean;
  readonly replacedOpenAiBaseUrl: string;
  readonly replacedModelCatalogJson: string;
}

interface CodexProviderIntegrationJournalV5 {
  readonly version: 5;
  readonly configPath: string;
  readonly baseUrl: string;
  readonly upstreamBaseUrl: string | null;
  readonly catalogPath: string;
  readonly catalogHash: string;
  readonly blockHash: string;
  readonly createdConfig: boolean;
  readonly replacedOpenAiBaseUrl: string;
  readonly replacedModelCatalogJson: string;
  readonly interruptHook: InstalledCodexInterruptHook;
}

type CodexProviderIntegrationJournal =
  | CodexProviderIntegrationJournalV1
  | CodexProviderIntegrationJournalV2
  | CodexProviderIntegrationJournalV3
  | CodexProviderIntegrationJournalV4
  | CodexProviderIntegrationJournalV5;

function hasManagedProviderCatalog(
  journal: CodexProviderIntegrationJournal | undefined,
): journal is
  | CodexProviderIntegrationJournalV3
  | CodexProviderIntegrationJournalV4
  | CodexProviderIntegrationJournalV5 {
  return (
    journal?.version === 3 || journal?.version === 4 || journal?.version === 5
  );
}

function originalProviderBaseUrlFromJournal(
  journal: CodexProviderIntegrationJournal,
): string | undefined {
  if (journal.version === 4 || journal.version === 5) {
    return journal.upstreamBaseUrl === null
      ? undefined
      : normalizeOriginalProviderBaseUrl(
          journal.upstreamBaseUrl,
          journal.baseUrl,
        );
  }
  if (journal.version === 2 || journal.version === 3) {
    return parseOriginalProviderAssignment(
      journal.replacedOpenAiBaseUrl,
      journal.baseUrl,
    );
  }
  return undefined;
}

function settingsPath(): string {
  return join(app.getPath("userData"), "desktop-settings.json");
}

function tunnelRuntimeSecretsDirectory(): string {
  return join(app.getPath("userData"), "secrets");
}

async function saveTunnelRuntimeApiKey(apiKey: string): Promise<string> {
  const directory = tunnelRuntimeSecretsDirectory();
  await mkdir(directory, { recursive: true });
  const path = join(
    directory,
    `tunnel-runtime-${randomBytes(8).toString("hex")}.key`,
  );
  await writeFile(path, `${apiKey}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return path;
}

async function removeManagedTunnelRuntimeApiKey(
  path: string | undefined,
): Promise<void> {
  if (!path) return;
  const directory = resolve(tunnelRuntimeSecretsDirectory());
  const resolvedPath = resolve(path);
  if (
    dirname(resolvedPath) === directory &&
    /^tunnel-runtime-[a-f0-9]{16}\.key$/u.test(
      resolvedPath.slice(directory.length + 1),
    )
  ) {
    await rm(resolvedPath, { force: true });
  }
}

function codexProviderIntegrationJournalPath(): string {
  return join(app.getPath("userData"), "codex-provider-integration.json");
}

function codexHome(): string {
  if (developmentProfile) {
    const directory = process.env.CODEXGPT_BRIDGE_DEV_CODEX_HOME;
    if (directory && !isAbsolute(directory))
      throw new Error("DEV Codex home must be absolute.");
    return directory || join(homedir(), ".codexgpt-bridge-dev");
  }
  const configured = process.env.CODEX_HOME?.trim();
  return configured === undefined || configured.length === 0
    ? join(homedir(), ".codex")
    : resolve(configured);
}

function codexConfigPath(): string {
  return join(codexHome(), "config.toml");
}

function codexModelsCachePath(): string {
  return join(codexHome(), "models_cache.json");
}

function codexManagedModelCatalogPath(): string {
  return join(codexHome(), "codexgpt-bridge-models.json");
}

function currentCodexInterruptHookCommand(): string {
  return codexInterruptHookCommand({
    executablePath: process.execPath,
    hookScriptPath: join(moduleDirectory, "provider-hook-cli.js"),
    metadataPath: providerControlStore.path,
  });
}

function desktopResponsesPort(): number {
  const raw = process.env.CODEXGPT_BRIDGE_RESPONSES_PORT;
  if (raw === undefined) return developmentProfile ? 7769 : 7767;
  const port = Number.parseInt(raw, 10);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("CODEXGPT_BRIDGE_RESPONSES_PORT must be a valid TCP port.");
  }
  return port;
}

function desktopFullMcpPort(): number {
  const raw = process.env.CODEXGPT_BRIDGE_FULL_MCP_PORT;
  if (raw === undefined) return 0;
  const port = Number.parseInt(raw, 10);
  if (
    !/^\d+$/u.test(raw) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("CODEXGPT_BRIDGE_FULL_MCP_PORT must be a valid TCP port.");
  }
  return port;
}

async function loadSettings(): Promise<DesktopSettings> {
  try {
    const raw = JSON.parse(
      await readFile(settingsPath(), "utf8"),
    ) as Partial<DesktopSettings>;
    const updateManifestUrl = normalizeUpdateManifestUrl(raw.updateManifestUrl);
    const updateManifestPath =
      typeof raw.updateManifestPath === "string" &&
      raw.updateManifestPath.length <= 2048 &&
      isAbsolute(raw.updateManifestPath)
        ? raw.updateManifestPath
        : undefined;
    return {
      ...parseAdvancedSettings(raw),
      locale: preferredUiLocale(raw.locale),
      temporaryChat: raw.temporaryChat === true,
      chatGptBrowserHost:
        raw.chatGptBrowserHost === "chrome" ? "chrome" : "embedded",
      chatGptProjects: parseChatGptProjectSettings(raw.chatGptProjects),
      webToolMode:
        raw.webToolMode === "simple" ? "simple" : DEFAULT_SETTINGS.webToolMode,
      fullMcpConnectorName:
        typeof raw.fullMcpConnectorName === "string" &&
        raw.fullMcpConnectorName.trim().length > 0
          ? raw.fullMcpConnectorName.trim()
          : "CodexGPT Bridge",
      ...(typeof raw.fullMcpTunnelId === "string" && raw.fullMcpTunnelId.trim()
        ? { fullMcpTunnelId: raw.fullMcpTunnelId.trim() }
        : {}),
      ...(typeof raw.fullMcpRuntimeKeyFile === "string" &&
      raw.fullMcpRuntimeKeyFile.trim()
        ? { fullMcpRuntimeKeyFile: raw.fullMcpRuntimeKeyFile.trim() }
        : {}),
      ...(typeof raw.fullMcpTunnelClientPath === "string" &&
      raw.fullMcpTunnelClientPath.trim()
        ? { fullMcpTunnelClientPath: raw.fullMcpTunnelClientPath.trim() }
        : {}),
      ...(updateManifestUrl ? { updateManifestUrl } : {}),
      ...(updateManifestPath ? { updateManifestPath } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return DEFAULT_SETTINGS;
    throw error;
  }
}

async function saveSettings(settings: DesktopSettings): Promise<void> {
  const path = settingsPath();
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await replaceFileWithRetry(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function replaceFileWithRetry(
  temporary: string,
  destination: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        (code !== "EPERM" && code !== "EACCES") ||
        attempt >= 7
      )
        throw error;
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, Math.min(10 * 2 ** attempt, 250)),
      );
    }
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function readTextIfPresent(
  path: string,
): Promise<{ readonly exists: boolean; readonly text: string }> {
  try {
    return { exists: true, text: await readFile(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { exists: false, text: "" };
    throw error;
  }
}

async function atomicWriteText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
  try {
    await replaceFileWithRetry(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function runCodexModelsCommand(
  command: string,
  args: readonly string[],
  description: string,
): Promise<unknown> {
  return await new Promise<unknown>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const maxOutput = 16 * 1024 * 1024;
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (next.length > maxOutput) {
        child.kill();
        throw new Error("Codex model catalog output is too large.");
      }
      return next;
    };
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(
        new Error("Timed out while reading the Codex model catalog."),
      );
    }, 15_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      try {
        stdout = append(stdout, chunk);
      } catch (error) {
        rejectPromise(error);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      try {
        stderr = append(stderr, chunk);
      } catch (error) {
        rejectPromise(error);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectPromise(
          new Error(
            `${description} failed with exit code ${code ?? "unknown"}: ${stderr.trim() || "no stderr"}`,
          ),
        );
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout) as unknown);
      } catch (error) {
        rejectPromise(
          new Error(
            `Codex model catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  });
}

async function runCodexModels(bundled: boolean): Promise<unknown> {
  const injected = bundled
    ? process.env.CODEXGPT_BRIDGE_E2E_NATIVE_MODELS_JSON
    : process.env.CODEXGPT_BRIDGE_E2E_EXISTING_MODELS_JSON;
  if (injected !== undefined) return JSON.parse(injected) as unknown;

  const modelArgs = ["debug", "models", ...(bundled ? ["--bundled"] : [])];
  const failures: string[] = [];
  for (const executable of await discoverCodexCliExecutables()) {
    try {
      return await runCodexModelsCommand(executable, modelArgs, executable);
    } catch (error) {
      failures.push(
        `${executable}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const debugCommand = `codex ${modelArgs.join(" ")}`;
  const windows = process.platform === "win32";
  try {
    return await runCodexModelsCommand(
      windows ? process.env.ComSpec?.trim() || "cmd.exe" : "codex",
      windows ? ["/d", "/s", "/c", debugCommand] : modelArgs,
      debugCommand,
    );
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    throw new Error(
      `Unable to read the Codex model catalog. ${failures.join(" | ")}`,
      { cause: error },
    );
  }
}

function parseModelsCatalog(text: string, source: string): unknown {
  const parsed = JSON.parse(text) as unknown;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).models)
  ) {
    throw new Error(`${source} is missing a models array.`);
  }
  return parsed;
}

async function preInstallCodexModelCatalog(): Promise<unknown> {
  const injected = process.env.CODEXGPT_BRIDGE_E2E_EXISTING_MODELS_JSON;
  if (injected !== undefined) {
    return parseModelsCatalog(
      injected,
      "Injected existing Codex model catalog",
    );
  }

  // Resolve the active catalog with the Desktop-managed Codex CLI first. A different, older CLI
  // may also be present on PATH and can expose an obsolete bundled catalog that omits new models.
  try {
    return await runCodexModels(false);
  } catch {
    // Fall through to the last effective cache, then the current Desktop bundled catalog.
  }

  // Reuse the exact merged native and Web metadata in Codex's current model
  // cache: rebuilding chatgpt-web/* from a native template can
  // change multi_agent_version, priorities, context limits, and tool metadata.
  const cached = await readTextIfPresent(codexModelsCachePath());
  if (cached.exists) {
    try {
      return parseModelsCatalog(cached.text, "Codex model cache");
    } catch {
      // A corrupt/stale cache must not block installation; let Codex resolve the active catalog.
    }
  }

  return await runCodexModels(true);
}

function bridgeWebModesInCatalog(payload: unknown): readonly BridgeWebMode[] {
  return bridgeCatalogWebModes(payload);
}

async function configuredNativeModelFamilies(): Promise<
  readonly BridgeNativeModelFamily[]
> {
  const webOnly = await webOnlyIntegration.status();
  if (webOnly.managed)
    return bridgeCatalogNativeFamilies(await webOnlyIntegration.models());
  const journal = await loadCodexProviderIntegrationJournal();
  if (!hasManagedProviderCatalog(journal)) return [];
  const catalog = await readTextIfPresent(journal.catalogPath);
  if (!catalog.exists || sha256(catalog.text) !== journal.catalogHash)
    throw new Error(
      "The installed Bridge model catalog no longer matches its ownership journal.",
    );
  return bridgeCatalogNativeFamilies(
    parseModelsCatalog(catalog.text, "managed Codex model catalog"),
  );
}

async function probeNativeModelFamilies(): Promise<
  readonly BridgeNativeModelFamily[]
> {
  if ((await loadSettings()).interactionMode === "manual")
    return ["5.6", "6", "6.1"];
  if (process.env.CODEXGPT_BRIDGE_E2E_AVAILABLE_WEB_MODES_JSON !== undefined) {
    const families: unknown = JSON.parse(
      process.env.CODEXGPT_BRIDGE_E2E_NATIVE_MODEL_FAMILIES_JSON ?? "[]",
    );
    if (
      !Array.isArray(families) ||
      families.some(
        (family) => family !== "5.6" && family !== "6" && family !== "6.1",
      )
    )
      throw new Error("Injected native model family capabilities are invalid.");
    return [...new Set(families)] as BridgeNativeModelFamily[];
  }
  return chatGptBrowser.probeNativeModelFamilies();
}

async function configuredBridgeWebModes(): Promise<
  readonly BridgeWebMode[] | undefined
> {
  const settings = await loadSettings();
  if (settings.interactionMode === "manual") return manualWebModes(settings);
  const webOnly = await webOnlyIntegration.status();
  if (webOnly.managed) {
    return bridgeWebModesInCatalog(await webOnlyIntegration.models());
  }
  const journal = await loadCodexProviderIntegrationJournal();
  if (!hasManagedProviderCatalog(journal)) return undefined;
  const catalog = await readTextIfPresent(journal.catalogPath);
  if (!catalog.exists || sha256(catalog.text) !== journal.catalogHash) {
    throw new Error(
      "The installed Bridge model catalog no longer matches its ownership journal.",
    );
  }
  return bridgeWebModesInCatalog(
    parseModelsCatalog(catalog.text, "managed Codex model catalog"),
  );
}

async function probeSupportedBridgeModes(): Promise<readonly BridgeWebMode[]> {
  const settings = await loadSettings();
  if (settings.interactionMode === "manual") return manualWebModes(settings);
  const injected = process.env.CODEXGPT_BRIDGE_E2E_AVAILABLE_WEB_MODES_JSON;
  if (injected !== undefined) {
    const parsed = JSON.parse(injected) as unknown;
    const known = new Set<string>(
      CODEXGPT_BRIDGE_WEB_MODEL_ROUTES.map((route) => route.mode),
    );
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some((mode) => typeof mode !== "string" || !known.has(mode))
    ) {
      throw new Error("Injected ChatGPT account capabilities are invalid.");
    }
    return [...new Set(parsed)] as BridgeWebMode[];
  }
  const capabilities = await chatGptBrowser.probeCapabilities();
  if (capabilities.availableModes.length > 0)
    return capabilities.availableModes;
  throw new Error(
    "ChatGPT did not expose any supported Web model modes, so no Web models were installed.",
  );
}

async function writeManagedModelCatalog(
  availableModes: readonly BridgeWebMode[],
): Promise<{
  readonly path: string;
  readonly hash: string;
}> {
  const existingCatalog = await preInstallCodexModelCatalog();
  const catalog = buildStartupModelsPayload(
    existingCatalog,
    availableModes,
    await configuredContextProfile(availableModes),
    await probeNativeModelFamilies(),
    (await loadSettings()).webToolMode === "full" ? true : "simple",
  );
  const text = `${JSON.stringify(catalog, null, 2)}\n`;
  const path = codexManagedModelCatalogPath();
  await atomicWriteText(path, text);
  return { path, hash: sha256(text) };
}

async function configuredContextProfile(
  modes?: readonly BridgeWebMode[],
): Promise<BridgeAccountContextProfile> {
  const settings = await loadSettings();
  if (settings.interactionMode === "manual")
    return settings.manualPro ? "pro" : "standard";
  const available = modes ?? (await configuredBridgeWebModes());
  return available?.includes("pro") ? "pro" : "standard";
}

function lineEndingFor(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function managedProviderBlock(
  baseUrl: string,
  catalogPath: string,
  lineEnding: "\r\n" | "\n",
): string {
  return [
    CODEX_PROVIDER_START,
    `openai_base_url = ${JSON.stringify(baseUrl)}`,
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    CODEX_PROVIDER_END,
    "",
  ].join(lineEnding);
}

function findManagedProviderBlock(
  text: string,
):
  | { readonly start: number; readonly end: number; readonly block: string }
  | undefined {
  const start = text.indexOf(CODEX_PROVIDER_START);
  if (start === -1) return undefined;
  if (
    text.indexOf(CODEX_PROVIDER_START, start + CODEX_PROVIDER_START.length) !==
    -1
  ) {
    throw new Error(
      "Codex config contains multiple CodexGPT Bridge provider markers.",
    );
  }
  if (start > 0 && text[start - 1] !== "\n") {
    throw new Error("CodexGPT Bridge provider marker is not on its own line.");
  }
  const markerEnd = text.indexOf(
    CODEX_PROVIDER_END,
    start + CODEX_PROVIDER_START.length,
  );
  if (markerEnd === -1) {
    throw new Error("CodexGPT Bridge managed provider block is incomplete.");
  }
  let end = markerEnd + CODEX_PROVIDER_END.length;
  if (text.slice(end, end + 2) === "\r\n") end += 2;
  else if (text[end] === "\n") end += 1;
  return { start, end, block: text.slice(start, end) };
}

function findTopLevelAssignment(
  text: string,
  key: "openai_base_url" | "model_catalog_json",
):
  | { readonly start: number; readonly end: number; readonly text: string }
  | undefined {
  const linePattern = /[^\r\n]*(?:\r\n|\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(text)) !== null) {
    if (match[0].length === 0) break;
    const line = match[0].replace(/\r?\n$/, "");
    if (/^\s*\[/.test(line)) return undefined;
    const assignment = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
    if (assignment?.[1] === key) {
      return {
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
      };
    }
  }
  return undefined;
}

function findTopLevelOpenAiBaseUrl(
  text: string,
):
  | { readonly start: number; readonly end: number; readonly text: string }
  | undefined {
  return findTopLevelAssignment(text, "openai_base_url");
}

function findTopLevelModelCatalogJson(
  text: string,
):
  | { readonly start: number; readonly end: number; readonly text: string }
  | undefined {
  return findTopLevelAssignment(text, "model_catalog_json");
}

function originalProviderBaseUrlBeforeBridge(
  journal: CodexProviderIntegrationJournal | undefined,
  config: string,
  managed: { readonly start: number; readonly end: number } | undefined,
  bridgeBaseUrl: string,
): string | undefined {
  if (journal !== undefined) {
    const saved = originalProviderBaseUrlFromJournal(journal);
    if (saved !== undefined || journal.version === 4) return saved;
    // V1-V3 did not record custom model_providers.<id>.base_url. Recover it from
    // the untouched settings surrounding the managed block during migration.
    const unwrapped =
      managed === undefined
        ? config
        : config.slice(0, managed.start) + config.slice(managed.end);
    return originalProviderBaseUrlFromConfig(unwrapped, bridgeBaseUrl);
  }
  return originalProviderBaseUrlFromConfig(config, bridgeBaseUrl);
}

async function configuredOriginalProviderBaseUrl(): Promise<
  string | undefined
> {
  const injected = process.env.CODEXGPT_BRIDGE_E2E_CODEX_UPSTREAM?.trim();
  const bridgeBaseUrl = `http://127.0.0.1:${desktopResponsesPort()}/v1`;
  if (injected) {
    return normalizeOriginalProviderBaseUrl(injected, bridgeBaseUrl);
  }
  const journal = await loadCodexProviderIntegrationJournal();
  const configPath = journal?.configPath ?? codexConfigPath();
  const config = await readTextIfPresent(configPath);
  return originalProviderBaseUrlBeforeBridge(
    journal,
    config.text,
    config.exists ? findManagedProviderBlock(config.text) : undefined,
    journal?.baseUrl ?? bridgeBaseUrl,
  );
}

async function loadCodexProviderIntegrationJournal(): Promise<
  CodexProviderIntegrationJournal | undefined
> {
  try {
    const raw = JSON.parse(
      await readFile(codexProviderIntegrationJournalPath(), "utf8"),
    ) as Partial<CodexProviderIntegrationJournal>;
    const commonValid =
      typeof raw.configPath === "string" &&
      typeof raw.baseUrl === "string" &&
      typeof raw.blockHash === "string" &&
      typeof raw.createdConfig === "boolean";
    const valid =
      commonValid &&
      (raw.version === 1 ||
        (raw.version === 2 &&
          typeof (raw as Partial<CodexProviderIntegrationJournalV2>)
            .replacedOpenAiBaseUrl === "string") ||
        ((raw.version === 3 || raw.version === 4 || raw.version === 5) &&
          typeof (raw as Partial<CodexProviderIntegrationJournalV4>)
            .replacedOpenAiBaseUrl === "string" &&
          typeof (raw as Partial<CodexProviderIntegrationJournalV4>)
            .replacedModelCatalogJson === "string" &&
          typeof (raw as Partial<CodexProviderIntegrationJournalV4>)
            .catalogPath === "string" &&
          typeof (raw as Partial<CodexProviderIntegrationJournalV4>)
            .catalogHash === "string" &&
          (raw.version === 3 ||
            (raw as Partial<CodexProviderIntegrationJournalV4>)
              .upstreamBaseUrl === null ||
            typeof (raw as Partial<CodexProviderIntegrationJournalV4>)
              .upstreamBaseUrl === "string") &&
          (raw.version !== 5 ||
            isInstalledInterruptHook(
              (raw as Partial<CodexProviderIntegrationJournalV5>).interruptHook,
            ))));
    if (!valid) {
      throw new Error("Stored Codex Web provider journal is invalid.");
    }
    return raw as CodexProviderIntegrationJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isInstalledInterruptHook(
  value: unknown,
): value is InstalledCodexInterruptHook {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const hook = value as Record<string, unknown>;
  return (
    typeof hook.command === "string" &&
    Number.isInteger(hook.groupIndex) &&
    (hook.groupIndex as number) >= 0 &&
    typeof hook.stateKey === "string" &&
    typeof hook.trustedHash === "string" &&
    typeof hook.fragment === "string"
  );
}

async function saveCodexProviderIntegrationJournal(
  journal: CodexProviderIntegrationJournal,
): Promise<void> {
  await atomicWriteText(
    codexProviderIntegrationJournalPath(),
    `${JSON.stringify(journal, null, 2)}\n`,
  );
}

async function invalidateCodexModelCache(): Promise<void> {
  await rm(codexModelsCachePath(), { force: true }).catch(() => undefined);
}

async function refreshOwnedCodexModelCatalog(
  nativeFamilies?: readonly BridgeNativeModelFamily[],
  modes?: readonly BridgeWebMode[],
): Promise<void> {
  const journal = await loadCodexProviderIntegrationJournal();
  if (!hasManagedProviderCatalog(journal)) return;
  const config = await readTextIfPresent(journal.configPath);
  const managed = config.exists
    ? findManagedProviderBlock(config.text)
    : undefined;
  if (managed === undefined || sha256(managed.block) !== journal.blockHash) {
    return;
  }
  const current = await readTextIfPresent(journal.catalogPath);
  if (!current.exists || sha256(current.text) !== journal.catalogHash) return;

  const currentPayload = parseModelsCatalog(
    current.text,
    "managed Codex model catalog",
  );
  const catalog = buildStartupModelsPayload(
    currentPayload,
    modes ?? bridgeWebModesInCatalog(currentPayload),
    await configuredContextProfile(
      modes ?? bridgeWebModesInCatalog(currentPayload),
    ),
    nativeFamilies,
    (await loadSettings()).webToolMode === "full" ? true : "simple",
  );
  const text = `${JSON.stringify(catalog, null, 2)}\n`;
  if (text === current.text) return;
  await atomicWriteText(journal.catalogPath, text);
  await saveCodexProviderIntegrationJournal({
    ...journal,
    catalogHash: sha256(text),
  });
  await invalidateCodexModelCache();
}

async function refreshOwnedWebOnlyModelCatalog(
  nativeFamilies?: readonly BridgeNativeModelFamily[],
  availableModes?: readonly BridgeWebMode[],
): Promise<void> {
  const changed = await webOnlyIntegration.refreshModels(async (payload) => {
    const modes = availableModes ?? bridgeWebModesInCatalog(payload);
    return buildWebOnlyModelsPayload(
      payload,
      modes,
      await configuredContextProfile(modes),
      nativeFamilies,
      (await loadSettings()).webToolMode === "full" ? true : "simple",
    );
  });
  if (changed) await invalidateCodexModelCache();
}

async function codexProviderInstalledStatus(): Promise<{
  readonly installed: boolean;
  readonly configPath: string;
  readonly repairable?: boolean;
  readonly error?: string;
}> {
  const webOnly = await webOnlyIntegration.status();
  if (webOnly.managed)
    return {
      installed: webOnly.enabled,
      configPath: codexConfigPath(),
      ...(webOnly.error ? { error: webOnly.error } : {}),
    };
  const journal = await loadCodexProviderIntegrationJournal();
  const configPath = journal?.configPath ?? codexConfigPath();
  if (journal === undefined) return { installed: false, configPath };
  const config = await readTextIfPresent(configPath);
  if (!config.exists) return { installed: false, configPath };
  const managed = findManagedProviderBlock(config.text);
  let catalogMatches = true;
  if (hasManagedProviderCatalog(journal)) {
    const catalog = await readTextIfPresent(journal.catalogPath);
    catalogMatches =
      catalog.exists && sha256(catalog.text) === journal.catalogHash;
  }
  let hookMatches = true;
  let hookFullyAbsent = false;
  if (journal.version === 5) {
    try {
      verifyCodexInterruptHook(config.text, journal.interruptHook);
    } catch {
      hookMatches = false;
      hookFullyAbsent = isCodexInterruptHookFullyAbsent(
        config.text,
        journal.interruptHook,
      );
    }
  }
  const installed =
    managed !== undefined &&
    sha256(managed.block) === journal.blockHash &&
    catalogMatches &&
    hookMatches;
  if (installed) return { installed, configPath };
  let repairable = false;
  if (
    hasManagedProviderCatalog(journal) &&
    managed &&
    catalogMatches &&
    (journal.version !== 5 || hookMatches || hookFullyAbsent)
  ) {
    try {
      const providerNeedsRepair = sha256(managed.block) !== journal.blockHash;
      if (providerNeedsRepair) {
        planProviderRepair(managed.block, journal.baseUrl, journal.catalogPath);
      }
      repairable = providerNeedsRepair || hookFullyAbsent;
    } catch {
      /* Report the ownership conflict without changing settings. */
    }
  }
  return {
    installed,
    configPath,
    repairable,
    error: repairable
      ? "The Codex provider route or Interrupt hook is missing. Click Repair connection to restore Bridge routing, then restart Codex."
      : "The Bridge model settings, catalog, or Interrupt hook changed after setup. The provider is not connected to Codex.",
  };
}

async function installCodexWebProvider(repair = false): Promise<void> {
  if ((await webOnlyIntegration.status()).managed)
    throw new Error(
      "Restore the previous mode before changing the regular provider.",
    );
  await startResponsesGateway();
  const baseUrl = responsesAddress?.baseUrl;
  if (baseUrl === undefined)
    throw new Error("The Web provider failed to start.");
  const configPath = codexConfigPath();
  const config = await readTextIfPresent(configPath);
  const journal = await loadCodexProviderIntegrationJournal();
  const providerConfigText = config.text;
  let repairingMissingHook = false;
  if (journal?.version === 5) {
    repairingMissingHook = isCodexInterruptHookFullyAbsent(
      providerConfigText,
      journal.interruptHook,
    );
    if (repairingMissingHook && !repair) {
      throw new Error(
        "The Codex Interrupt hook is missing. Use Repair connection to restore it.",
      );
    }
    if (!repairingMissingHook) {
      verifyCodexInterruptHook(providerConfigText, journal.interruptHook);
    }
  }
  const currentManaged = findManagedProviderBlock(providerConfigText);
  let repairPlan: ProviderRepairPlan | undefined;

  if (journal !== undefined) {
    if (journal.configPath !== configPath) {
      throw new Error(
        "Codex home changed after Web provider setup; remove the previous provider first.",
      );
    }
    if (
      currentManaged === undefined ||
      sha256(currentManaged.block) !== journal.blockHash
    ) {
      if (repair && hasManagedProviderCatalog(journal) && currentManaged) {
        repairPlan = planProviderRepair(
          currentManaged.block,
          baseUrl,
          journal.catalogPath,
        );
      } else {
        throw new Error(
          "Codex Web provider config changed after setup. Use Repair connection to restore the Bridge route.",
        );
      }
    }
    if (hasManagedProviderCatalog(journal)) {
      const currentCatalog = await readTextIfPresent(journal.catalogPath);
      if (
        currentCatalog.exists &&
        sha256(currentCatalog.text) !== journal.catalogHash
      ) {
        throw new Error(
          "Codex Web model catalog changed after setup; refusing to overwrite the user's newer value.",
        );
      }
    }
  } else if (currentManaged !== undefined) {
    throw new Error(
      "Codex config already contains a CodexGPT Bridge Web provider block without an ownership journal; refusing to claim it.",
    );
  }

  let capturedUpstreamBaseUrl = originalProviderBaseUrlBeforeBridge(
    journal,
    providerConfigText,
    currentManaged,
    baseUrl,
  );
  if (
    repairPlan !== undefined &&
    repairPlan.previousRouteUrl !== journal?.baseUrl
  ) {
    capturedUpstreamBaseUrl = normalizeOriginalProviderBaseUrl(
      repairPlan.previousRouteUrl,
      baseUrl,
    );
  }

  // Repair does not need to rebuild an unchanged model catalog or invoke the CLI.
  const catalog =
    (repairPlan || repairingMissingHook) && hasManagedProviderCatalog(journal)
      ? { path: journal.catalogPath, hash: journal.catalogHash }
      : await writeManagedModelCatalog(await probeSupportedBridgeModes());
  const lineEnding = lineEndingFor(providerConfigText);
  const nextBlock = managedProviderBlock(baseUrl, catalog.path, lineEnding);
  let nextText: string;
  let replacedOpenAiBaseUrl: string;
  let replacedModelCatalogJson: string;

  if (journal !== undefined && currentManaged !== undefined) {
    replacedOpenAiBaseUrl =
      journal.version === 2 || hasManagedProviderCatalog(journal)
        ? journal.replacedOpenAiBaseUrl
        : "";
    replacedModelCatalogJson = hasManagedProviderCatalog(journal)
      ? journal.replacedModelCatalogJson
      : "";
    if (repairPlan) {
      if (repairPlan.previousRouteUrl !== journal.baseUrl)
        replacedOpenAiBaseUrl = repairPlan.previousRoute;
    }

    let migrationText = providerConfigText;
    if (!hasManagedProviderCatalog(journal)) {
      const previousCatalog = findTopLevelModelCatalogJson(migrationText);
      if (previousCatalog !== undefined) {
        replacedModelCatalogJson = previousCatalog.text;
        migrationText =
          migrationText.slice(0, previousCatalog.start) +
          migrationText.slice(previousCatalog.end);
      }
    }
    const managedAfterMigration = findManagedProviderBlock(migrationText);
    if (managedAfterMigration === undefined) {
      throw new Error(
        "Codex Web provider block disappeared during setup migration.",
      );
    }
    nextText =
      migrationText.slice(0, managedAfterMigration.start) +
      nextBlock +
      (repairPlan?.preservedText ?? "") +
      migrationText.slice(managedAfterMigration.end);
  } else {
    const existingRoute = findTopLevelOpenAiBaseUrl(providerConfigText);
    const existingCatalog = findTopLevelModelCatalogJson(providerConfigText);
    replacedOpenAiBaseUrl = existingRoute?.text ?? "";
    replacedModelCatalogJson = existingCatalog?.text ?? "";
    const ranges = [existingRoute, existingCatalog]
      .filter(
        (
          value,
        ): value is {
          readonly start: number;
          readonly end: number;
          readonly text: string;
        } => value !== undefined,
      )
      .sort((left, right) => right.start - left.start);
    let stripped = providerConfigText;
    for (const range of ranges) {
      stripped = stripped.slice(0, range.start) + stripped.slice(range.end);
    }
    nextText = `${nextBlock}${stripped}`;
  }

  if (repairPlan || repairingMissingHook) {
    const backupDirectory = join(app.getPath("userData"), "provider-backups");
    const suffix = new Date().toISOString().replace(/[:.]/gu, "-");
    await atomicWriteText(
      join(backupDirectory, `${suffix}.config.toml`),
      config.text,
    );
    await atomicWriteText(
      join(backupDirectory, `${suffix}.journal.json`),
      JSON.stringify(journal, null, 2) + "\n",
    );
  }
  const latestConfig = await readTextIfPresent(configPath);
  if (
    latestConfig.text !== config.text ||
    latestConfig.exists !== config.exists
  ) {
    throw new Error(
      "Codex settings changed during installation. Retry the operation.",
    );
  }
  const installedHook =
    journal?.version === 5 && !repairingMissingHook
      ? reinstallCodexInterruptHook(
          nextText,
          configPath,
          currentCodexInterruptHookCommand(),
          journal.interruptHook,
        )
      : installCodexInterruptHook(
          nextText,
          configPath,
          currentCodexInterruptHookCommand(),
        );
  await atomicWriteText(configPath, installedHook.text);
  await saveCodexProviderIntegrationJournal({
    version: 5,
    configPath,
    baseUrl,
    upstreamBaseUrl: capturedUpstreamBaseUrl ?? null,
    catalogPath: catalog.path,
    catalogHash: catalog.hash,
    blockHash: sha256(nextBlock),
    createdConfig: journal?.createdConfig ?? !config.exists,
    replacedOpenAiBaseUrl,
    replacedModelCatalogJson,
    interruptHook: installedHook.installed,
  });
  await invalidateCodexModelCache();
}

async function removeCodexWebProvider(): Promise<void> {
  if ((await webOnlyIntegration.status()).managed)
    throw new Error(
      "Restore the previous mode before removing the regular provider.",
    );
  const journal = await loadCodexProviderIntegrationJournal();
  if (journal === undefined) return;
  const config = await readTextIfPresent(journal.configPath);
  if (!config.exists) {
    throw new Error(
      "Codex config was removed after Web provider setup; refusing to rewrite it automatically.",
    );
  }
  const providerConfigText =
    journal.version === 5
      ? restoreCodexInterruptHook(config.text, journal.interruptHook)
      : config.text;
  const managed = findManagedProviderBlock(providerConfigText);
  if (managed === undefined || sha256(managed.block) !== journal.blockHash) {
    throw new Error(
      "Codex Web provider config changed after setup; refusing to overwrite the user's newer value.",
    );
  }
  const restoredAssignments = hasManagedProviderCatalog(journal)
    ? journal.replacedOpenAiBaseUrl + journal.replacedModelCatalogJson
    : journal.version === 2
      ? journal.replacedOpenAiBaseUrl
      : "";
  const restored =
    providerConfigText.slice(0, managed.start) +
    restoredAssignments +
    providerConfigText.slice(managed.end);
  if (journal.createdConfig && restored.length === 0) {
    await rm(journal.configPath, { force: true });
  } else {
    await atomicWriteText(journal.configPath, restored);
  }
  await rm(codexProviderIntegrationJournalPath(), { force: true });
  if (hasManagedProviderCatalog(journal)) {
    const catalog = await readTextIfPresent(journal.catalogPath);
    if (catalog.exists && sha256(catalog.text) === journal.catalogHash) {
      await rm(journal.catalogPath, { force: true });
    }
  }
  await invalidateCodexModelCache();
}

function fullMcpSettings(settings: DesktopSettings): FullMcpTunnelSettings {
  if (!settings.fullMcpTunnelId || !settings.fullMcpRuntimeKeyFile) {
    throw new Error(
      "Full MCP requires an OpenAI tunnel ID and runtime key file.",
    );
  }
  return {
    tunnelId: settings.fullMcpTunnelId,
    runtimeKeyFile: settings.fullMcpRuntimeKeyFile,
    ...(settings.fullMcpTunnelClientPath
      ? { tunnelClientPath: settings.fullMcpTunnelClientPath }
      : {}),
  };
}

async function startFullMcp(settings: DesktopSettings): Promise<void> {
  if (settings.webToolMode !== "full" || fullMcpAddress) return;
  const tunnelSettings = fullMcpSettings(settings);
  tunnelManager.validate(tunnelSettings);
  const address = await fullTurnMcpServer.start(desktopFullMcpPort());
  try {
    const status = await tunnelManager.connect(tunnelSettings, address.url);
    fullMcpAddress = address;
    fullMcpTunnelStatus = status;
  } catch (error) {
    await fullTurnMcpServer.close().catch(() => undefined);
    throw error;
  }
}

async function stopFullMcp(): Promise<void> {
  const errors: unknown[] = [];
  await tunnelManager.stop().catch((error) => errors.push(error));
  await fullTurnMcpServer.close().catch((error) => errors.push(error));
  fullMcpAddress = undefined;
  fullMcpTunnelStatus = undefined;
  if (errors.length > 0) {
    throw new AggregateError(errors, "Full MCP shutdown failed.");
  }
}

const freshConversationTurns = new Map<string, string>();
function manualWebModes(settings: DesktopSettings): readonly BridgeWebMode[] {
  return [
    "instant",
    "medium",
    "high",
    "extra-high",
    "luna",
    "think",
    ...(settings.manualPro ? ["pro" as const] : []),
  ];
}

async function startResponsesGateway(): Promise<void> {
  if (responsesGateway !== undefined) return;
  const settings = await loadSettings();
  if (settings.webToolMode === "full") await startFullMcp(settings);
  const providerCapability = {
    token: randomBytes(32).toString("hex"),
    instanceId: randomBytes(16).toString("hex"),
  };
  const gateway = new ResponsesGateway({
    lunaCheckpoints: new LunaCheckpointStore(
      join(app.getPath("userData"), "luna-checkpoints.json"),
    ),
    admin: {
      token: providerCapability.token,
      onShutdown: () => stopResponsesGateway(),
      onCommand: async (command, args) => {
        const handler = desktopCommandHandlers.get(command);
        if (!handler) throw new Error("Unsupported desktop command.");
        return handler(undefined as never, ...args);
      },
    },
    webOnly: {
      token: await webOnlyIntegration.token(),
      models: () => webOnlyIntegration.models(),
    },
    availableWebModes: () => configuredBridgeWebModes(),
    accountContextProfile: () => configuredContextProfile(),
    nativeModelFamilies: () => configuredNativeModelFamilies(),
    host: "127.0.0.1",
    port: desktopResponsesPort(),
    upstreamBaseUrl: () => configuredOriginalProviderBaseUrl(),
    receiptAwareContextSync: true,
    runWebTurn: async (input) => {
      const settings = await loadSettings();
      const freshKey = input.threadId ?? "";
      const freshId = input.turnId ?? input.operationId;
      const fresh =
        settings.interactionMode !== "manual" &&
        settings.freshConversationPerTurn === true &&
        !input.requireRetainedConversation &&
        !!freshId &&
        freshConversationTurns.get(freshKey) !== freshId;
      if (fresh && freshId) {
        freshConversationTurns.delete(freshKey);
        freshConversationTurns.set(freshKey, freshId);
        if (freshConversationTurns.size > 500)
          freshConversationTurns.delete(
            freshConversationTurns.keys().next().value!,
          );
      }
      const projectName =
        !settings.temporaryChat &&
        settings.chatGptProjects.enabled &&
        !(await chatGptBrowser.hasConversation(input.threadId))
          ? await resolveCodexProjectName(codexHome(), input)
          : undefined;
      const runner =
        settings.interactionMode === "manual" ? manualTurns : chatGptBrowser;
      if (settings.interactionMode === "manual" && !input.turnToken) {
        const token = fullTurnBroker.register(
          `manual-readonly:${input.operationId}:${createHash("sha256").update(input.prompt).digest("hex")}`,
          [],
          true,
        );
        try {
          return await manualTurns.runTurn({
            ...input,
            turnToken: token,
            allowWebNativeTools: true,
            contract: `${input.contract ?? ""}\nFor this manual read-only handoff, use codex_tool_inventory only to discover bridge.control.manual_complete, then codex_tool_call only to submit that control. The dedicated codex_manual_complete remains an alternative. This handoff cannot execute workspace tools.`,
            onContextStaging: () => fullTurnBroker.beginContextStaging(token),
            onContextCommit: () => fullTurnBroker.commitContextStaging(token),
          });
        } finally {
          fullTurnBroker.revoke(token);
        }
      }
      return runner.runTurn({
        ...input,
        silenceTimeoutSeconds: settings.silenceTimeoutSeconds ?? 0,
        autoApproveToolCalls: settings.autoApproveToolCalls === true,
        ...(fresh ? { forceNewConversation: true } : {}),
        temporaryChat: settings.temporaryChat,
        ...(projectName ? { projectName } : {}),
      });
    },
    ...(settings.webToolMode === "full"
      ? {
          fullMcp: {
            broker: fullTurnBroker,
            enabled: () => true,
            connectorName: () => settings.fullMcpConnectorName,
          },
        }
      : {}),
  });
  try {
    responsesAddress = await gateway.start();
    providerControlMetadata = await providerControlStore.publish(
      new URL(responsesAddress.baseUrl).origin,
      providerCapability,
    );
    responsesGateway = gateway;
    responsesStartupError = undefined;
  } catch (error) {
    await providerControlStore
      .clear(providerCapability.instanceId)
      .catch(() => undefined);
    await gateway.close().catch(() => undefined);
    await stopFullMcp().catch(() => undefined);
    responsesAddress = undefined;
    responsesStartupError =
      error instanceof Error ? error.message : "Web provider failed to start.";
    throw error;
  }
}

async function stopResponsesGateway(): Promise<void> {
  manualTurns.close();
  freshConversationTurns.clear();
  const gateway = responsesGateway;
  const metadata = providerControlMetadata;
  responsesGateway = undefined;
  responsesAddress = undefined;
  providerControlMetadata = undefined;
  const errors: unknown[] = [];
  if (metadata) {
    await providerControlStore
      .clear(metadata.instanceId)
      .catch((error) => errors.push(error));
  }
  await gateway?.close().catch((error) => errors.push(error));
  await stopFullMcp().catch((error) => errors.push(error));
  if (errors.length > 0) {
    throw new AggregateError(errors, "Web provider shutdown failed.");
  }
}

async function webProviderStatus(): Promise<WebProviderStatus> {
  const settings = await loadSettings();
  const browser =
    settings.interactionMode === "manual"
      ? { windowOpen: false, signedIn: false }
      : await chatGptBrowser.status();
  const integration = await codexProviderInstalledStatus();
  let availableModes: readonly BridgeWebMode[] | undefined;
  try {
    availableModes = await configuredBridgeWebModes();
  } catch {
    // An owned but unreadable catalog must not make unavailable rows look usable.
    availableModes = integration.installed ? [] : undefined;
  }
  const modelIds = (
    availableModes === undefined
      ? CODEXGPT_BRIDGE_WEB_MODEL_ROUTES
      : CODEXGPT_BRIDGE_WEB_MODEL_ROUTES.filter((route) =>
          availableModes.includes(route.mode),
        )
  ).map((route) => route.slug);
  if (settings.webToolMode === "full" && fullMcpAddress) {
    fullMcpTunnelStatus = await tunnelManager.status().catch((error) => ({
      configured: true,
      running: false,
      ready: false,
      detail: error instanceof Error ? error.message : "Tunnel status failed.",
    }));
  }
  return {
    browserSmoke: {
      status: browserSmokeRunning
        ? "running"
        : browserSmokeResult
          ? "passed"
          : browserSmokeError
            ? "failed"
            : "not-run",
      ...(browserSmokeResult
        ? {
            mode: browserSmokeResult.mode,
            checks: browserSmokeResult.checks,
            ...(browserSmokePassedAt ? { passedAt: browserSmokePassedAt } : {}),
          }
        : {}),
      ...(browserSmokeError ? { error: browserSmokeError } : {}),
    },
    passkeyLogin: passkeyLogin.status(),
    chromeLogin: {
      ...chromeChatGptHost.manualLoginStatus(),
      ...(chromeVerificationPending
        ? { phase: "challenge" as const }
        : chromeLoginVerifying
          ? { phase: "verifying" as const }
          : {}),
    },
    webOnly: await webOnlyIntegration.status(),
    running: responsesAddress !== undefined,
    installed: integration.installed,
    repairable: integration.repairable ?? false,
    modelId: modelIds[0] ?? "codexgpt-bridge/instant",
    modelIds,
    tasks: chatGptBrowser.tasks(),
    developmentProfile,
    subagents: fullTurnBroker.status(),
    manualTasks: manualTurns.tasks(),
    queue:
      settings.interactionMode === "manual"
        ? manualTurns.pool.status()
        : chatGptBrowser.queueStatus(),
    usage: await modelReceipts.summary(),
    officialUsage: await chatGptUsage.summary(chatGptBrowser.usageAccount()),
    ...(responsesAddress === undefined
      ? {}
      : {
          baseUrl: (await webOnlyIntegration.status()).enabled
            ? responsesAddress.baseUrl.replace(/\/v1$/u, "/web/v1")
            : responsesAddress.baseUrl,
        }),
    configPath: integration.configPath,
    browserWindowOpen:
      browser.windowOpen ||
      chromeChatGptHost.manualLoginStatus().phase === "waiting",
    browserSignedIn:
      browser.signedIn &&
      (settings.chatGptBrowserHost !== "chrome" ||
        chromeChatGptHost.manualLoginStatus().verified),
    toolMode: settings.webToolMode,
    ...(settings.webToolMode === "full"
      ? {
          fullMcp: {
            configured: Boolean(
              settings.fullMcpTunnelId && settings.fullMcpRuntimeKeyFile,
            ),
            running: fullMcpTunnelStatus?.running ?? false,
            ready: fullMcpTunnelStatus?.ready ?? false,
            ...(fullMcpAddress ? { mcpUrl: fullMcpAddress.url } : {}),
            ...(fullMcpTunnelStatus?.detail
              ? { detail: fullMcpTunnelStatus.detail }
              : {}),
          },
        }
      : {}),
    ...((responsesStartupError ?? integration.error) === undefined
      ? {}
      : { error: responsesStartupError ?? integration.error }),
  };
}

async function launchVerifiedUpdate(): Promise<void> {
  if (manualTurns.tasks().length)
    throw new Error(
      "Finish or cancel manual turns before installing an update.",
    );
  const status = releaseUpdates.status();
  if (status.phase !== "ready" || !status.downloadedPath || !status.artifact)
    throw new Error("A verified update is not ready to install.");
  if (
    chatGptBrowser
      .tasks()
      .some((task) =>
        ["queued", "generating", "waiting-tools", "waiting-challenge"].includes(
          task.state,
        ),
      )
  )
    throw new Error(
      "Finish or cancel active Web tasks before installing an update.",
    );

  await releaseUpdates.verifyReadyArtifact();
  releaseUpdates.markInstalling();
  const providerWasRunning = responsesGateway !== undefined;
  try {
    if (providerWasRunning) await stopResponsesGateway();

    if (process.platform === "win32") {
      const child = spawn(status.downloadedPath, [], {
        detached: true,
        windowsHide: false,
        stdio: "ignore",
      });
      await new Promise<void>((resolvePromise, reject) => {
        child.once("spawn", resolvePromise);
        child.once("error", reject);
      });
      child.unref();
    } else if (process.platform === "darwin") {
      const error = await shell.openPath(status.downloadedPath);
      if (error) throw new Error(error);
    } else if (process.platform === "linux") {
      if (status.artifact.kind === "appimage") {
        await chmod(status.downloadedPath, 0o700);
        const child = spawn(status.downloadedPath, [], {
          detached: true,
          stdio: "ignore",
        });
        await new Promise<void>((resolvePromise, reject) => {
          child.once("spawn", resolvePromise);
          child.once("error", reject);
        });
        child.unref();
      } else {
        const error = await shell.openPath(status.downloadedPath);
        if (error) throw new Error(error);
      }
    } else {
      throw new Error(`Updates are not supported on ${process.platform}.`);
    }
  } catch (error) {
    const failed = releaseUpdates.markReadyAfterLaunchFailure(error);
    if (providerWasRunning) {
      await startResponsesGateway().catch(() => undefined);
    }
    throw new Error(failed.error ?? "Update launch failed.", { cause: error });
  }
  app.quit();
}

async function desktopDoctorReport(): Promise<DesktopDoctorReport> {
  let settingsLoaded = true;
  let settings = DEFAULT_SETTINGS;
  try {
    settings = await loadSettings();
  } catch {
    settingsLoaded = false;
  }
  const integration = await codexProviderInstalledStatus().catch((error) => ({
    installed: false,
    repairable: false,
    configPath: codexConfigPath(),
    error:
      error instanceof Error ? error.message : "Provider inspection failed.",
  }));
  const browser = await chatGptBrowser.status().catch(() => ({
    windowOpen: false,
    signedIn: false,
  }));
  const usage = await chatGptUsage.summary(chatGptBrowser.usageAccount());
  return runDesktopDoctor({
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    homeDirectory: homedir(),
    secureStorageAvailable: safeStorage.isEncryptionAvailable(),
    settingsLoaded,
    provider: {
      installed: integration.installed,
      repairable: integration.repairable ?? false,
      running: responsesAddress !== undefined,
      browserSignedIn: browser.signedIn,
      ...((responsesStartupError ?? integration.error)
        ? { error: responsesStartupError ?? integration.error }
        : {}),
    },
    update: releaseUpdates.status(),
    usage,
    ...(settings.webToolMode === "full"
      ? {
          fullMcp: {
            configured: Boolean(
              settings.fullMcpTunnelId && settings.fullMcpRuntimeKeyFile,
            ),
            running: fullMcpTunnelStatus?.running ?? false,
            ready: fullMcpTunnelStatus?.ready ?? false,
            ...(fullMcpTunnelStatus?.detail
              ? { detail: fullMcpTunnelStatus.detail }
              : {}),
          },
        }
      : {}),
    files: [
      {
        id: "desktop-settings-file",
        label: "Desktop settings file",
        path: settingsPath(),
        required: false,
        repairable: false,
      },
      {
        id: "codex-config-file",
        label: "Codex configuration file",
        path: integration.configPath,
        required: integration.installed,
        repairable: integration.repairable ?? false,
      },
      {
        id: "provider-journal-file",
        label: "Provider ownership journal",
        path: codexProviderIntegrationJournalPath(),
        required: integration.installed,
        repairable: integration.repairable ?? false,
      },
      {
        id: "provider-catalog-file",
        label: "Bridge model catalog",
        path: codexManagedModelCatalogPath(),
        required: integration.installed,
        repairable: integration.repairable ?? false,
      },
    ],
  });
}

async function repairDesktopDoctor(): Promise<DesktopDoctorReport> {
  const integration = await codexProviderInstalledStatus();
  if (integration.repairable) await installCodexWebProvider(true);
  await refreshOwnedCodexModelCatalog().catch(() => undefined);
  await refreshOwnedWebOnlyModelCatalog().catch(() => undefined);
  const current = await codexProviderInstalledStatus();
  if (current.installed && responsesGateway === undefined)
    await startResponsesGateway();
  return desktopDoctorReport();
}

const desktopCommandHandlers = new Map<
  string,
  Parameters<typeof ipcMain.handle>[1]
>();
function registerDesktopCommand(
  channel: string,
  listener: Parameters<typeof ipcMain.handle>[1],
): void {
  desktopCommandHandlers.set(channel, listener);
  ipcMain.handle(channel, listener);
}

function registerIpc(): void {
  registerDesktopCommand("provider:stop", () => {
    setTimeout(() => void stopResponsesGateway(), 0).unref?.();
    return { stopping: true };
  });
  ipcMain.handle("settings:set-chatgpt-browser-host", (_event, host: unknown) =>
    mutateProvider(async () => {
      if (host !== "embedded" && host !== "chrome")
        throw new Error("Unsupported ChatGPT browser.");
      if (
        browserSmokeRunning ||
        chatGptBrowser
          .tasks()
          .some((task) =>
            [
              "queued",
              "generating",
              "waiting-tools",
              "waiting-challenge",
            ].includes(task.state),
          )
      )
        throw new Error(
          "Wait for current Web tasks to finish before changing the ChatGPT browser.",
        );
      const settings = await loadSettings();
      if ((settings.chatGptBrowserHost ?? "embedded") === host) return settings;
      await chatGptBrowser.close();
      await chromeChatGptHost.close();
      chromeVerificationPending = false;
      const next: DesktopSettings = { ...settings, chatGptBrowserHost: host };
      await saveSettings(next);
      chatGptBrowser = createChatGptBrowser();
      return next;
    }),
  );
  ipcMain.handle("settings:set-locale", async (_event, locale: unknown) => {
    if (
      locale !== "en" &&
      locale !== "zh-TW" &&
      locale !== "zh-CN" &&
      locale !== "ja" &&
      locale !== "ko"
    )
      throw new Error("Unsupported interface language.");
    const normalizedLocale: DesktopSettings["locale"] = locale;
    const next: DesktopSettings = {
      ...(await loadSettings()),
      locale: normalizedLocale,
    };
    await saveSettings(next);
    systemTray?.setLocale(normalizedLocale);
    return next;
  });
  ipcMain.handle(
    "settings:set-update-manifest-url",
    async (_event, value: unknown) => {
      if (app.isPackaged && !isWinUnpackedBuild)
        throw new Error(
          "The update manifest URL is managed by the packaged release channel.",
        );
      if (managedUpdateManifestUrl)
        throw new Error(
          "The update manifest URL is managed by CODEXGPT_BRIDGE_UPDATE_MANIFEST_URL.",
        );
      const updateManifestUrl = normalizeUpdateManifestUrl(value);
      const current = await loadSettings();
      const next: DesktopSettings & { updateManifestUrl?: string } = {
        ...current,
      };
      if (updateManifestUrl) next.updateManifestUrl = updateManifestUrl;
      else delete next.updateManifestUrl;
      releaseUpdates.configure(updateManifestUrl);
      await saveSettings(next);
      void updateReminders.check(true).catch(() => undefined);
      return next;
    },
  );
  ipcMain.handle(
    "settings:set-temporary-chat",
    async (_event, enabled: unknown) => {
      if (typeof enabled !== "boolean")
        throw new Error("Temporary Chat must be a boolean.");
      const next = { ...(await loadSettings()), temporaryChat: enabled };
      await saveSettings(next);
      return next;
    },
  );
  ipcMain.handle(
    "settings:set-chatgpt-projects-enabled",
    async (_event, enabled: unknown) => {
      if (typeof enabled !== "boolean")
        throw new Error("Project 對應開關必須是 boolean。");
      const chatGptProjects = { enabled };
      const next = { ...(await loadSettings()), chatGptProjects };
      await saveSettings(next);
      return next;
    },
  );
  registerDesktopCommand("settings:get", async () => loadSettings());
  ipcMain.handle("manual:copy", (_event, id: string) => {
    const task = manualTurns.tasks().find((task) => task.id === id);
    if (!task) throw new Error("Manual task has ended.");
    clipboard.writeText(task.prompt);
  });
  ipcMain.handle("manual:sent", (_event, id: string) => manualTurns.sent(id));
  ipcMain.handle("manual:complete", (_event, id: string, text: string) =>
    manualTurns.completeFromUser(id, text),
  );
  ipcMain.handle(
    "manual:acknowledge",
    (_event, id: string, acknowledgement: string) =>
      manualTurns.acknowledge(id, acknowledgement),
  );
  ipcMain.handle("manual:cancel", (_event, id: string) =>
    manualTurns.cancel(id),
  );
  ipcMain.handle("manual:open", () =>
    shell.openExternal("https://chatgpt.com/"),
  );
  registerDesktopCommand("settings:set-advanced", (_event, value: unknown) =>
    mutateProvider(async () => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid advanced settings.");
      const keys = [
        "freshConversationPerTurn",
        "autoApproveToolCalls",
        "silenceTimeoutSeconds",
        "startAtLogin",
        "interactionMode",
        "manualPro",
      ];
      if (Object.keys(value).some((key) => !keys.includes(key)))
        throw new Error("Unknown advanced setting.");
      const before = await loadSettings();
      const advanced = parseAdvancedSettings({ ...before, ...value });
      if (
        manualTurns.tasks().length ||
        chatGptBrowser
          .tasks()
          .some((task) =>
            [
              "queued",
              "generating",
              "waiting-tools",
              "waiting-challenge",
            ].includes(task.state),
          )
      )
        throw new Error(
          "Finish or cancel active turns before changing advanced settings.",
        );
      if (
        advanced.interactionMode === "manual" &&
        before.webToolMode !== "full"
      )
        throw new Error("Manual interaction requires Full MCP.");
      const next = { ...before, ...advanced };
      if (advanced.startAtLogin !== (before.startAtLogin === true)) {
        if (process.platform === "linux") {
          const directory = join(
            process.env.XDG_CONFIG_HOME || join(app.getPath("home"), ".config"),
            "autostart",
          );
          const file = join(
            directory,
            developmentProfile
              ? "codexgpt-bridge-dev.desktop"
              : "codexgpt-bridge.desktop",
          );
          const current = await readTextIfPresent(file);
          if (
            current.exists &&
            !current.text.includes("X-CodexGPT-Bridge=true")
          )
            throw new Error("Autostart entry is not owned by Bridge.");
          if (advanced.startAtLogin) {
            await mkdir(directory, { recursive: true });
            const executable = (process.env.APPIMAGE || app.getPath("exe"))
              .replace(/["`$\\]/g, "\\$&")
              .replaceAll("%", "%%");
            await atomicWriteText(
              file,
              `[Desktop Entry]\nType=Application\nName=CodexGPT Bridge${developmentProfile ? " DEV" : ""}\nExec="${executable}" --hidden${developmentProfile ? " --dev" : ""}\nX-CodexGPT-Bridge=true\n`,
            );
          } else {
            if (
              current.exists &&
              !current.text.includes("X-CodexGPT-Bridge=true")
            )
              throw new Error("Autostart entry is not owned by Bridge.");
            await rm(file, { force: true });
          }
        } else
          app.setLoginItemSettings({
            openAtLogin: advanced.startAtLogin,
            name: developmentProfile
              ? "CodexGPT Bridge DEV"
              : "CodexGPT Bridge",
            args: [
              ...(app.isPackaged ? [] : [app.getAppPath()]),
              "--hidden",
              ...(developmentProfile ? ["--dev"] : []),
            ],
          });
      }
      await saveSettings(next);
      if (
        advanced.interactionMode !== (before.interactionMode ?? "automatic") ||
        advanced.manualPro !== (before.manualPro === true)
      ) {
        await chatGptBrowser.close();
        await chromeChatGptHost.close();
        chatGptBrowser = createChatGptBrowser();
        try {
          const modes =
            advanced.interactionMode === "manual"
              ? manualWebModes(next)
              : await probeSupportedBridgeModes();
          const families =
            advanced.interactionMode === "manual"
              ? (["5.6", "6", "6.1"] as const)
              : await probeNativeModelFamilies();
          await refreshOwnedCodexModelCatalog(families, modes);
          await refreshOwnedWebOnlyModelCatalog(families, modes);
        } catch (error) {
          await saveSettings(before);
          throw error;
        }
      }
      return next;
    }),
  );
  ipcMain.handle("update:status", () => releaseUpdates.status());
  ipcMain.handle("update:check", () => updateReminders.check(true));
  ipcMain.handle("update:download", async () => {
    try {
      return await releaseUpdates.download();
    } finally {
      updateReminders.refresh();
    }
  });
  ipcMain.handle("update:install", async () => {
    try {
      await launchVerifiedUpdate();
      return releaseUpdates.status();
    } finally {
      updateReminders.refresh();
    }
  });
  registerDesktopCommand("doctor:run", () => desktopDoctorReport());
  ipcMain.handle("doctor:repair", () =>
    mutateProvider(() => repairDesktopDoctor()),
  );
  ipcMain.handle("doctor:export", async () => {
    const report = await desktopDoctorReport();
    const saveOptions = {
      defaultPath: "codexgpt-bridge-doctor.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const destination =
      mainWindow === undefined
        ? await dialog.showSaveDialog(saveOptions)
        : await dialog.showSaveDialog(mainWindow, saveOptions);
    if (destination.canceled || destination.filePath === undefined) return null;
    await writeFile(
      destination.filePath,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    return destination.filePath;
  });
  registerDesktopCommand(
    "settings:set-full-mcp",
    async (_event, value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid Full MCP settings.");
      }
      if (
        chatGptBrowser
          .tasks()
          .some((task) =>
            [
              "queued",
              "generating",
              "waiting-tools",
              "waiting-challenge",
            ].includes(task.state),
          )
      ) {
        throw new Error(
          "Finish or cancel active Web tasks before changing Full MCP.",
        );
      }
      const input = value as Record<string, unknown>;
      const mode =
        input.mode === "full"
          ? "full"
          : input.mode === "simple"
            ? "simple"
            : undefined;
      if (manualTurns.tasks().length)
        throw new Error("Finish manual turns before changing Full MCP.");
      if (
        mode === "simple" &&
        (await loadSettings()).interactionMode === "manual"
      )
        throw new Error(
          "Switch to automatic interaction before disabling Full MCP.",
        );
      const connectorName =
        typeof input.connectorName === "string"
          ? input.connectorName.trim()
          : "";
      const tunnelId =
        typeof input.tunnelId === "string" ? input.tunnelId.trim() : "";
      const runtimeApiKey =
        typeof input.runtimeApiKey === "string"
          ? input.runtimeApiKey.trim()
          : "";
      const tunnelClientPath =
        typeof input.tunnelClientPath === "string"
          ? input.tunnelClientPath.trim()
          : "";
      if (
        !mode ||
        !connectorName ||
        connectorName.length > 120 ||
        /[\r\n]/u.test(connectorName)
      ) {
        throw new Error("Full MCP mode or connector name is invalid.");
      }
      if (
        runtimeApiKey &&
        (!runtimeApiKey.startsWith("sk-") ||
          runtimeApiKey.length < 20 ||
          runtimeApiKey.length > 512 ||
          /\s/u.test(runtimeApiKey))
      ) {
        throw new Error("Enter a valid OpenAI API key beginning with sk-.");
      }
      const current = await loadSettings();
      let createdRuntimeKeyFile: string | undefined;
      try {
        if (runtimeApiKey) {
          createdRuntimeKeyFile = await saveTunnelRuntimeApiKey(runtimeApiKey);
        }
        const runtimeKeyFile =
          createdRuntimeKeyFile ?? current.fullMcpRuntimeKeyFile;
        const settingsWithoutTunnel = {
          ...parseAdvancedSettings(current),
          locale: current.locale,
          temporaryChat: current.temporaryChat,
          chatGptProjects: current.chatGptProjects,
          webToolMode: current.webToolMode,
          fullMcpConnectorName: current.fullMcpConnectorName,
          ...(current.updateManifestUrl
            ? { updateManifestUrl: current.updateManifestUrl }
            : {}),
          ...(current.updateManifestPath
            ? { updateManifestPath: current.updateManifestPath }
            : {}),
        };
        const next: DesktopSettings = {
          ...settingsWithoutTunnel,
          webToolMode: mode,
          fullMcpConnectorName: connectorName,
          ...(tunnelId ? { fullMcpTunnelId: tunnelId } : {}),
          ...(runtimeKeyFile ? { fullMcpRuntimeKeyFile: runtimeKeyFile } : {}),
          ...(tunnelClientPath
            ? { fullMcpTunnelClientPath: tunnelClientPath }
            : {}),
        };
        if (mode === "full") tunnelManager.validate(fullMcpSettings(next));
        const wasRunning = responsesGateway !== undefined;
        if (wasRunning) await stopResponsesGateway();
        await saveSettings(next);
        try {
          const families =
            mode === "full"
              ? await probeNativeModelFamilies().catch(() => undefined)
              : undefined;
          await refreshOwnedCodexModelCatalog(families);
          await refreshOwnedWebOnlyModelCatalog(families);
          if (wasRunning) await startResponsesGateway();
        } catch (error) {
          await saveSettings(current);
          await refreshOwnedCodexModelCatalog().catch(() => undefined);
          await refreshOwnedWebOnlyModelCatalog().catch(() => undefined);
          if (wasRunning) await startResponsesGateway().catch(() => undefined);
          throw error;
        }
        if (createdRuntimeKeyFile) {
          await removeManagedTunnelRuntimeApiKey(current.fullMcpRuntimeKeyFile);
        }
        return next;
      } catch (error) {
        await removeManagedTunnelRuntimeApiKey(createdRuntimeKeyFile);
        throw error;
      }
    },
  );
  ipcMain.handle("provider:open-task", async (_event, threadId: unknown) => {
    if (typeof threadId !== "string") throw new Error("Invalid task.");
    await chatGptBrowser.openTask(threadId);
  });
  registerDesktopCommand(
    "provider:cancel-task",
    (_event, threadId: unknown) => {
      if (typeof threadId !== "string") throw new Error("Invalid task.");
      for (const task of manualTurns.tasks())
        if (task.threadId === threadId) manualTurns.cancel(task.id);
      chatGptBrowser.cancelTask(threadId);
    },
  );
  registerDesktopCommand("provider:status", () => webProviderStatus());
  registerDesktopCommand("provider:usage-refresh", () =>
    mutateProvider(async () => {
      if ((await loadSettings()).interactionMode === "manual")
        throw new Error("Account inspection is unavailable in manual mode.");
      try {
        await chatGptBrowser.refreshUsageAccount();
      } catch (error) {
        if (error instanceof ChatGptVerificationRequiredError) {
          chromeVerificationPending = true;
          chromeChatGptHost.invalidateVerifiedLogin();
        } else throw error;
      }
      return webProviderStatus();
    }),
  );
  ipcMain.handle("provider:open-login", () =>
    mutateProvider(async () => {
      if ((await loadSettings()).interactionMode === "manual") {
        await shell.openExternal("https://chatgpt.com/");
        return webProviderStatus();
      }
      if ((await loadSettings()).chatGptBrowserHost === "chrome") {
        if (chromeVerificationPending) {
          await chatGptBrowser.openLoginWindow();
          return webProviderStatus();
        }
        if (chromeChatGptHost.manualLoginStatus().phase !== "idle")
          return webProviderStatus();
        if (
          browserSmokeRunning ||
          chatGptBrowser
            .tasks()
            .some((task) =>
              [
                "queued",
                "generating",
                "waiting-tools",
                "waiting-challenge",
              ].includes(task.state),
            )
        )
          throw new Error(
            "Finish or stop the current Web task before opening Chrome login.",
          );
        await chromeChatGptHost.beginManualLogin(
          process.env.CODEXGPT_BRIDGE_E2E_CHATGPT_URL || "https://chatgpt.com/",
        );
        await chatGptBrowser.close();
        chatGptBrowser = createChatGptBrowser();
      } else await chatGptBrowser.openLoginWindow();
      return webProviderStatus();
    }),
  );
  ipcMain.handle("provider:chrome-login-continue", () =>
    mutateProvider(async () => {
      if ((await loadSettings()).chatGptBrowserHost !== "chrome")
        throw new Error("Select Google Chrome before continuing Chrome login.");
      if (chromeVerificationPending) {
        if (!(await chatGptBrowser.status()).windowOpen) {
          chromeVerificationPending = false;
          await chromeChatGptHost.close();
          throw new Error(
            "The verification tab was closed. Open Chrome login again.",
          );
        }
      } else chromeChatGptHost.finishManualLogin();
      chromeLoginVerifying = true;
      try {
        await chatGptBrowser.refreshUsageAccount();
        chromeVerificationPending = false;
        chromeChatGptHost.confirmVerifiedLogin();
        chromeLoginVerifying = false;
        return await webProviderStatus();
      } catch (error) {
        if (error instanceof ChatGptVerificationRequiredError) {
          chromeVerificationPending = true;
          chromeChatGptHost.invalidateVerifiedLogin();
          return await webProviderStatus();
        }
        chromeVerificationPending = false;
        await chatGptBrowser.close();
        await chromeChatGptHost.close();
        chatGptBrowser = createChatGptBrowser();
        throw error;
      } finally {
        chromeLoginVerifying = false;
      }
    }),
  );
  ipcMain.handle("provider:passkey-begin", () =>
    mutateProvider(async () => {
      if ((await loadSettings()).interactionMode === "manual")
        throw new Error("Passkey automation is unavailable in manual mode.");
      await passkeyLogin.begin();
      return webProviderStatus();
    }),
  );
  ipcMain.handle("provider:passkey-continue", () =>
    mutateProvider(async () => {
      if ((await loadSettings()).interactionMode === "manual")
        throw new Error("Passkey automation is unavailable in manual mode.");
      const state = await passkeyLogin.continue();
      await chatGptBrowser.installPasskeyLoginState(state);
      return webProviderStatus();
    }),
  );
  ipcMain.handle("provider:browser-smoke", () =>
    mutateProvider(async () => {
      if ((await loadSettings()).interactionMode === "manual")
        throw new Error("Browser smoke testing is unavailable in manual mode.");
      if (
        (await loadSettings()).chatGptBrowserHost === "chrome" &&
        !chromeChatGptHost.manualLoginStatus().verified
      )
        throw new Error(
          "Complete and verify Chrome login before testing ChatGPT.",
        );
      browserSmokeRunning = true;
      browserSmokeError = undefined;
      browserSmokeResult = undefined;
      browserSmokePassedAt = undefined;
      try {
        browserSmokeResult = await chatGptBrowser.smokeTest();
        browserSmokePassedAt = new Date().toISOString();
      } catch (error) {
        browserSmokeError =
          error instanceof Error ? error.message : "Browser smoke test failed.";
        if (error instanceof ChatGptVerificationRequiredError) {
          chromeVerificationPending = true;
          chromeChatGptHost.invalidateVerifiedLogin();
        } else throw error;
      } finally {
        browserSmokeRunning = false;
      }
      return webProviderStatus();
    }),
  );
  registerDesktopCommand("provider:install", () =>
    mutateProvider(async () => {
      await installCodexWebProvider();
      return webProviderStatus();
    }),
  );
  registerDesktopCommand("provider:repair", () =>
    mutateProvider(async () => {
      await installCodexWebProvider(true);
      return webProviderStatus();
    }),
  );
  registerDesktopCommand("provider:remove", () =>
    mutateProvider(async () => {
      await removeCodexWebProvider();
      return webProviderStatus();
    }),
  );
  ipcMain.handle("provider:web-only", (_event, enabled: unknown) =>
    mutateProvider(async () => {
      if (enabled !== false)
        throw new Error(
          "Web-only mode has been removed. Restore the previous provider instead.",
        );
      if (
        chatGptBrowser
          .tasks()
          .some((task) =>
            [
              "queued",
              "generating",
              "waiting-tools",
              "waiting-challenge",
            ].includes(task.state),
          )
      ) {
        throw new Error(
          "Wait for current Web turns to finish before changing provider mode.",
        );
      }
      await webOnlyIntegration.disable();
      await invalidateCodexModelCache();
      return webProviderStatus();
    }),
  );
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    show: !process.argv.includes("--hidden"),
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: developmentProfile ? "CodexGPT Bridge DEV" : "CodexGPT Bridge",
    icon: bridgeAppIcon(),
    webPreferences: {
      preload: join(moduleDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  window.on("closed", () => {
    // An old window can finish closing after the tray has already reopened it.
    if (mainWindow !== window) return;
    mainWindow = undefined;
    void quitAfterMainWindowClosed();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://"))
      void shell.openExternal(url);
    return { action: "deny" };
  });
  await window.loadFile(join(moduleDirectory, "..", "renderer", "index.html"));
  if (focusUpdatePending && mainWindow === window && !window.isDestroyed()) {
    focusUpdatePending = false;
    window.webContents.send("update:focus");
  }
}

function showMainWindow(): void {
  if (shuttingDown) return;
  if (
    mainWindow !== undefined &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  ) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  if (app.isReady()) void createWindow();
}

function showUpdateWindow(): void {
  focusUpdatePending = true;
  showMainWindow();
  if (
    mainWindow &&
    !mainWindow.webContents.isDestroyed() &&
    !mainWindow.webContents.isLoadingMainFrame()
  ) {
    focusUpdatePending = false;
    mainWindow.webContents.send("update:focus");
  }
}

if (ownsSingleInstance) {
  app.on("second-instance", (_event, argv) => {
    if (argv.includes("--start-provider"))
      void startResponsesGateway().catch((error) => console.error(error));
    else showMainWindow();
  });

  app.whenReady().then(async () => {
    const startupSessionSupplied = Boolean(
      process.env.CODEXGPT_BRIDGE_SESSION_HANDOFF_PORT &&
      process.env.CODEXGPT_BRIDGE_SESSION_HANDOFF_TOKEN,
    );
    await importStartupChatGptSession(
      () => session.fromPartition("persist:codexgpt-bridge-chatgpt"),
      process.env.CODEXGPT_BRIDGE_SESSION_HANDOFF_PORT,
      process.env.CODEXGPT_BRIDGE_SESSION_HANDOFF_TOKEN,
    );
    delete process.env.CODEXGPT_BRIDGE_SESSION_HANDOFF_PORT;
    delete process.env.CODEXGPT_BRIDGE_SESSION_HANDOFF_TOKEN;
    const retirementWarnings = await retireWorkspaceService({
      userDataDirectory: app.getPath("userData"),
      configPath: codexConfigPath(),
      decryptToken: (encrypted) => safeStorage.decryptString(encrypted),
    });
    for (const warning of retirementWarnings) console.warn(warning);
    const settings = await loadSettings().catch(() => DEFAULT_SETTINGS);
    systemTray = new BridgeSystemTray(
      settings.locale,
      showMainWindow,
      () => app.quit(),
      {
        open: showUpdateWindow,
        check: () => {
          showUpdateWindow();
          void updateReminders.check(true).catch(() => undefined);
        },
      },
    );
    const allowsLocalUpdateSource =
      e2eUserDataDirectory !== undefined || isWinUnpackedBuild;
    const allowsUserUpdateUrl = !app.isPackaged || isWinUnpackedBuild;
    const rememberedLocalPath = allowsLocalUpdateSource
      ? e2eUserDataDirectory !== undefined
        ? (localReleaseManifestPath ?? settings.updateManifestPath)
        : (settings.updateManifestPath ?? localReleaseManifestPath)
      : undefined;
    releaseUpdates.configure(
      managedUpdateManifestUrl ??
        (allowsUserUpdateUrl ? settings.updateManifestUrl : undefined),
      rememberedLocalPath,
    );
    if (e2eUserDataDirectory === undefined) {
      if (
        !allowsLocalUpdateSource &&
        (settings.updateManifestPath || settings.updateManifestUrl)
      ) {
        const cleanedSettings = { ...settings } as DesktopSettings & {
          updateManifestPath?: string;
          updateManifestUrl?: string;
        };
        delete cleanedSettings.updateManifestPath;
        delete cleanedSettings.updateManifestUrl;
        await saveSettings(cleanedSettings);
      } else if (
        rememberedLocalPath &&
        settings.updateManifestPath !== rememberedLocalPath
      ) {
        await saveSettings({
          ...settings,
          updateManifestPath: rememberedLocalPath,
        });
      }
    }
    await refreshOwnedCodexModelCatalog().catch(() => undefined);
    await refreshOwnedWebOnlyModelCatalog().catch(() => undefined);
    await restoreChromeLogin();
    registerIpc();
    if (
      (await codexProviderInstalledStatus()).installed ||
      process.argv.includes("--start-provider")
    ) {
      await startResponsesGateway().catch(() => undefined);
    }
    await createWindow();
    const startupNativeVerification =
      e2eUserDataDirectory === undefined &&
      startupSessionSupplied &&
      process.env.CODEXGPT_BRIDGE_STARTUP_NATIVE_VERIFY === "1";
    if (
      startupNativeVerification ||
      (e2eUserDataDirectory !== undefined &&
        process.env.CODEXGPT_BRIDGE_E2E_NATIVE_SESSION_PROBE === "1")
    ) {
      // Live acceptance without launching a browser driver or debugging port.
      // The report contains only fixed smoke output and verification booleans.
      const verificationReportPath = join(
        e2eUserDataDirectory ?? app.getPath("userData"),
        startupNativeVerification
          ? "startup-browser-verification.json"
          : "native-browser-session-probe.json",
      );
      void (async () => {
        void chatGptBrowser.openLoginWindow(false).catch(() => undefined);
        const deadline = Date.now() + 25_000;
        let surface = { composer: false, challenge: false };
        let contents: Electron.WebContents | undefined;
        while (Date.now() < deadline) {
          contents = BrowserWindow.getAllWindows().find((window) =>
            window.webContents.getURL().startsWith("https://chatgpt.com/"),
          )?.webContents;
          if (contents) {
            surface = (await contents
              .executeJavaScript(
                `({
              composer: Boolean(document.querySelector('#prompt-textarea, main [contenteditable=true]')),
              challenge: Boolean(document.querySelector('#challenge-running, #challenge-stage, iframe[src*="challenges.cloudflare.com"]')) || /請稍候|just a moment|checking your browser/i.test(document.title)
            })`,
              )
              .catch(() => surface)) as typeof surface;
            if (surface.composer && !surface.challenge) break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        let serverSessionVerified = false;
        if (contents && surface.composer && !surface.challenge) {
          serverSessionVerified = await probeChatGptPageSession(
            "https://chatgpt.com/",
            contents,
            AbortSignal.timeout(15_000),
          )
            .then((result) => result.verified)
            .catch(() => false);
        }
        const runSmoke =
          startupNativeVerification ||
          process.env.CODEXGPT_BRIDGE_E2E_NATIVE_BROWSER_SMOKE === "1";
        if (startupNativeVerification) browserSmokeRunning = true;
        const smoke =
          runSmoke && serverSessionVerified
            ? await chatGptBrowser.smokeTest().catch(() => undefined)
            : undefined;
        if (startupNativeVerification) {
          browserSmokeRunning = false;
          browserSmokeResult = smoke;
          browserSmokePassedAt = smoke?.ok
            ? new Date().toISOString()
            : undefined;
          browserSmokeError = smoke?.ok
            ? undefined
            : "The startup native browser verification did not pass.";
        }
        await writeFile(
          verificationReportPath,
          JSON.stringify({
            ...surface,
            serverSessionVerified,
            ...(runSmoke ? { smokePassed: smoke?.ok === true, smoke } : {}),
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            ...(startupNativeVerification
              ? {
                  verificationId:
                    process.env.CODEXGPT_BRIDGE_STARTUP_VERIFICATION_ID,
                  driverAttached: app.commandLine.hasSwitch(
                    "remote-debugging-port",
                  ),
                  testedAt: new Date().toISOString(),
                }
              : {}),
          }),
        );
        if (!startupNativeVerification) app.quit();
      })().catch(async () => {
        if (!startupNativeVerification) app.quit();
        else {
          browserSmokeRunning = false;
          browserSmokeError = "The startup native browser verification failed.";
          await writeFile(
            verificationReportPath,
            JSON.stringify({
              smokePassed: false,
              verificationId:
                process.env.CODEXGPT_BRIDGE_STARTUP_VERIFICATION_ID,
            }),
          ).catch(() => undefined);
        }
      });
    }
    void updateReminders.start();
    app.on("activate", showMainWindow);
  });
}

async function quitAfterMainWindowClosed(): Promise<void> {
  if (process.platform === "darwin") return;
  if (shuttingDown) return;
  if (systemTray !== undefined && !systemTray.tray.isDestroyed()) return;
  if (mainWindow !== undefined || shuttingDown) return;
  if ((await webOnlyIntegration.status()).managed) return;
  app.quit();
}

app.on("window-all-closed", () => {
  void quitAfterMainWindowClosed();
});

let shuttingDown = false;
app.on("before-quit", (event) => {
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  updateReminders.stop();
  void (async () => {
    try {
      // Cancel browser work before waiting for the HTTP server to drain.
      await passkeyLogin.close();
      await chatGptBrowser.close();
      await chromeChatGptHost.close();
      await stopResponsesGateway();
      systemTray?.tray.destroy();
      app.exit(0);
    } catch (error) {
      console.error("Bridge shutdown failed", error);
      systemTray?.tray.destroy();
      app.exit(1);
    }
  })();
});
