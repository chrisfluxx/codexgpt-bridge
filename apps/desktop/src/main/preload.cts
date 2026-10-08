import { contextBridge, ipcRenderer } from "electron";
import type { ChatGptProjectSettings } from "./chatgpt-project-types.js" with {
  "resolution-mode": "import",
};
import type { ModelExecutionReceipt } from "./model-selection-types.js" with {
  "resolution-mode": "import",
};
import type {
  OperationFailureCode,
  OperationRecovery,
} from "./operation-failure-types.js" with {
  "resolution-mode": "import",
};
import type { LocalBridgeUsageSummary } from "./model-usage-types.js" with {
  "resolution-mode": "import",
};
import type { ChatGptUsageSummary } from "./chatgpt-usage-types.js" with {
  "resolution-mode": "import",
};
import type { ReleaseUpdateStatus } from "./release-update-types.js" with {
  "resolution-mode": "import",
};
export type { ReleaseUpdateStatus } from "./release-update-types.js" with {
  "resolution-mode": "import",
};
import type { DesktopDoctorReport } from "./desktop-doctor-types.js" with {
  "resolution-mode": "import",
};
export type { DesktopDoctorReport } from "./desktop-doctor-types.js" with {
  "resolution-mode": "import",
};

export interface DesktopSettings {
  readonly freshConversationPerTurn?: boolean;
  readonly autoApproveToolCalls?: boolean;
  readonly silenceTimeoutSeconds?: number;
  readonly startAtLogin?: boolean;
  readonly interactionMode?: "automatic" | "manual";
  readonly manualPro?: boolean;
  readonly chatGptBrowserHost?: "embedded" | "chrome";
  readonly locale: "en" | "zh-TW" | "zh-CN" | "ja" | "ko";
  readonly temporaryChat: boolean;
  readonly chatGptProjects: ChatGptProjectSettings;
  readonly webToolMode: "simple" | "full";
  readonly fullMcpConnectorName: string;
  readonly fullMcpTunnelId?: string;
  readonly fullMcpRuntimeKeyFile?: string;
  readonly fullMcpTunnelClientPath?: string;
  readonly updateManifestUrl?: string;
  readonly updateManifestPath?: string;
}

export interface FullMcpStatus {
  readonly configured: boolean;
  readonly running: boolean;
  readonly ready: boolean;
  readonly mcpUrl?: string;
  readonly detail?: string;
}

export interface WebProviderStatus {
  readonly developmentProfile?: boolean;
  readonly subagents?: {
    activeTurns: number;
    pendingTools: number;
    ownedAgents: number;
    completedAgents: number;
    failedAgents: number;
  };
  readonly manualTasks?: readonly {
    readonly id: string;
    readonly threadId: string;
    readonly mode: string;
    readonly modelFamily?: string;
    readonly prompt: string;
    readonly images: readonly {
      ref: string;
      imageUrl: string;
      detail?: string;
    }[];
    readonly sent: boolean;
    readonly retained: boolean;
    readonly part: number;
    readonly total: number;
    readonly acknowledgement?: string;
  }[];
  readonly chromeLogin?: {
    readonly phase: "idle" | "waiting" | "ready" | "verifying" | "challenge";
    readonly verified: boolean;
    readonly error?: string;
  };
  readonly browserSmoke?: {
    readonly status: "not-run" | "running" | "passed" | "failed";
    readonly mode?: string;
    readonly passedAt?: string;
    readonly checks?: readonly {
      readonly id: string;
      readonly label: string;
      readonly passed: boolean;
    }[];
    readonly error?: string;
  };
  readonly passkeyLogin?: {
    readonly available: boolean;
    readonly phase: "idle" | "waiting" | "importing";
    readonly error?: string;
  };
  readonly webOnly?: {
    readonly enabled: boolean;
    readonly managed: boolean;
    readonly error?: string;
  };
  readonly repairable?: boolean;
  readonly tasks?: readonly {
    threadId: string;
    mode: string;
    state: string;
    stage?: string;
    queueAhead?: number;
    failureCode?: OperationFailureCode;
    recovery?: OperationRecovery;
    error?: string;
    titleSyncWarning?: string;
    modelReceipt?: ModelExecutionReceipt;
  }[];
  readonly queue?: {
    readonly active: number;
    readonly queued: number;
    readonly capacity: number;
    readonly cooldownSeconds: number;
  };
  readonly usage?: LocalBridgeUsageSummary;
  readonly officialUsage?: ChatGptUsageSummary;
  readonly running: boolean;
  readonly installed: boolean;
  readonly modelId: string;
  readonly modelIds: readonly string[];
  readonly baseUrl?: string;
  readonly configPath: string;
  readonly browserWindowOpen: boolean;
  readonly browserSignedIn: boolean;
  readonly error?: string;
  readonly toolMode: DesktopSettings["webToolMode"];
  readonly fullMcp?: FullMcpStatus;
}

let updateFocusPending = false;
const updateFocusListeners = new Set<() => void>();
ipcRenderer.on("update:focus", () => {
  if (!updateFocusListeners.size) updateFocusPending = true;
  else for (const listener of updateFocusListeners) listener();
});

const desktopApi = {
  onUpdateFocus: (listener: () => void): (() => void) => {
    updateFocusListeners.add(listener);
    if (updateFocusPending) {
      updateFocusPending = false;
      listener();
    }
    return () => {
      updateFocusListeners.delete(listener);
    };
  },
  setLocale: (locale: DesktopSettings["locale"]): Promise<DesktopSettings> =>
    ipcRenderer.invoke(
      "settings:set-locale",
      locale,
    ) as Promise<DesktopSettings>,
  setUpdateManifestUrl: (url: string): Promise<DesktopSettings> =>
    ipcRenderer.invoke(
      "settings:set-update-manifest-url",
      url,
    ) as Promise<DesktopSettings>,
  setChatGptBrowserHost: (
    host: "embedded" | "chrome",
  ): Promise<DesktopSettings> =>
    ipcRenderer.invoke(
      "settings:set-chatgpt-browser-host",
      host,
    ) as Promise<DesktopSettings>,
  setTemporaryChat: (enabled: boolean): Promise<DesktopSettings> =>
    ipcRenderer.invoke(
      "settings:set-temporary-chat",
      enabled,
    ) as Promise<DesktopSettings>,
  setAdvancedSettings: (
    value: Partial<DesktopSettings>,
  ): Promise<DesktopSettings> =>
    ipcRenderer.invoke(
      "settings:set-advanced",
      value,
    ) as Promise<DesktopSettings>,
  setChatGptProjectsEnabled: (enabled: boolean): Promise<DesktopSettings> =>
    ipcRenderer.invoke(
      "settings:set-chatgpt-projects-enabled",
      enabled,
    ) as Promise<DesktopSettings>,
  getSettings: (): Promise<DesktopSettings> =>
    ipcRenderer.invoke("settings:get") as Promise<DesktopSettings>,
  copyManualPrompt: (id: string): Promise<void> =>
    ipcRenderer.invoke("manual:copy", id) as Promise<void>,
  manualSent: (id: string): Promise<void> =>
    ipcRenderer.invoke("manual:sent", id) as Promise<void>,
  completeManual: (id: string, text: string): Promise<void> =>
    ipcRenderer.invoke("manual:complete", id, text) as Promise<void>,
  manualAcknowledge: (id: string, acknowledgement: string): Promise<void> =>
    ipcRenderer.invoke(
      "manual:acknowledge",
      id,
      acknowledgement,
    ) as Promise<void>,
  cancelManual: (id: string): Promise<void> =>
    ipcRenderer.invoke("manual:cancel", id) as Promise<void>,
  openManualChat: (): Promise<void> =>
    ipcRenderer.invoke("manual:open") as Promise<void>,
  getUpdateStatus: (): Promise<ReleaseUpdateStatus> =>
    ipcRenderer.invoke("update:status") as Promise<ReleaseUpdateStatus>,
  checkForUpdate: (): Promise<ReleaseUpdateStatus> =>
    ipcRenderer.invoke("update:check") as Promise<ReleaseUpdateStatus>,
  downloadUpdate: (): Promise<ReleaseUpdateStatus> =>
    ipcRenderer.invoke("update:download") as Promise<ReleaseUpdateStatus>,
  installUpdate: (): Promise<ReleaseUpdateStatus> =>
    ipcRenderer.invoke("update:install") as Promise<ReleaseUpdateStatus>,
  runDoctor: (): Promise<DesktopDoctorReport> =>
    ipcRenderer.invoke("doctor:run") as Promise<DesktopDoctorReport>,
  repairDoctor: (): Promise<DesktopDoctorReport> =>
    ipcRenderer.invoke("doctor:repair") as Promise<DesktopDoctorReport>,
  exportDoctor: (): Promise<string | null> =>
    ipcRenderer.invoke("doctor:export") as Promise<string | null>,
  openWebTask: (id: string): Promise<void> =>
    ipcRenderer.invoke("provider:open-task", id) as Promise<void>,
  cancelWebTask: (id: string): Promise<void> =>
    ipcRenderer.invoke("provider:cancel-task", id) as Promise<void>,
  getWebProviderStatus: (): Promise<WebProviderStatus> =>
    ipcRenderer.invoke("provider:status") as Promise<WebProviderStatus>,
  refreshChatGptUsage: (): Promise<WebProviderStatus> =>
    ipcRenderer.invoke("provider:usage-refresh") as Promise<WebProviderStatus>,
  setWebOnlyMode: (enabled: false): Promise<WebProviderStatus> =>
    ipcRenderer.invoke(
      "provider:web-only",
      enabled,
    ) as Promise<WebProviderStatus>,
  setFullMcp: (settings: {
    mode: DesktopSettings["webToolMode"];
    connectorName: string;
    tunnelId: string;
    runtimeApiKey: string;
    tunnelClientPath: string;
  }): Promise<DesktopSettings> =>
    ipcRenderer.invoke(
      "settings:set-full-mcp",
      settings,
    ) as Promise<DesktopSettings>,
  openChatGptLogin: (): Promise<WebProviderStatus> =>
    ipcRenderer.invoke("provider:open-login") as Promise<WebProviderStatus>,
  continueChromeLogin: (): Promise<WebProviderStatus> =>
    ipcRenderer.invoke(
      "provider:chrome-login-continue",
    ) as Promise<WebProviderStatus>,
  beginPasskeyLogin: (): Promise<WebProviderStatus> =>
    ipcRenderer.invoke("provider:passkey-begin") as Promise<WebProviderStatus>,
  continuePasskeyLogin: (): Promise<WebProviderStatus> =>
    ipcRenderer.invoke(
      "provider:passkey-continue",
    ) as Promise<WebProviderStatus>,
  runBrowserSmoke: (): Promise<WebProviderStatus> =>
    ipcRenderer.invoke("provider:browser-smoke") as Promise<WebProviderStatus>,
  installWebProvider: (): Promise<WebProviderStatus> =>
    ipcRenderer.invoke("provider:install") as Promise<WebProviderStatus>,
  repairWebProvider: (): Promise<WebProviderStatus> =>
    ipcRenderer.invoke("provider:repair") as Promise<WebProviderStatus>,
  removeWebProvider: (): Promise<WebProviderStatus> =>
    ipcRenderer.invoke("provider:remove") as Promise<WebProviderStatus>,
};

contextBridge.exposeInMainWorld("codexgptBridge", desktopApi);

export type DesktopApi = typeof desktopApi;
