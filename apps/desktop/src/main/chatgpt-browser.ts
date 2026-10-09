import type { ChatGptWindow, CreateChatGptWindow } from "./chatgpt-window.js";
import { SilenceWatchdog } from "./advanced-settings.js";
import { oneTimeToolApprovalTarget } from "./tool-approval.js";
import {
  BRIDGE_WEB_TASK_CONCURRENCY,
  ChatGptRateLimitError,
  TurnPool,
} from "./turn-pool.js";
import { delay } from "./browser-delay.js";
import {
  OperationJournal,
  OperationRecoveryError,
} from "./operation-journal.js";
import {
  classifyOperationFailure,
  operationRecovery,
  type OperationFailureCode,
  type OperationRecovery,
} from "./operation-failure.js";
import { planContextSync, type ContextReceipt } from "./context-sync.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
} from "electron";
import { recordModelDiagnostic } from "./model-diagnostics.js";
import {
  UnsupportedWebNativeToolError,
  BridgeStreamError,
  isBridgeTextStreamCandidate,
  type BridgeGeneratedImage,
  type BridgeGeneratedImagesResult,
  type BridgeProgressStage,
  type BridgePublicCommentary,
  type BridgeWebMode,
  type BridgeNativeModelFamily,
  type RunWebTurnInput,
  synchronizeBridgeExecutionPreflight,
  bridgeExecutionLimitProblem,
  BRIDGE_FULL_TURN_TIMEOUT_MS,
  RetainedFullSourceUnavailableError,
  planFullContextTransfer,
  FullContextTransferError,
  type FullContextMessage,
} from "@codexgpt-bridge/responses-gateway";
import {
  CHAT_GPT_RICH_OUTPUT_ONLY,
  chatGptAssistantText,
  ChatGptCompletionTracker,
  hasChatGptResponseStarted,
  isChatGptSubmissionAcknowledged,
  isConfirmedStalePageStop,
  isRecoverableToolFailure,
  shouldRetryTransientImageGeneration,
  type ChatGptConfirmedCompletion,
  type ChatGptRecoverableToolFailure,
} from "./chatgpt-completion.js";
import { chatGptDomToMarkdown } from "./chatgpt-markdown.js";
import {
  watchChatGptGeneration,
  sameCompletedBody,
} from "./chatgpt-generation.js";
import {
  CompletionTrace,
  PreparationError,
  type CompletionDiagnostic,
} from "./completion-diagnostics.js";
import {
  observeChatGpt,
  type ChatGptBrowserObservation,
} from "./chatgpt-observation.js";
import {
  downloadGeneratedImages,
  withMediaTextFallback,
} from "./chatgpt-image-download.js";
import { ChatGptConversations } from "./chatgpt-conversations.js";
import { ChatGptProjectBrowser } from "./chatgpt-project-browser.js";
import { syncChatGptTitle } from "./chatgpt-title.js";
import {
  assertProjectDestination,
  normalizeChatGptProjectUrl,
} from "./chatgpt-projects.js";
import {
  availableBridgeModesFromLabels,
  availableBridgeModesFromSlider,
  planEffortSliderSelection,
} from "./chatgpt-mode.js";
import { SharedSerialRunner } from "./shared-serial-runner.js";
import {
  observeModelSelection,
  verifyModelSelection,
  isModeOnlySelectionVerified,
  modelPreference,
  modelLabelsEqual,
  modelSelectionLabelMatches,
  nativeModelDescriptionsMatch,
  type ModelExecutionReceipt,
  type ModelUiObservation,
} from "./model-selection.js";
import { observeModelMenu, type ModelMenuKind } from "./model-menu.js";
import {
  temporaryChatUrl,
  isTemporaryChatUrl,
  observeTemporaryChat,
} from "./chatgpt-temporary.js";
import { composerModelControlTarget } from "./model-controls.js";
import {
  availableModelModeLabels,
  modelPickerRoots,
  revealModelFamilyOptions,
  readModelSlider,
  type ModelSliderState,
} from "./model-picker-surface.js";
import {
  acknowledgeChatGptRateLimitDialog,
  observeChatGptChallengeReadiness,
  observeChatGptPageBlock,
  observeChatGptServerSessionNotice,
  ChatGptVerificationRequiredError,
  type ChatGptPageBlock,
  type ChatGptServerSessionNotice,
} from "./chatgpt-page-access.js";
import {
  ChatGptSessionChallengeError,
  ChatGptSessionError,
  probeChatGptPageSession,
  type ChatGptUsageAccount,
} from "./chatgpt-session-probe.js";
import {
  ChatGptBackendAccess,
  subscribeChatGptBackendResponses,
} from "./chatgpt-backend-recovery.js";
import {
  classifyChatGptUsageModel,
  type ChatGptUsageModel,
} from "./chatgpt-usage.js";
import {
  browserZoomPercent,
  nextBrowserZoomFactor,
  type BrowserZoomAction,
} from "./browser-controls.js";
import { allowedAuthenticationPopupUrl } from "./authentication-popup.js";
import type { PasskeyLoginState } from "./passkey-login-state.js";
import {
  BROWSER_SMOKE_PROMPT,
  completeBrowserSmoke,
  selectBrowserSmokeMode,
  type BrowserSmokeResult,
} from "./browser-smoke.js";

const CHATGPT_PARTITION = "persist:codexgpt-bridge-chatgpt";
const DEFAULT_CHATGPT_URL = "https://chatgpt.com/";
const TURN_TIMEOUT_MS = 15 * 60_000;
const SUBMISSION_TIMEOUT_MS = 15_000;
const RESPONSE_START_TIMEOUT_MS = 60_000;
const WEB_NATIVE_TOOL_TIMEOUT_MS = 10_000;
const RATE_LIMIT_RESPONSE_GRACE_MS = 5_000;
const CLOUDFLARE_CHALLENGE_TIMEOUT_MS = 10 * 60_000;
const POST_COMPLETION_RATE_LIMIT_WATCH_MS = 5_000;
const CHATGPT_MAX_INPUT_IMAGES = 10;
const CHATGPT_MAX_IMAGE_BYTES = 20_000_000;
const CHATGPT_MAX_IMAGE_BYTES_PER_TURN = 50_000_000;
const RETAINED_PAGE_IDLE_MS = 30 * 60_000;
const IMAGE_GENERATION_RETRY_PROMPT =
  "Retry the immediately preceding image-generation request now, exactly once. Use the image generation tool directly. Do not ask the user to repeat or clarify the same request. If the tool fails again, report the failure.";
const FULL_MCP_RATE_LIMIT_RECOVERY_PROMPT =
  "Continue the immediately preceding Codex Full MCP task after the temporary rate limit. This is recovery of the same task, not a new task. First resume or inspect any already-returned running exec cell and collect its results. Do not repeat completed tool calls or completed subagents. Create a replacement only for a terminally failed subagent, then finish the original requested result and return the final answer directly without transport markers.";
const MAX_FULL_MCP_RATE_LIMIT_RECOVERIES = 2;
const INVISIBLE_COMPOSER_ARTIFACTS = /[\u200b-\u200d\u2060\ufeff]/gu;

class SynchronizedContextLimitError extends Error {
  readonly code = "bridge_context_limit_exceeded";

  constructor(message: string) {
    super(message);
    this.name = "SynchronizedContextLimitError";
  }
}

function hasComposerText(value: string): boolean {
  return value.replace(INVISIBLE_COMPOSER_ARTIFACTS, "").trim().length > 0;
}

const IMAGE_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

interface ChatGptImageFile {
  readonly name: string;
  readonly mimeType: string;
  readonly base64: string;
}

function chatGptImageFiles(
  images: RunWebTurnInput["images"],
): readonly ChatGptImageFile[] {
  if (images.length > CHATGPT_MAX_INPUT_IMAGES) {
    throw new Error(
      `ChatGPT Web accepts at most ${CHATGPT_MAX_INPUT_IMAGES} input images per turn.`,
    );
  }

  let totalBytes = 0;
  return images.map((image) => {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(
      image.imageUrl,
    );
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new Error(
        `ChatGPT Web input image ${image.ref} must be an inline base64 data URL.`,
      );
    }
    const mimeType = match[1].toLowerCase();
    const extension = IMAGE_EXTENSIONS.get(mimeType);
    if (extension === undefined) {
      throw new Error(
        `ChatGPT Web input image ${image.ref} has unsupported media type: ${mimeType}.`,
      );
    }
    if (match[2].length % 4 !== 0) {
      throw new Error(
        `ChatGPT Web input image ${image.ref} contains invalid base64 data.`,
      );
    }
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length === 0) {
      throw new Error(`ChatGPT Web input image ${image.ref} is empty.`);
    }
    if (bytes.length > CHATGPT_MAX_IMAGE_BYTES) {
      throw new Error(`ChatGPT Web input image ${image.ref} exceeds 20 MB.`);
    }
    totalBytes += bytes.length;
    if (totalBytes > CHATGPT_MAX_IMAGE_BYTES_PER_TURN) {
      throw new Error("ChatGPT Web input images exceed 50 MB per turn.");
    }
    return {
      name: `${image.ref}.${extension}`,
      mimeType,
      base64: bytes.toString("base64"),
    };
  });
}

export interface ChatGptBrowserStatus {
  readonly windowOpen: boolean;
  readonly signedIn: boolean;
  readonly url?: string;
}

export interface ChatGptAccountCapabilities {
  readonly availableModes: readonly BridgeWebMode[];
  readonly source: "slider" | "plain" | "configure" | "no-model-control";
}

interface Observation extends Omit<
  ChatGptBrowserObservation,
  "renderedText" | "codeTexts"
> {
  readonly text: string;
  readonly terminalConfirmed: boolean;
}

type IntelligenceMode = "instant" | "thinking" | "pro";
type IntelligenceEffort = "light" | "standard" | "extended" | "heavy";
type IntelligenceBridgeMode = Exclude<BridgeWebMode, "luna" | "think">;
type BrowserNavigationAction = "back" | "forward" | "reload";

interface IntelligenceTarget {
  readonly model?: string;
  readonly mode: IntelligenceMode;
  readonly effort?: IntelligenceEffort;
  readonly label: string;
}

interface IntelligenceConfigureOptions {
  readonly models: readonly string[];
  readonly modes: readonly IntelligenceMode[];
  readonly efforts: readonly string[];
  readonly selectedModel: string | null;
  readonly selectedMode: IntelligenceMode | null;
  readonly selectedEffort: IntelligenceEffort | null;
  readonly textSnippet: string;
}

const INTELLIGENCE_MODE_LABELS: Record<IntelligenceMode, string> = {
  instant: "Instant",
  thinking: "Thinking",
  pro: "Pro",
};
const INTELLIGENCE_EFFORT_LABELS: Record<IntelligenceEffort, string> = {
  light: "Light",
  standard: "Standard",
  extended: "Extended",
  heavy: "Heavy",
};

function bridgeIntelligenceTarget(
  mode: IntelligenceBridgeMode,
  model?: string,
): IntelligenceTarget {
  const selected = model ? { model } : {};
  switch (mode) {
    case "instant":
      return {
        ...selected,
        mode: "instant",
        label: `${model ?? "current model"} Instant`,
      };
    case "medium":
      return {
        ...selected,
        mode: "thinking",
        effort: "standard",
        label: `${model ?? "current model"} Thinking Standard`,
      };
    case "high":
      return {
        ...selected,
        mode: "thinking",
        effort: "extended",
        label: `${model ?? "current model"} Thinking Extended`,
      };
    case "extra-high":
      return {
        ...selected,
        mode: "thinking",
        effort: "heavy",
        label: `${model ?? "current model"} Thinking Heavy`,
      };
    case "pro":
      return {
        ...selected,
        mode: "pro",
        effort: "extended",
        label: `${model ?? "current model"} Pro Extended`,
      };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function turnKey(input: RunWebTurnInput): string {
  const hash = createHash("sha256");
  hash.update(input.threadId ?? "unscoped");
  hash.update("\0");
  hash.update(input.turnId ?? "unscoped");
  hash.update("\0");
  hash.update(input.mode);
  hash.update("\0");
  hash.update(input.operationId ?? "standalone");
  hash.update("\0");
  hash.update(input.modelFamily ?? "current");
  hash.update("\0");
  hash.update(input.allowWebNativeTools ? "full-mcp" : "simple");
  hash.update("\0");
  hash.update(input.prompt);
  // Codex can rebuild instructions or context metadata when it reconnects to the
  // same native turn. Those fields are not a new browser action. Keep the replay
  // key tied to the actual turn stage so a transport reconnect cannot submit the
  // user's prompt to a second ChatGPT conversation.
  for (const image of input.images) {
    hash.update("\0");
    hash.update(image.ref);
    hash.update("\0");
    hash.update(image.detail ?? "");
    hash.update("\0");
    hash.update(image.imageUrl);
  }
  return hash.digest("hex");
}

function formatConfigureOptions(options: IntelligenceConfigureOptions): string {
  const parts = [
    options.selectedModel ? `model=${options.selectedModel}` : undefined,
    options.selectedMode ? `mode=${options.selectedMode}` : undefined,
    options.selectedEffort ? `effort=${options.selectedEffort}` : undefined,
    options.models.length > 0
      ? `models=${options.models.join(",")}`
      : undefined,
    options.modes.length > 0 ? `modes=${options.modes.join(",")}` : undefined,
    options.efforts.length > 0
      ? `efforts=${options.efforts.join(",")}`
      : undefined,
  ].filter((part) => part !== undefined);
  return parts.length > 0 ? parts.join("; ") : options.textSnippet;
}

class ChatGptBrowserSession {
  #operationKey: string | undefined;
  #usageAccount: ChatGptUsageAccount | undefined;
  queueAhead = 0;
  stage = "idle";
  failureCode: OperationFailureCode | undefined;
  titleSyncWarning: string | undefined;
  #preparationTrace: CompletionTrace | undefined;
  #temporaryChat = false;
  #verifiedTemporaryDocumentToken: string | undefined;
  #confirmedCompletion: ChatGptConfirmedCompletion | undefined;
  #temporarySource:
    | (ChatGptConfirmedCompletion & {
        url: string;
        thread: string;
        assistantToken: string;
        documentToken: string;
        streamConfirmed: boolean;
        connectorName?: string;
      })
    | undefined;
  #recoverableToolFailure: ChatGptRecoverableToolFailure | undefined;
  readonly snapshots = new Map<
    string,
    {
      text: string;
      listeners: Set<(text: string) => void>;
      streamText: string;
      streamListeners: Set<(text: string) => void>;
      progress: BridgeProgressStage[];
      progressListeners: Set<(stage: BridgeProgressStage) => void>;
      commentary: BridgePublicCommentary[];
      commentaryListeners: Set<(commentary: BridgePublicCommentary) => void>;
    }
  >();
  state:
    | "idle"
    | "queued"
    | "generating"
    | "completed"
    | "waiting-tools"
    | "waiting-challenge"
    | "cancelled"
    | "failed" = "idle";
  mode = "";
  error: string | undefined;
  #cancel: AbortController | undefined;
  #activeTurnSignal: AbortSignal | undefined;
  #activeProgress: ((stage: BridgeProgressStage) => void) | undefined;
  #challengeRecovery: Promise<void> | undefined;
  readonly #backendAccess = new WeakMap<ChatGptWindow, ChatGptBackendAccess>();
  readonly #presentedChallengeWindows = new WeakSet<ChatGptWindow>();
  #postCompletionRateLimitWatch: AbortController | undefined;
  #submissionInFlight = false;
  #observedRateLimit:
    | { readonly error: ChatGptRateLimitError; readonly observedAt: number }
    | undefined;
  #taskCancellation = new AbortController();
  #receipt: ContextReceipt | undefined;
  modelReceipt: ModelExecutionReceipt | undefined;
  #lastThread: string | undefined;
  cancel(): void {
    this.#cancel?.abort();
    this.#postCompletionRateLimitWatch?.abort();
    this.#taskCancellation.abort();
    this.#taskCancellation = new AbortController();
    if (["waiting-tools", "waiting-challenge"].includes(this.state)) {
      this.state = "cancelled";
      this.#refreshBrowserControls();
    }
  }
  readonly #baseUrl: string;
  #window: ChatGptWindow | undefined;
  #idlePageTimer: NodeJS.Timeout | undefined;
  readonly #authenticationPopups = new Set<ChatGptWindow>();
  #authenticationProbe: Promise<void> | undefined;
  #suppressAuthenticationCompletion = false;
  readonly #conversations: ChatGptConversations;
  #activeThread: string | undefined;
  readonly #pendingImages = new Map<
    string,
    { text: string; urls: readonly string[]; expires: number }
  >();
  readonly #replayableFailures = new WeakSet<object>();
  readonly #turnRunner = new SharedSerialRunner<
    string | BridgeGeneratedImagesResult
  >(
    2 * 60_000,
    15_000,
    5 * 60_000,
    (error) =>
      typeof error === "object" &&
      error !== null &&
      this.#replayableFailures.has(error),
  );

  constructor(
    baseUrl: string,
    conversations: ChatGptConversations,
    private readonly pool: TurnPool,
    private readonly journal: OperationJournal,
    private readonly recordModel?: (
      receipt: ModelExecutionReceipt,
    ) => Promise<void>,
    private readonly recordCompletion?: (
      record: CompletionDiagnostic,
    ) => Promise<void>,
    private readonly resolveProject?: (
      name: string,
      signal: AbortSignal,
    ) => Promise<string>,
    private readonly readThreadTitle?: (
      threadId: string,
    ) => Promise<string | undefined>,
    private readonly allowAuthenticationPopups = false,
    private readonly recordAcceptedUsage?: (input: {
      readonly eventId: string;
      readonly account: ChatGptUsageAccount;
      readonly mode: BridgeWebMode;
      readonly modelLabel?: string | null;
    }) => Promise<void>,
    private readonly createWindow: CreateChatGptWindow = async (options) =>
      new BrowserWindow(options),
  ) {
    this.#baseUrl = baseUrl;
    this.#conversations = conversations;
  }

  async openLoginWindow(show = true): Promise<ChatGptBrowserStatus> {
    const window = await this.#ensureWindow(show);
    if (show) {
      window.show();
      window.focus();
    }
    return this.status();
  }

  usageAccount(): ChatGptUsageAccount | undefined {
    return this.#usageAccount;
  }

  async refreshUsageAccount(): Promise<ChatGptUsageAccount | undefined> {
    const window = await this.#ensureWindow(false);
    await this.#ensureReady(window, AbortSignal.timeout(25_000));
    return this.#usageAccount;
  }

  async #recordAcceptedSend(
    input: RunWebTurnInput,
    suffix = "primary",
  ): Promise<void> {
    if (!this.#operationKey || !this.#usageAccount || !this.recordAcceptedUsage)
      return;
    const eventId =
      suffix === "primary"
        ? this.#operationKey
        : createHash("sha256")
            .update(`${this.#operationKey}:${suffix}`)
            .digest("hex");
    await this.recordAcceptedUsage({
      eventId,
      account: this.#usageAccount,
      mode: input.mode,
      modelLabel:
        this.modelReceipt?.observed.model ??
        this.modelReceipt?.requestedModel ??
        null,
    });
  }

  async openTask(): Promise<void> {
    const window = await this.#ensureWindow(true);
    if (
      !["generating", "queued", "waiting-challenge"].includes(this.state) &&
      this.#lastThread
    ) {
      const url = await this.#conversations.get(this.#lastThread);
      if (url && window.webContents.getURL() !== url) await window.loadURL(url);
    }
    window.show();
    window.focus();
  }

  #navigationAllowed(): boolean {
    return ![
      "queued",
      "generating",
      "waiting-tools",
      "waiting-challenge",
    ].includes(this.state);
  }

  #runNavigation(window: ChatGptWindow, action: BrowserNavigationAction): void {
    if (
      window !== this.#window ||
      window.isDestroyed() ||
      !this.#navigationAllowed()
    )
      return;
    const history = window.webContents.navigationHistory;
    if (action === "back" && history.canGoBack()) history.goBack();
    else if (action === "forward" && history.canGoForward())
      history.goForward();
    else if (action === "reload") window.webContents.reload();
    this.#refreshBrowserControls(window);
  }

  #runZoom(window: ChatGptWindow, action: BrowserZoomAction): void {
    if (window !== this.#window || window.isDestroyed()) return;
    window.webContents.setZoomFactor(
      nextBrowserZoomFactor(window.webContents.getZoomFactor(), action),
    );
    this.#refreshBrowserControls(window);
  }

  #refreshBrowserControls(window = this.#window): void {
    if (!window || window.isDestroyed()) return;
    const history = window.webContents.navigationHistory;
    const navigationAllowed = this.#navigationAllowed();
    const zoom = browserZoomPercent(window.webContents.getZoomFactor());
    const template = [
      {
        label: "Navigate",
        submenu: [
          {
            label: "Back",
            accelerator: "Alt+Left",
            enabled: navigationAllowed && history.canGoBack(),
            click: () => this.#runNavigation(window, "back"),
          },
          {
            label: "Forward",
            accelerator: "Alt+Right",
            enabled: navigationAllowed && history.canGoForward(),
            click: () => this.#runNavigation(window, "forward"),
          },
          { type: "separator" },
          {
            label: "Reload",
            accelerator: "CommandOrControl+R",
            enabled: navigationAllowed,
            click: () => this.#runNavigation(window, "reload"),
          },
        ],
      },
      {
        label: `Zoom ${zoom}%`,
        submenu: [
          {
            label: "Zoom In",
            accelerator: "CommandOrControl+=",
            enabled: zoom < 200,
            click: () => this.#runZoom(window, "in"),
          },
          {
            label: "Zoom Out",
            accelerator: "CommandOrControl+-",
            enabled: zoom > 50,
            click: () => this.#runZoom(window, "out"),
          },
          {
            label: "Reset Zoom",
            accelerator: "CommandOrControl+0",
            enabled: zoom !== 100,
            click: () => this.#runZoom(window, "reset"),
          },
        ],
      },
    ] satisfies MenuItemConstructorOptions[];
    window.setMenu(Menu.buildFromTemplate(template));
    window.setMenuBarVisibility(true);
  }

  #closeAuthenticationPopups(): void {
    for (const popup of [...this.#authenticationPopups]) {
      this.#authenticationPopups.delete(popup);
      if (!popup.isDestroyed()) popup.destroy();
    }
  }

  #probeAuthenticationCompletion(
    owner: ChatGptWindow,
    closeOnSuccess: boolean,
  ): void {
    if (
      this.#suppressAuthenticationCompletion ||
      this.#authenticationProbe ||
      owner !== this.#window ||
      owner.isDestroyed()
    )
      return;
    const operation = (async () => {
      try {
        await probeChatGptPageSession(
          this.#baseUrl,
          owner.webContents,
          AbortSignal.timeout(7_000),
          { timeoutMs: 5_000 },
        );
      } catch {
        return;
      }
      if (owner !== this.#window || owner.isDestroyed()) return;
      if (closeOnSuccess) {
        this.#suppressAuthenticationCompletion = true;
        try {
          this.#closeAuthenticationPopups();
        } finally {
          this.#suppressAuthenticationCompletion = false;
        }
      }
      const readiness = await owner.webContents
        .executeJavaScript<ReturnType<typeof observeChatGptChallengeReadiness>>(
          `(${observeChatGptChallengeReadiness.toString()})(${observeChatGptPageBlock.toString()})`,
        )
        .catch(() => ({ ready: false, blocked: null }));
      if (!readiness.ready && readiness.blocked !== "cloudflare-challenge")
        await owner.loadURL(this.#baseUrl).catch(() => undefined);
      if (owner.isDestroyed()) return;
      owner.show();
      owner.focus();
    })().finally(() => {
      if (this.#authenticationProbe === operation)
        this.#authenticationProbe = undefined;
    });
    this.#authenticationProbe = operation;
  }

  #adoptAuthenticationPopup(owner: ChatGptWindow, popup: ChatGptWindow): void {
    this.#authenticationPopups.add(popup);
    popup.setMenu(null);
    const blockUnexpectedNavigation = (event: Electron.Event, url: string) => {
      if (!allowedAuthenticationPopupUrl(url, this.#baseUrl))
        event.preventDefault();
    };
    popup.webContents.on("will-navigate", blockUnexpectedNavigation);
    popup.webContents.on("will-redirect", blockUnexpectedNavigation);
    popup.webContents.setWindowOpenHandler(({ url }) => {
      if (allowedAuthenticationPopupUrl(url, this.#baseUrl)) {
        void popup.loadURL(url).catch(() => undefined);
      }
      return { action: "deny" };
    });
    popup.webContents.on("did-stop-loading", () =>
      this.#probeAuthenticationCompletion(owner, true),
    );
    popup.on("closed", () => {
      const owned = this.#authenticationPopups.delete(popup);
      if (
        owned &&
        !this.#suppressAuthenticationCompletion &&
        owner === this.#window &&
        !owner.isDestroyed()
      ) {
        owner.show();
        owner.focus();
        this.#probeAuthenticationCompletion(owner, false);
      }
    });
  }

  async status(): Promise<ChatGptBrowserStatus> {
    const window = this.#window;
    if (window === undefined || window.isDestroyed()) {
      return { windowOpen: false, signedIn: false };
    }
    const signedIn = await window.webContents
      .executeJavaScript(
        `Boolean(document.querySelector('#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]'))`,
        true,
      )
      .catch(() => false);
    return {
      windowOpen: window.isVisible(),
      signedIn: signedIn === true,
      url: window.webContents.getURL(),
    };
  }

  async probeCapabilities(): Promise<ChatGptAccountCapabilities> {
    const window = await this.#ensureWindow(false);
    const signal = AbortSignal.timeout(25_000);
    await this.#ensureReady(window, signal);
    await this.#dismissChatGptMenus(window);
    try {
      let menu = await this.#openModelMenu(window, signal);
      if (menu === "closed") {
        // A fully loaded composer with no model control is the stable Luna
        // account shape. Prove the optional Think command by toggling it and
        // restoring the original state before publishing account routes.
        await delay(1_000, signal);
        const target = await window.webContents
          .executeJavaScript(
            `(${composerModelControlTarget.toString()})()`,
            true,
          )
          .catch(() => undefined);
        if (target === undefined) {
          const observed = await this.#readSelection(window);
          if (
            observed.ambiguous ||
            observed.disabled ||
            (observed.mode !== "luna" && observed.mode !== "think")
          ) {
            throw new Error(
              "ChatGPT has no model picker, but its Luna state could not be verified.",
            );
          }
          if (observed.mode === "think") {
            return {
              availableModes: ["luna", "think"],
              source: "no-model-control",
            };
          }
          const thinkAvailable = await this.#setLunaThinkMode(
            window,
            true,
            signal,
            true,
          );
          if (thinkAvailable) {
            await this.#setLunaThinkMode(window, false, signal);
          }
          return {
            availableModes: thinkAvailable ? ["luna", "think"] : ["luna"],
            source: "no-model-control",
          };
        }
        menu = await this.#openModelMenu(window, signal);
      }
      if (menu === "loading" || menu === "closed") {
        await recordModelDiagnostic(app.getPath("userData"), async () =>
          window.webContents.executeJavaScript(
            `(() => {
              const roots = (${modelPickerRoots.toString()})();
              const elements = [...new Set(roots.flatMap(root => [...root.querySelectorAll('*')]))];
              return {
                menuState: '${menu}',
                rootsCount: roots.length,
                elementsCount: elements.length,
                effortsCount: elements.filter(el => el.matches('[role="menuitemradio"], [role="option"]')).length,
                modelsCount: elements.filter(el => el.matches('[data-model]')).length,
                slidersCount: elements.filter(el => el.matches('[role="slider"], input[type="range"]')).length,
                composerFound: !!document.querySelector('#prompt-textarea, textarea[data-testid="prompt-textarea"]'),
              };
            })()`,
            true,
          ),
        );
        throw new Error(
          "ChatGPT model controls did not finish loading. Reload the login window and retry installation.",
        );
      }
      if (menu === "slider") {
        let slider = await this.#readEffortSlider(window, false);
        for (
          let attempt = 0;
          slider === undefined && attempt < 8;
          attempt += 1
        ) {
          await delay(150, signal);
          slider = await this.#readEffortSlider(window, false);
        }
        if (slider === undefined || slider.disabled) {
          throw new Error(
            "ChatGPT reasoning controls are unavailable for capability discovery.",
          );
        }
        return {
          availableModes: availableBridgeModesFromSlider(
            slider.min,
            slider.max,
          ),
          source: "slider",
        };
      }
      if (menu === "plain") {
        const labels = await this.#execute<readonly string[]>(
          window,
          "available-model-modes",
          `(${availableModelModeLabels.toString()})(${modelPickerRoots.toString()})`,
        );
        const availableModes = availableBridgeModesFromLabels(labels);
        if (availableModes.length === 0) {
          throw new Error(
            "ChatGPT did not expose any recognized enabled model modes.",
          );
        }
        return { availableModes, source: "plain" };
      }
      if (menu === "configure-entry") {
        if (!(await this.#openIntelligenceConfigure(window, signal))) {
          throw new Error(
            "ChatGPT Intelligence controls could not be opened for capability discovery.",
          );
        }
        menu = "configure";
      }
      if (menu === "configure") {
        const options = await this.#readConfigureOptions(window);
        const labels = [
          ...(options.modes.includes("instant") ? ["instant"] : []),
          ...(options.modes.includes("pro") ? ["pro"] : []),
          ...options.efforts,
          ...(options.selectedEffort ? [options.selectedEffort] : []),
        ];
        const availableModes = availableBridgeModesFromLabels(labels);
        if (availableModes.length === 0) {
          throw new Error(
            `ChatGPT Intelligence controls did not prove a supported Bridge mode (${formatConfigureOptions(options)}).`,
          );
        }
        return { availableModes, source: "configure" };
      }
      if (menu === "models") {
        const observed = await this.#readSelection(window);
        const isPro = await this.#execute<boolean>(
          window,
          "check-account-is-pro",
          `(() => {
            const sidebar = document.querySelector('aside, nav, [data-testid*="sidebar"], [data-testid*="user-menu"], [data-testid*="profile"]');
            const text = (sidebar?.textContent || document.body.innerText || '');
            if (/\\bPro\\b/i.test(text)) return true;
            const meta = document.querySelector('script#__NEXT_DATA__');
            if (meta && /"plan(?:_type)?"\\s*:\\s*"pro"/i.test(meta.textContent || '')) return true;
            return false;
          })()`,
        ).catch(() => false);

        if (isPro) {
          return {
            availableModes: ["instant", "medium", "high", "extra-high", "pro"],
            source: "plain",
          };
        }
        if (observed.mode) {
          return {
            availableModes: [observed.mode],
            source: "plain",
          };
        }
        return {
          availableModes: ["high"],
          source: "plain",
        };
      }
      throw new Error("ChatGPT exposed an unsupported model control surface.");
    } finally {
      await this.#dismissChatGptMenus(window);
    }
  }

  async probeNativeModelFamilies(): Promise<
    readonly BridgeNativeModelFamily[]
  > {
    const window = await this.#ensureWindow(false);
    const signal = AbortSignal.timeout(25_000);
    await this.#ensureReady(window, signal);
    await this.#dismissChatGptMenus(window);
    try {
      const menu = await this.#openModelMenu(window, signal);
      if (menu !== "slider" && menu !== "models") return [];
      await this.#execute<boolean>(
        window,
        "expose-native-family-options",
        `(${revealModelFamilyOptions.toString()})(${modelPickerRoots.toString()})`,
      );
      await delay(250, signal);
      const observed = await this.#readSelection(window);
      const families: BridgeNativeModelFamily[] = [];
      for (const family of ["5.6", "6", "6.1"] as const) {
        if (
          observed.availableModels.filter((label) =>
            modelSelectionLabelMatches(`bridge-native:${family}`, label),
          ).length === 1
        )
          families.push(family);
      }
      return families;
    } finally {
      await this.#dismissChatGptMenus(window);
    }
  }

  async runTurn(
    input: RunWebTurnInput,
  ): Promise<string | BridgeGeneratedImagesResult> {
    // Recovery can stop before browser preparation; Open task must still find its saved URL.
    this.#lastThread = input.threadId;
    // Requests without native turn identity cannot be safely replayed after settlement: two
    // intentional API calls may contain identical text. Native Codex requests always carry a
    // turn id, so only those receive a stable reconnect key.
    const key =
      input.turnId === undefined
        ? `${turnKey(input)}:${randomUUID()}`
        : turnKey(input);
    if (!this.#turnRunner.hasReplay(key)) this.snapshots.delete(key);
    let snapshot = this.snapshots.get(key);
    if (!snapshot) {
      snapshot = {
        text: "",
        listeners: new Set(),
        streamText: "",
        streamListeners: new Set(),
        progress: [],
        progressListeners: new Set(),
        commentary: [],
        commentaryListeners: new Set(),
      };
      this.snapshots.set(key, snapshot);
      if (this.snapshots.size > 100) {
        for (const [old, entry] of this.snapshots)
          if (
            old !== key &&
            !entry.listeners.size &&
            !entry.streamListeners.size &&
            !entry.progressListeners.size &&
            !entry.commentaryListeners.size
          ) {
            this.snapshots.delete(old);
            break;
          }
      }
    }
    const output = snapshot;
    if (input.onStreamSnapshot) {
      output.streamListeners.add(input.onStreamSnapshot);
    }
    if (input.onSnapshot) {
      output.listeners.add(input.onSnapshot);
    }
    if (input.onProgress) {
      output.progressListeners.add(input.onProgress);
    }
    if (input.onCommentary) output.commentaryListeners.add(input.onCommentary);
    const reportProgress = (stage: BridgeProgressStage): void => {
      this.stage = stage;
      if (output.progress.includes(stage)) return;
      output.progress.push(stage);
      for (const listener of output.progressListeners) listener(stage);
    };
    try {
      if (snapshot.progress.length) input.onProgress?.("reconnecting");
      for (const stage of output.progress) input.onProgress?.(stage);
      if (output.text) input.onSnapshot?.(output.text);
      if (output.streamText) input.onStreamSnapshot?.(output.streamText);
      for (const entry of output.commentary) input.onCommentary?.(entry);
      return await this.#turnRunner.run(
        key,
        AbortSignal.any([input.signal, this.#taskCancellation.signal]),
        async (signal) => {
          this.#postCompletionRateLimitWatch?.abort();
          this.#postCompletionRateLimitWatch = undefined;
          const trace = new CompletionTrace(input.operationId ?? key);
          const owner = new AbortController();
          this.#cancel = owner;
          const combined = AbortSignal.any([signal, owner.signal]);
          this.state = "queued";
          this.#refreshBrowserControls();
          this.mode = input.mode;
          this.error = undefined;
          this.failureCode = undefined;
          this.titleSyncWarning = undefined;
          reportProgress("queued");
          const journalKey = createHash("sha256").update(key).digest("hex");
          let journalOwned = false;
          try {
            const pendingTransfer = this.#pendingImages.get(turnKey(input));
            const resumeTransfer =
              !!pendingTransfer && pendingTransfer.expires >= Date.now();
            if (resumeTransfer) {
              // This live session holds the exact completed image URLs. Resume only
              // their transfer; #runTurnExclusive returns before any submission.
              await this.journal.mark(journalKey, "accepted");
            } else {
              await this.journal.begin(journalKey);
            }
            journalOwned = true;
            this.#operationKey = journalKey;
            return await this.pool.run(
              combined,
              async () => {
                trace.mark("queue-acquired");
                this.state = "generating";
                this.#refreshBrowserControls();
                this.#preparationTrace = trace;
                const browserInput: RunWebTurnInput = {
                  ...input,
                  signal: combined,
                  onProgress: (stage) => {
                    trace.mark(stage);
                    reportProgress(stage);
                  },
                  onSnapshot: (text) => {
                    output.text = text;
                    for (const listener of output.listeners) listener(text);
                  },
                  onCommentary: (entry) => {
                    if (
                      output.commentary.some(
                        (item) => item.messageId === entry.messageId,
                      )
                    )
                      return;
                    output.commentary.push(entry);
                    for (const listener of output.commentaryListeners)
                      listener(entry);
                  },
                  ...(input.onStreamSnapshot
                    ? {
                        onStreamSnapshot: (text: string) => {
                          output.streamText = text;
                          for (const listener of output.streamListeners)
                            listener(text);
                        },
                      }
                    : {}),
                };
                let currentInput = browserInput;
                let recoveries = 0;
                let result: string | BridgeGeneratedImagesResult;
                this.#activeTurnSignal = combined;
                this.#activeProgress = browserInput.onProgress;
                try {
                  for (;;) {
                    try {
                      result = await this.#runTurnExclusive(
                        currentInput,
                        trace,
                        resumeTransfer && recoveries === 0,
                      );
                      break;
                    } catch (error) {
                      if (
                        !input.allowWebNativeTools ||
                        !(error instanceof ChatGptRateLimitError) ||
                        (this.#temporaryChat && error.afterSubmission) ||
                        recoveries >= MAX_FULL_MCP_RATE_LIMIT_RECOVERIES
                      ) {
                        throw error;
                      }
                      recoveries += 1;
                      trace.mark(`rate-limit-recovery-${recoveries}`);
                      trace.event(
                        error.rateLimitSource === "application-notice"
                          ? "rate-limit-application-notice"
                          : "rate-limit-shared-cooldown",
                      );
                      output.text = "";
                      output.streamText = "";
                      trace.event(
                        error.afterSubmission
                          ? "rate-limit-after-submit"
                          : "rate-limit-before-submit",
                      );
                      await this.pool.waitUntilAvailable(
                        combined,
                        (seconds) => {
                          trace.event("cooldown-wait");
                          reportProgress(`cooldown_${seconds}`);
                        },
                      );
                      reportProgress("recovering_rate_limit");
                      currentInput = error.afterSubmission
                        ? {
                            ...browserInput,
                            prompt: FULL_MCP_RATE_LIMIT_RECOVERY_PROMPT,
                            images: [],
                          }
                        : browserInput;
                    }
                  }
                } finally {
                  this.#activeTurnSignal = undefined;
                  this.#activeProgress = undefined;
                }
                trace.mark("result-ready");
                await this.journal.mark(journalKey, "result-ready");
                if (
                  input.threadId &&
                  !this.#temporaryChat &&
                  this.readThreadTitle &&
                  this.#window &&
                  !(
                    typeof result === "string" &&
                    /^<codex_tool_calls?>/.test(result.trim())
                  )
                ) {
                  try {
                    const title = await this.readThreadTitle(input.threadId);
                    const url = await this.#conversations.get(input.threadId);
                    if (title && url) {
                      trace.mark("title-sync-start");
                      await syncChatGptTitle(
                        this.#window,
                        url,
                        title,
                        combined,
                        (stage) => trace.mark(`title-sync-${stage}`),
                      );
                      trace.mark("title-sync-completed");
                    }
                  } catch (error) {
                    this.titleSyncWarning = `對話回覆已完成；名稱同步未完成，下次傳送會重試。${errorMessage(error)}`;
                    trace.mark("title-sync-warning");
                  }
                }
                if (this.modelReceipt) {
                  this.modelReceipt = {
                    ...this.modelReceipt,
                    phase: "completed",
                  };
                  try {
                    await this.recordModel?.(this.modelReceipt);
                  } catch {
                    this.error =
                      "Response completed, but its model evidence could not be saved.";
                  }
                }
                this.state =
                  typeof result === "string" &&
                  /^<codex_tool_calls?>/.test(result.trim())
                    ? "waiting-tools"
                    : "completed";
                this.#refreshBrowserControls();
                return result;
              },
              (ahead) => {
                this.queueAhead = ahead;
                if (ahead > 0) reportProgress(`queued_${ahead}`);
              },
              (seconds) => {
                trace.event("cooldown-wait");
                reportProgress(`cooldown_${seconds}`);
              },
            );
          } catch (error) {
            // Keep an accepted turn's terminal failure replayable.
            // A native reconnect must receive the original cause,
            // rather than discard it and enter the operation journal again.
            // This never authorizes a second send or a repeated client tool.
            if (
              (trace.eventCounts["submission-attempt"] ||
                output.progress.includes("waiting_challenge")) &&
              !this.#pendingImages.has(turnKey(input)) &&
              typeof error === "object" &&
              error !== null
            )
              this.#replayableFailures.add(error);
            trace.fail(error, this.stage);
            this.failureCode = classifyOperationFailure(error);
            this.state =
              this.failureCode === "cancelled" ? "cancelled" : "failed";
            this.#refreshBrowserControls();
            this.error = errorMessage(error);
            if (journalOwned)
              await this.journal
                .mark(journalKey, "failed")
                .catch(() => undefined);
            if (
              this.modelReceipt &&
              this.modelReceipt.phase === "before-submit"
            ) {
              this.modelReceipt = { ...this.modelReceipt, phase: "failed" };
              try {
                await this.recordModel?.(this.modelReceipt);
              } catch {
                this.error += " Model evidence could not be saved.";
              }
            }
            throw error;
          } finally {
            this.#operationKey = undefined;
            this.queueAhead = 0;
            this.stage = this.state;
            this.#refreshBrowserControls();
            this.#preparationTrace = undefined;
            if (this.#cancel === owner) this.#cancel = undefined;
            try {
              await this.recordCompletion?.(trace.finish(this.state));
            } catch {
              this.error =
                this.error ?? "Completion diagnostics could not be saved.";
            }
          }
        },
      );
    } finally {
      if (input.onSnapshot) output.listeners.delete(input.onSnapshot);
      if (input.onStreamSnapshot)
        output.streamListeners.delete(input.onStreamSnapshot);
      if (input.onProgress) output.progressListeners.delete(input.onProgress);
      if (input.onCommentary)
        output.commentaryListeners.delete(input.onCommentary);
    }
  }

  async close(): Promise<void> {
    this.keepPageAlive();
    this.#postCompletionRateLimitWatch?.abort();
    this.#postCompletionRateLimitWatch = undefined;
    this.#suppressAuthenticationCompletion = true;
    try {
      this.#closeAuthenticationPopups();
      if (this.#window !== undefined && !this.#window.isDestroyed()) {
        this.#window.destroy();
      }
    } finally {
      this.#suppressAuthenticationCompletion = false;
    }
    this.#window = undefined;
    this.#confirmedCompletion = undefined;
    this.#temporarySource = undefined;
    this.#verifiedTemporaryDocumentToken = undefined;
    this.#recoverableToolFailure = undefined;
  }

  async installPasskeyLoginState(
    state: PasskeyLoginState,
  ): Promise<ChatGptBrowserStatus> {
    if (new URL(this.#baseUrl).origin !== "https://chatgpt.com") {
      throw new Error(
        "Passkey-assisted login can import only into the ChatGPT production origin.",
      );
    }
    const window = await this.#ensureWindow(false);
    const browserSession = window.webContents.session;
    this.#suppressAuthenticationCompletion = true;
    try {
      this.#closeAuthenticationPopups();
      await window.loadURL("about:blank");
      await browserSession.clearStorageData();
      browserSession.flushStorageData();
      await browserSession.cookies.flushStore();
      for (const cookie of state.cookies) {
        await browserSession.cookies.set(cookie);
      }
      browserSession.flushStorageData();
      await browserSession.cookies.flushStore();
      await window.loadURL(this.#baseUrl);
      if (state.localStorage.length > 0) {
        await window.webContents.executeJavaScript(
          `(() => {
            if (location.origin !== "https://chatgpt.com") {
              throw new Error("Passkey storage import reached an unexpected origin.");
            }
            for (const entry of ${JSON.stringify(state.localStorage)}) {
              localStorage.setItem(entry.name, entry.value);
            }
          })()`,
          true,
        );
        await window.loadURL(this.#baseUrl);
      }
      await probeChatGptPageSession(
        this.#baseUrl,
        window.webContents,
        AbortSignal.timeout(60_000),
        { timeoutMs: 15_000 },
      );
      window.show();
      window.focus();
      return await this.status();
    } catch (error) {
      await window.loadURL("about:blank").catch(() => undefined);
      await browserSession.clearStorageData().catch(() => undefined);
      browserSession.flushStorageData();
      await browserSession.cookies.flushStore().catch(() => undefined);
      await window.loadURL(this.#baseUrl).catch(() => undefined);
      throw error;
    } finally {
      this.#suppressAuthenticationCompletion = false;
    }
  }

  keepPageAlive(): void {
    if (this.#idlePageTimer !== undefined) {
      clearTimeout(this.#idlePageTimer);
      this.#idlePageTimer = undefined;
    }
  }

  scheduleIdlePageExpiry(): void {
    this.keepPageAlive();
    this.#idlePageTimer = setTimeout(() => {
      this.#idlePageTimer = undefined;
      if (
        ["completed", "waiting-tools", "failed", "cancelled"].includes(
          this.state,
        )
      ) {
        void this.close().catch(() => undefined);
      }
    }, RETAINED_PAGE_IDLE_MS);
    this.#idlePageTimer.unref();
  }

  async #recoverCloudflareChallenge(
    window: ChatGptWindow,
    signal = this.#activeTurnSignal ??
      AbortSignal.timeout(CLOUDFLARE_CHALLENGE_TIMEOUT_MS),
  ): Promise<void> {
    if (window.requiresManualVerification) {
      if (!this.#presentedChallengeWindows.has(window)) {
        this.#presentedChallengeWindows.add(window);
        window.show();
        window.focus();
      }
      throw new ChatGptVerificationRequiredError();
    }
    if (this.#challengeRecovery) return this.#challengeRecovery;
    const backend = this.#backendAccess.get(window);
    if (backend?.blocked && this.#submissionInFlight)
      throw new ChatGptSessionError(
        "Cloudflare blocked the active ChatGPT request. Complete verification in the existing Web task. Bridge preserved the page and will not reload or resend the submitted request.",
        "chatgpt_web_session_unavailable",
        true,
      );
    const recovery = (async () => {
      const previousState = this.state;
      const deadline = Date.now() + CLOUDFLARE_CHALLENGE_TIMEOUT_MS;
      this.state = "waiting-challenge";
      this.#activeProgress?.("waiting_challenge");
      this.#refreshBrowserControls(window);
      // A challenge may alternate with blank loading documents. Present this
      // owned page once; subsequent browser stages must not steal focus again.
      if (!this.#presentedChallengeWindows.has(window)) {
        this.#presentedChallengeWindows.add(window);
        if (!window.isVisible() || window.isMinimized()) {
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
        }
      }
      try {
        if (backend?.blocked) {
          if (!backend.takeReload())
            throw new ChatGptSessionError(
              "ChatGPT's backend security check is still blocked after one page refresh. Complete verification in the existing Web task, then retry. No prompt was submitted.",
              "chatgpt_web_session_unavailable",
              true,
            );
          const url = window.webContents.getURL();
          if (new URL(url).origin !== new URL(this.#baseUrl).origin)
            throw new ChatGptSessionError(
              "ChatGPT security-check recovery lost its owned browser page.",
              "chatgpt_web_session_unavailable",
              true,
            );
          // Refresh the same owned document once,
          // before Send, and let the browser keep its cookies and storage.
          await delay(500, signal);
          // A concurrent authentication probe can complete this check during
          // the delay. Do not refresh a page that has already recovered.
          if (backend.blocked) {
            await window.loadURL(url);
            await delay(1_000, signal);
          }
        }
        let consecutiveClearChecks = 0;
        while (Date.now() < deadline) {
          signal.throwIfAborted();
          let ready = false;
          try {
            const readiness = (await window.webContents.executeJavaScript(
              `(${observeChatGptChallengeReadiness.toString()})(${observeChatGptPageBlock.toString()})`,
              true,
            )) as ReturnType<typeof observeChatGptChallengeReadiness>;
            ready = readiness.ready;
          } catch {
            if (window.isDestroyed())
              throw new Error(
                "The ChatGPT verification window was closed before Cloudflare verification completed.",
              );
          }
          if (!ready) {
            consecutiveClearChecks = 0;
          } else {
            consecutiveClearChecks += 1;
            if (consecutiveClearChecks >= 2) break;
          }
          await delay(500, signal);
        }
        if (Date.now() >= deadline) {
          throw new Error(
            "Cloudflare verification did not reach a ready ChatGPT composer within 10 minutes. Open the existing Web task to check verification. This request will not reopen or resend automatically.",
          );
        }
        this.#activeProgress?.("resuming_challenge");
        await probeChatGptPageSession(
          this.#baseUrl,
          window.webContents,
          signal,
          { timeoutMs: 10_000 },
        );
        if (backend?.blocked)
          throw new ChatGptSessionError(
            "ChatGPT's backend remains blocked even though its composer is visible. Complete verification in the existing Web task, then retry. Bridge will not refresh it repeatedly.",
            "chatgpt_web_session_unavailable",
            true,
          );
      } finally {
        if (this.state === "waiting-challenge") this.state = previousState;
        this.#refreshBrowserControls(window);
      }
    })();
    this.#challengeRecovery = recovery;
    try {
      await recovery;
    } finally {
      if (this.#challengeRecovery === recovery)
        this.#challengeRecovery = undefined;
    }
  }

  async #execute<T>(
    window: ChatGptWindow,
    stage: string,
    script: string,
    afterChallenge?: () => Promise<void>,
  ): Promise<T> {
    try {
      return await this.#timed(
        stage.startsWith("click-configure-option-")
          ? "click-configure-option"
          : stage,
        async () => {
          for (;;) {
            if (this.#backendAccess.get(window)?.blocked) {
              await this.#recoverCloudflareChallenge(window);
              await afterChallenge?.();
            }
            const blockedValue =
              stage === "observe"
                ? `blocked === "rate-limit" ? (${script}) : undefined`
                : "undefined";
            const result = (await window.webContents.executeJavaScript(
              `(() => {
                const blocked = (${observeChatGptPageBlock.toString()})();
                const sessionNotice = (${observeChatGptServerSessionNotice.toString()})();
                if (blocked || sessionNotice) return { blocked, sessionNotice, value: ${blockedValue} };
                return { blocked: null, sessionNotice: null, value: (${script}) };
              })()`,
              true,
            )) as {
              blocked: ChatGptPageBlock;
              sessionNotice: ChatGptServerSessionNotice;
              value: T;
            };
            if (result.blocked === "cloudflare-challenge") {
              await this.#recoverCloudflareChallenge(window);
              await afterChallenge?.();
              continue;
            }
            if (result.sessionNotice === "session-expired") {
              throw new ChatGptSessionError(
                "ChatGPT reported that its server session has expired. Sign in again in CodexGPT Bridge.",
                "chatgpt_web_session_expired",
                false,
              );
            }
            if (result.sessionNotice === "subscription-unavailable") {
              throw new ChatGptSessionError(
                "ChatGPT could not load the account subscription. Retry after the server session recovers.",
                "chatgpt_web_session_unavailable",
                true,
              );
            }
            if (result.blocked === "rate-limit") {
              // ChatGPT can show this modal over an already-completed answer.
              // When its exact acknowledgement action is available, dismiss it
              // and continue the same browser stage instead of manufacturing a
              // multi-minute cooldown after a usable response already exists.
              const acknowledged = await window.webContents
                .executeJavaScript(
                  `(${acknowledgeChatGptRateLimitDialog.toString()})()`,
                  true,
                )
                .catch(() => false);
              if (acknowledged) {
                if (stage === "observe" && result.value !== undefined)
                  return result.value;
                continue;
              }
              const error = this.pool.rateLimited();
              if (
                stage === "observe" &&
                this.#submissionInFlight &&
                result.value !== undefined
              ) {
                this.#observedRateLimit ??= {
                  error,
                  observedAt: Date.now(),
                };
                return result.value;
              }
              throw error;
            }
            if (result.blocked === "pin-limit")
              throw new PreparationError(
                "ChatGPT displayed an unrelated pin-limit dialog. Bridge stopped without changing pinned items. Dismiss the dialog before retrying.",
                "unrelated-dialog",
              );
            return result.value;
          }
        },
      );
    } catch (error) {
      if (
        error instanceof PreparationError ||
        error instanceof ChatGptSessionError ||
        error instanceof ChatGptVerificationRequiredError
      )
        throw error;
      throw new Error(
        `ChatGPT browser stage ${stage} failed: ${error instanceof Error ? error.message : "unknown script error"}`,
        { cause: error },
      );
    }
  }

  #timed<T>(stage: string, work: () => Promise<T>): Promise<T> {
    return this.#preparationTrace
      ? this.#preparationTrace.measure(stage, work)
      : work();
  }

  async #ensureWindow(
    show: boolean,
    initialUrl = this.#baseUrl,
  ): Promise<ChatGptWindow> {
    if (this.#window !== undefined && !this.#window.isDestroyed()) {
      return this.#window;
    }
    const window = await this.createWindow(
      {
        width: 1180,
        height: 820,
        minWidth: 900,
        minHeight: 650,
        show,
        title: "ChatGPT - CodexGPT Bridge",
        webPreferences: {
          partition: CHATGPT_PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      },
      this.allowAuthenticationPopups ? "login" : "turn",
    );
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (
        !this.allowAuthenticationPopups ||
        !allowedAuthenticationPopupUrl(url, this.#baseUrl)
      ) {
        return { action: "deny" };
      }
      return {
        action: "allow",
        outlivesOpener: false,
        overrideBrowserWindowOptions: {
          ...(window instanceof BrowserWindow ? { parent: window } : {}),
          modal: false,
          show: true,
          width: 720,
          height: 760,
          minWidth: 480,
          minHeight: 560,
          title: "Sign in to ChatGPT - CodexGPT Bridge",
          webPreferences: {
            partition: CHATGPT_PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false,
          },
        },
      };
    });
    window.webContents.on(
      "did-create-window",
      (popup: ChatGptWindow, details: { url: string }) => {
        if (
          !this.allowAuthenticationPopups ||
          !allowedAuthenticationPopupUrl(details.url, this.#baseUrl)
        ) {
          popup.destroy();
          return;
        }
        this.#suppressAuthenticationCompletion = true;
        try {
          this.#closeAuthenticationPopups();
        } finally {
          this.#suppressAuthenticationCompletion = false;
        }
        this.#adoptAuthenticationPopup(window, popup);
      },
    );
    const refreshControls = () => this.#refreshBrowserControls(window);
    window.webContents.on("did-navigate", refreshControls);
    window.webContents.on("did-navigate-in-page", refreshControls);
    window.webContents.on("zoom-changed", refreshControls);
    window.on("close", () => {
      this.#suppressAuthenticationCompletion = true;
      this.#closeAuthenticationPopups();
    });
    window.on("closed", () => {
      if (this.#window === window) {
        this.#window = undefined;
        this.#activeThread = undefined;
      }
      this.#suppressAuthenticationCompletion = false;
    });
    this.#window = window;
    if (window instanceof BrowserWindow) {
      const contents = window.webContents;
      const access = new ChatGptBackendAccess(
        this.#baseUrl,
        window.webContents.id,
      );
      this.#backendAccess.set(window, access);
      let idleRecoveryQueued = false;
      const recoverIdleWindow = () => {
        idleRecoveryQueued = false;
        if (
          window.isDestroyed() ||
          this.#window !== window ||
          !access.blocked ||
          [
            "queued",
            "generating",
            "waiting-tools",
            "waiting-challenge",
          ].includes(this.state)
        )
          return;
        void this.#recoverCloudflareChallenge(window).catch(
          (error: unknown) => {
            this.error = errorMessage(error);
            this.failureCode = classifyOperationFailure(error);
          },
        );
      };
      const unsubscribe = subscribeChatGptBackendResponses(
        window.webContents.session.webRequest,
        window.webContents.id,
        (details) => {
          if (
            !access.observe(details) ||
            window.isDestroyed() ||
            this.#window !== window
          )
            return;
          // Active preparation resumes through #execute. Idle login pages can
          // recover immediately; submitted turns are never refreshed here.
          // Replacing a navigation while Electron's loadURL is pending rejects
          // both load promises with ERR_ABORTED. Let the current main document
          // finish before an idle recovery is allowed to refresh it.
          if (window.webContents.isLoadingMainFrame()) {
            if (!idleRecoveryQueued) {
              idleRecoveryQueued = true;
              window.webContents.once("did-stop-loading", recoverIdleWindow);
            }
          } else recoverIdleWindow();
        },
      );
      window.on("closed", () => {
        unsubscribe();
        contents.removeListener("did-stop-loading", recoverIdleWindow);
      });
    }
    this.#refreshBrowserControls(window);
    await window.loadURL(initialUrl);
    this.#refreshBrowserControls(window);
    return window;
  }

  async #runTurnExclusive(
    input: RunWebTurnInput,
    trace: CompletionTrace,
    resumeTransfer = false,
  ): Promise<string | BridgeGeneratedImagesResult> {
    input.onProgress?.("preparing");
    if (
      input.prompt.length >
      (input.execution?.stagedContext ||
      input.execution?.contextMultiplier === 3
        ? 24
        : 4) *
        1024 *
        1024
    ) {
      throw new Error(
        "ChatGPT Web prompt exceeds the 4 MiB browser-provider limit.",
      );
    }
    const wasOpen = this.#window !== undefined && !this.#window.isDestroyed();
    this.#temporaryChat = await this.#conversations.selectTemporaryMode(
      input.threadId,
      input.temporaryChat === true,
    );
    const window = await this.#timed("window-ready", () =>
      this.#ensureWindow(
        false,
        this.#temporaryChat ? temporaryChatUrl(this.#baseUrl) : this.#baseUrl,
      ),
    );
    // Stream completion is the authority for the retained turn. ChatGPT can
    // leave its page-level Stop control mounted indefinitely after end_turn.
    // Do not click or refresh the page: carry the exact proof until a new
    // submission is semantically acknowledged.
    let confirmedCompletion = this.#confirmedCompletion;
    let recoverableToolFailure = this.#recoverableToolFailure;
    if (confirmedCompletion || recoverableToolFailure) {
      const previous = await this.#observe(window);
      if (confirmedCompletion) {
        const sameCompletedTurn =
          previous.userToken === confirmedCompletion.userToken &&
          previous.assistantMessageId ===
            confirmedCompletion.assistantMessageId &&
          previous.generationRequestCount ===
            confirmedCompletion.requestCount &&
          sameCompletedBody(previous.text, confirmedCompletion.text) &&
          !hasComposerText(previous.composerText);
        if (!sameCompletedTurn) {
          this.#confirmedCompletion = undefined;
          confirmedCompletion = undefined;
        } else if (
          isConfirmedStalePageStop(previous, confirmedCompletion, true)
        ) {
          await this.#timed(
            "confirmed-stale-stop-bypassed",
            async () => undefined,
          );
        }
      }
      if (
        recoverableToolFailure &&
        !isRecoverableToolFailure(previous, recoverableToolFailure)
      ) {
        this.#recoverableToolFailure = undefined;
        recoverableToolFailure = undefined;
      }
    }
    const transferKey = input.turnId ? turnKey(input) : undefined;
    for (const [key, entry] of this.#pendingImages) {
      if (entry.expires < Date.now()) this.#pendingImages.delete(key);
    }
    const pending = transferKey
      ? this.#pendingImages.get(transferKey)
      : undefined;
    if (pending) {
      input.onProgress?.("transferring");
      // Retry only the failed transfer, not the already-completed model/tool request.
      const result = await withMediaTextFallback<BridgeGeneratedImagesResult>(
        pending.text,
        async () => ({
          kind: "generated_images",
          text: pending.text,
          images: await this.#saveGeneratedImages(
            window,
            pending.urls,
            input.turnId,
            input.signal,
          ),
        }),
        input.signal,
      );
      this.#pendingImages.delete(transferKey!);
      return result;
    }
    if (resumeTransfer) throw new OperationRecoveryError();
    const threadKey = input.threadId ?? "legacy-unscoped";
    this.#lastThread = input.threadId;
    let savedUrl = input.threadId
      ? await this.#timed("conversation-lookup", () =>
          this.#conversations.get(input.threadId!),
        )
      : undefined;
    // A retained task keeps its original destination, even after settings change.
    // Its rebuilds also use that destination so hidden project context stays stable.
    const projectUrl = this.#temporaryChat
      ? undefined
      : savedUrl && input.threadId
        ? await this.#conversations.projectUrl(input.threadId)
        : input.projectUrl
          ? normalizeChatGptProjectUrl(input.projectUrl, this.#baseUrl)
          : input.projectName && this.resolveProject
            ? await this.#timed("project-find-or-create", () =>
                this.resolveProject!(input.projectName!, input.signal),
              )
            : undefined;
    const conversationStartUrl = this.#temporaryChat
      ? temporaryChatUrl(this.#baseUrl)
      : (projectUrl ?? this.#baseUrl);
    const retainedTemporary =
      this.#temporaryChat &&
      wasOpen &&
      this.#activeThread === threadKey &&
      !!this.#receipt &&
      (await this.#isRetainedTemporarySource(window, input));
    // Simple tool results are follow-ups in the same task too. Keep the exact
    // in-memory Temporary Chat and receipt instead of rebuilding its full
    // context after every tool call. Closing the page still loses this source.
    if (this.#temporaryChat && !retainedTemporary) {
      savedUrl = undefined;
      this.#receipt = undefined;
      this.#temporarySource = undefined;
      this.#verifiedTemporaryDocumentToken = undefined;
    }
    if (input.threadId && !this.#receipt && !this.#temporaryChat)
      this.#receipt = await this.#timed("context-receipt-read", () =>
        this.#conversations.receipt(input.threadId!),
      );
    if (input.forceNewConversation) {
      if (input.requireRetainedConversation)
        throw new Error(
          "A retained checkpoint cannot start a new conversation.",
        );
      this.#receipt = undefined;
      savedUrl = undefined;
      this.#activeThread = undefined;
    }
    let sync = input.context
      ? planContextSync(
          input.context,
          input.contract ?? "",
          this.#receipt,
          input.images,
        )
      : undefined;
    if (
      input.requireRetainedConversation &&
      ((!retainedTemporary && (this.#temporaryChat || !savedUrl)) ||
        sync?.reset)
    )
      throw new RetainedFullSourceUnavailableError();
    if (sync) input.onProgress?.(sync.reset ? "rebuilding" : "reusing");
    if (sync?.reset) {
      savedUrl = undefined;
      this.#activeThread = undefined;
    }
    let freshConversation = false;
    if (
      (this.#temporaryChat && !retainedTemporary) ||
      this.#activeThread !== threadKey ||
      (savedUrl && window.webContents.getURL().split("?", 1)[0] !== savedUrl) ||
      (!savedUrl &&
        projectUrl &&
        window.webContents.getURL().split(/[?#]/, 1)[0] !==
          conversationStartUrl)
    ) {
      // Task switches always restore their own conversation, never the currently visible chat.
      const beforeNavigation = await this.#observe(window);
      if (
        beforeNavigation.responseBusy &&
        !(
          confirmedCompletion &&
          isConfirmedStalePageStop(
            beforeNavigation,
            confirmedCompletion,
            sameCompletedBody(beforeNavigation.text, confirmedCompletion.text),
          )
        ) &&
        !(
          recoverableToolFailure &&
          isRecoverableToolFailure(beforeNavigation, recoverableToolFailure)
        )
      ) {
        throw new Error(
          "ChatGPT is still generating. The active conversation was not navigated away from.",
        );
      }
      // A newly created window already loaded this empty base page. Existing
      // windows and saved conversations still navigate to isolate task histories.
      if (
        wasOpen ||
        savedUrl ||
        window.webContents.getURL() !== conversationStartUrl ||
        beforeNavigation.userCount > 0 ||
        hasComposerText(beforeNavigation.composerText)
      ) {
        await this.#timed("conversation-navigation", () =>
          window.loadURL(savedUrl ?? conversationStartUrl),
        );
      }
      this.#activeThread = threadKey;
      freshConversation = !savedUrl;
      this.#confirmedCompletion = undefined;
      confirmedCompletion = undefined;
      this.#recoverableToolFailure = undefined;
      recoverableToolFailure = undefined;
    }
    await this.#timed("composer-ready", () =>
      this.#ensureReady(window, input.signal),
    );
    await this.#ensureTemporaryChat(window, input);
    if (savedUrl && window.webContents.getURL().split("?", 1)[0] !== savedUrl) {
      if (input.requireRetainedConversation)
        throw new RetainedFullSourceUnavailableError();
      input.onProgress?.("rebuilding");
      if (!input.context)
        throw new Error(
          "The saved ChatGPT conversation could not be restored.",
        );
      await this.#timed("conversation-recovery", () =>
        window.loadURL(conversationStartUrl),
      );
      await this.#timed("composer-ready", () =>
        this.#ensureReady(window, input.signal),
      );
      sync = planContextSync(
        input.context,
        input.contract ?? "",
        undefined,
        input.images,
      );
      freshConversation = true;
      savedUrl = undefined;
    }
    assertProjectDestination(window.webContents.getURL(), projectUrl, savedUrl);
    this.modelReceipt = undefined;
    const requestedFamily =
      input.mode === "luna" || input.mode === "think"
        ? ""
        : modelPreference(input.modelFamily);
    this.modelReceipt = verifyModelSelection(
      input.operationId ?? turnKey(input),
      input.mode,
      requestedFamily,
      {
        model: null,
        mode: null,
        modeLabel: null,
        surface: "missing",
        availableModels: [],
        ambiguous: false,
        disabled: false,
      },
      input.execution,
    );
    input.onProgress?.("selecting");
    // A failed Full MCP preparation can leave an unsent App node and prompt in
    // the retained conversation. Clear that state before touching the model
    // picker; ChatGPT can otherwise hide or cover the composer model control.
    await this.#timed("composer-state-reset-before-model", () =>
      this.#resetComposerState(
        window,
        input.signal,
        input.allowWebNativeTools ? input.connectorName?.trim() : undefined,
      ),
    );
    // Full MCP changes the model surface when the App is attached. Some project
    // composers do not expose an effort menu until then. Select only after the
    // exact App is attached; the independent before-send verification is unchanged.
    if (!input.allowWebNativeTools)
      await this.#timed("select-mode", () =>
        this.#selectMode(window, input.mode, input.signal, requestedFamily),
      );

    let responseBaseline = await this.#observe(window);
    let previousAssistantText = responseBaseline.text;
    const confirmedStaleStopBeforePreparation =
      confirmedCompletion !== undefined &&
      isConfirmedStalePageStop(
        responseBaseline,
        confirmedCompletion,
        sameCompletedBody(responseBaseline.text, confirmedCompletion.text),
      );
    if (
      responseBaseline.responseBusy &&
      !(
        confirmedCompletion &&
        isConfirmedStalePageStop(
          responseBaseline,
          confirmedCompletion,
          sameCompletedBody(responseBaseline.text, confirmedCompletion.text),
        )
      ) &&
      !(
        recoverableToolFailure &&
        isRecoverableToolFailure(responseBaseline, recoverableToolFailure)
      )
    ) {
      throw new Error(
        "ChatGPT is still generating a previous response. Stop that response before submitting another turn.",
      );
    }
    if (!responseBaseline.composer) {
      throw new Error(
        "ChatGPT is not signed in. Open the ChatGPT login window in CodexGPT Bridge.",
      );
    }
    const buildPrompt = (): string =>
      sync
        ? [sync.text, "[Current request]", input.prompt]
            .filter(Boolean)
            .join("\n\n")
        : (freshConversation && input.conversationHistory
            ? input.conversationHistory + "\n\n"
            : "") +
          (input.contract ?? "") +
          "\n" +
          input.prompt;
    let prompt = buildPrompt();
    if (
      prompt.length >
      (input.execution?.stagedContext ||
      input.execution?.contextMultiplier === 3
        ? 24
        : 4) *
        1024 *
        1024
    )
      throw new Error(
        "Synchronized Codex context exceeds the 4 MiB browser limit; compact the task first.",
      );
    const images = [
      ...new Map(
        [...(sync?.images ?? []), ...input.images].map((image) => [
          image.imageUrl,
          image,
        ]),
      ).values(),
    ];
    if (input.execution) {
      let execution = synchronizeBridgeExecutionPreflight(input.execution, {
        prompt,
        images,
      });
      let problem = bridgeExecutionLimitProblem(execution);
      if (
        problem &&
        (execution.stagedContext || execution.contextMultiplier === 3) &&
        execution.toolTransport === "full" &&
        !input.requireRetainedConversation
      ) {
        if (
          execution.inputTokens > execution.hardInputTokenLimit ||
          !input.onContextStaging ||
          !input.onContextCommit ||
          execution.browserMessageTokenLimit === undefined
        )
          throw new SynchronizedContextLimitError(
            "The Full context transaction cannot fit its owned context budget. No prompt was submitted.",
          );
        const source = sync
          ? [sync.transportText, "[Current request]", input.prompt]
              .filter(Boolean)
              .join("\n\n")
          : [
              freshConversation ? (input.conversationHistory ?? "") : "",
              "[Current request]",
              input.prompt,
            ]
              .filter(Boolean)
              .join("\n\n");
        const transfer = planFullContextTransfer(
          source,
          input.contract ?? "",
          input.operationId ?? this.#operationKey ?? "",
          {
            messageTokens: execution.browserMessageTokenLimit,
            ...(execution.browserComposerCharLimit === undefined
              ? {}
              : { messageCharacters: execution.browserComposerCharLimit }),
            transactionTokens: execution.hardInputTokenLimit,
            imageTokens: execution.imageReserveTokens,
            platformTokens: execution.platformReserveTokens,
          },
        );
        input.onContextStaging();
        for (let index = 0; index < transfer.stages.length; index++) {
          const stage = transfer.stages[index]!;
          const stageExecution = {
            ...synchronizeBridgeExecutionPreflight(execution, {
              prompt: stage.text,
              images: [],
            }),
            toolCount: 0,
            multipart: {
              transactionId: transfer.transactionId,
              part: index + 1,
              total: transfer.total,
              phase: "stage" as const,
              digest: stage.digest,
            },
          };
          await this.#sendFullContextStage(
            window,
            { ...input, execution: stageExecution },
            stage,
            requestedFamily,
            trace,
            index + 1,
            projectUrl,
          );
        }
        prompt = transfer.commit.text;
        execution = {
          ...synchronizeBridgeExecutionPreflight(execution, { prompt, images }),
          multipart: {
            transactionId: transfer.transactionId,
            part: transfer.total,
            total: transfer.total,
            phase: "commit",
            digest: transfer.commit.digest,
          },
        };
        responseBaseline = await this.#observe(window);
        previousAssistantText = responseBaseline.text;
        savedUrl = window.webContents.getURL().split("?", 1)[0];
        problem = bridgeExecutionLimitProblem(execution);
      }
      if (problem) {
        throw new SynchronizedContextLimitError(
          `${execution.route} (${execution.mode}) synchronized browser payload: ${problem} (${execution.budgetProfile}). Compact the task and retry. No prompt was submitted.`,
        );
      }
      input = { ...input, execution };
    }
    const promptHasText = input.prompt.trim().length > 0;
    let bridgeOwnsComposerState = false;
    let connectorBoundToConversation = false;
    const prepareInput = async (): Promise<void> => {
      await this.#ensureTemporaryChat(window, input);
      assertProjectDestination(
        window.webContents.getURL(),
        projectUrl,
        savedUrl,
      );
      await this.#timed("server-session-before-input", () =>
        this.#assertServerSession(window, input.signal),
      );
      await this.#timed("composer-state-reset", () =>
        this.#resetComposerState(
          window,
          input.signal,
          input.allowWebNativeTools ? input.connectorName?.trim() : undefined,
        ),
      );
      bridgeOwnsComposerState = true;
      if (input.allowWebNativeTools) {
        const connectorName = input.connectorName?.trim();
        if (!connectorName) {
          throw new PreparationError(
            "Full MCP mode requires an exact ChatGPT connector name. No prompt was submitted.",
            "full-mcp-connector-unavailable",
          );
        }
        connectorBoundToConversation = await this.#timed(
          "connector-conversation-binding",
          () => this.#hasBoundConnectorConversation(window, connectorName),
        );
        if (!connectorBoundToConversation) {
          await this.#timed("connector-select", () =>
            this.#selectFullMcpConnector(
              window,
              connectorName,
              input.signal,
              2,
            ),
          );
        }
        // Selecting a ChatGPT App can reset the composer to Instant. Apply the
        // requested effort after the App is attached. Retained App conversations
        // can hide that App from the picker after the first turn; their exact
        // inline App binding is independently rechecked before Send.
        await this.#timed("select-mode-after-connector", () =>
          this.#selectMode(window, input.mode, input.signal, requestedFamily),
        );
        await this.#ensureTemporaryChat(window, input);
        await this.#timed("composer-fill", () =>
          connectorBoundToConversation
            ? this.#fillComposer(window, prompt)
            : this.#appendPromptAfterConnector(window, prompt),
        );
      } else {
        await this.#ensureTemporaryChat(window, input);
        await this.#timed("composer-fill", () =>
          this.#fillComposer(window, prompt),
        );
      }
      await this.#timed("attachments-ready", () =>
        this.#attachImages(window, images, input.signal),
      );
      const prepared = await this.#observe(window);
      if (promptHasText && !hasComposerText(prepared.composerText)) {
        throw new Error(
          "ChatGPT composer did not retain the prompt. The composer UI contract may have changed.",
        );
      }
      await delay(120, input.signal);
      await this.#timed("pre-submit-verify", () =>
        this.#verifyBeforeSubmit(
          window,
          input,
          requestedFamily,
          connectorBoundToConversation,
        ),
      );
      await this.#ensureTemporaryChat(window, input);
      assertProjectDestination(
        window.webContents.getURL(),
        projectUrl,
        savedUrl,
      );
    };
    try {
      await prepareInput();
    } catch (error) {
      if (error instanceof ChatGptSessionError) {
        if (bridgeOwnsComposerState)
          await this.#discardUnsubmittedComposerState(window);
        throw error;
      }
      const staleStopBlockedModelVerification =
        confirmedStaleStopBeforePreparation &&
        error instanceof PreparationError &&
        [
          "model-menu-unavailable",
          "model-selection-missing",
          "model-selection-disabled",
        ].includes(error.diagnosticCode);
      const connectorSelectionNeedsRecovery =
        input.allowWebNativeTools &&
        error instanceof PreparationError &&
        [
          "native-tool-selection-active",
          "full-mcp-connector-unavailable",
          "model-menu-unavailable",
          "model-selection-missing",
        ].includes(error.diagnosticCode);
      if (
        !staleStopBlockedModelVerification &&
        !connectorSelectionNeedsRecovery
      ) {
        if (bridgeOwnsComposerState)
          await this.#discardUnsubmittedComposerState(window);
        throw error;
      }

      // Repair the retained page first. If a saved conversation still cannot
      // expose its App picker after reload, fully unmount that page and reopen
      // the same saved URL. Merely loading the empty start surface cannot create
      // a conversation; only Send can. Never replace a retained conversation
      // here, because a transient picker failure must not fork its Web history.
      // All recovery is before Send, never a response replay.
      input.signal.throwIfAborted();
      const retainedUrl = window.webContents.getURL();
      const canReopenConnectorConversation =
        connectorSelectionNeedsRecovery &&
        Boolean(savedUrl) &&
        retainedUrl.split("?", 1)[0] === savedUrl;
      for (
        let recovery = 0;
        recovery < (canReopenConnectorConversation ? 2 : 1);
        recovery++
      ) {
        const reopenConnectorConversation = recovery === 1;
        await this.#timed(
          reopenConnectorConversation
            ? "reopen-stale-connector-conversation"
            : connectorSelectionNeedsRecovery
              ? "reload-stale-connector-picker"
              : "reload-confirmed-stale-stop",
          async () => {
            if (reopenConnectorConversation) {
              await window.loadURL(conversationStartUrl);
              input.signal.throwIfAborted();
              await window.loadURL(savedUrl!);
              return;
            }
            await window.loadURL(retainedUrl);
          },
        );
        await this.#timed("composer-ready-after-reload", () =>
          this.#ensureReady(window, input.signal),
        );
        input.onProgress?.("selecting");
        if (!input.allowWebNativeTools)
          await this.#timed("select-mode-after-reload", () =>
            this.#selectMode(window, input.mode, input.signal, requestedFamily),
          );
        responseBaseline = await this.#observe(window);
        previousAssistantText = responseBaseline.text;
        if (responseBaseline.responseBusy) {
          throw new PreparationError(
            "ChatGPT remained busy after reloading the completed conversation. No prompt was submitted.",
            "model-menu-unavailable",
          );
        }
        try {
          await prepareInput();
          break;
        } catch (recoveryError) {
          const canRetrySameConversation =
            recovery === 0 &&
            canReopenConnectorConversation &&
            recoveryError instanceof PreparationError &&
            [
              "native-tool-selection-active",
              "full-mcp-connector-unavailable",
              "model-menu-unavailable",
              "model-selection-missing",
            ].includes(recoveryError.diagnosticCode);
          if (!canRetrySameConversation) {
            if (bridgeOwnsComposerState)
              await this.#discardUnsubmittedComposerState(window);
            throw recoveryError;
          }
        }
      }
    }
    await this.#watchGeneration(window, randomUUID());
    this.#preparationTrace = undefined;
    let submissionAccepted = false;
    let submissionAttempted = false;
    try {
      // A sibling may have started the shared cooldown while this turn was
      // preparing. Only new submissions are blocked; already-submitted parent
      // turns must remain observable so they can recover failed children.
      await this.pool.waitUntilAvailable(input.signal, (seconds) => {
        trace.event("cooldown-wait");
        input.onProgress?.(`cooldown_${seconds}`);
      });
      assertProjectDestination(
        window.webContents.getURL(),
        projectUrl,
        savedUrl,
      );
      await this.#ensureTemporaryChat(window, input);
      if (this.#operationKey)
        await this.journal.mark(this.#operationKey, "submitting");
      this.#observedRateLimit = undefined;
      this.#submissionInFlight = true;
      submissionAttempted = true;
      input.onProgress?.("submitting");
      trace.event("submission-attempt");
      if (input.execution?.multipart?.phase === "commit")
        input.onContextCommit?.();
      await this.#submit(window, prepareInput);
      const deadline =
        Date.now() +
        (input.allowWebNativeTools
          ? BRIDGE_FULL_TURN_TIMEOUT_MS
          : TURN_TIMEOUT_MS);
      let responseStartDeadline = Date.now() + RESPONSE_START_TIMEOUT_MS;
      let completion = new ChatGptCompletionTracker();
      let observation = await this.#waitForSubmission(
        window,
        responseBaseline,
        promptHasText,
        input.signal,
      );
      if (this.#operationKey)
        await this.journal.mark(this.#operationKey, "accepted");
      submissionAccepted = true;
      await this.#recordAcceptedSend(input).catch(() => undefined);
      trace.event("submission-accepted");
      if (input.threadId)
        await this.#conversations.remember(
          input.threadId,
          window.webContents.getURL(),
          undefined,
          projectUrl,
        );
      trace.mark("accepted");
      let streamedMessageId: string | undefined;
      this.#confirmedCompletion = undefined;
      confirmedCompletion = undefined;
      this.#recoverableToolFailure = undefined;
      recoverableToolFailure = undefined;
      let responseStarted = false;
      let webNativeToolPendingSince: number | undefined;
      let mediaPendingSince: number | undefined;
      let imageGenerationRetries = 0;
      const watchdog = new SilenceWatchdog(input.silenceTimeoutSeconds ?? 0);
      let approvalClickedAt = 0;
      while (Date.now() < deadline) {
        watchdog.observe(
          JSON.stringify([
            observation.text,
            observation.assistantToken,
            observation.generationRequestCount,
            observation.generationState,
            observation.generatedImageUrls,
          ]),
        );
        if (
          input.allowWebNativeTools &&
          input.autoApproveToolCalls &&
          Date.now() - approvalClickedAt > 1500
        ) {
          const target = await this.#execute<
            { x: number; y: number } | undefined
          >(
            window,
            "one-time-tool-approval",
            `(${oneTimeToolApprovalTarget.toString()})(${JSON.stringify(input.connectorName ?? "")})`,
          );
          if (target) {
            this.#sendMouseClick(window, target.x, target.y);
            approvalClickedAt = Date.now();
          }
        }
        if (input.signal.aborted) {
          await this.#stopGenerating(window);
          throw new DOMException("Provider turn was cancelled.", "AbortError");
        }
        if (observation.webNativeToolError && !input.allowWebNativeTools) {
          this.#rememberRecoverableToolFailure(observation);
          throw new UnsupportedWebNativeToolError(
            observation.webNativeToolError,
          );
        }
        if (observation.error.length > 0) throw new Error(observation.error);
        if (observation.responseBusy) input.onProgress?.("generating");
        if (observation.mediaPending) input.onProgress?.("waiting_media");
        if (observation.webNativeToolPending)
          input.onProgress?.("waiting_web_tool");
        if (observation.mediaPending && !observation.responseBusy) {
          mediaPendingSince ??= Date.now();
        } else {
          mediaPendingSince = undefined;
        }
        if (observation.webNativeToolPresent && !input.allowWebNativeTools) {
          webNativeToolPendingSince ??= Date.now();
          if (
            Date.now() - webNativeToolPendingSince >=
            WEB_NATIVE_TOOL_TIMEOUT_MS
          ) {
            this.#rememberRecoverableToolFailure(observation);
            await this.#stopGenerating(window);
            throw new UnsupportedWebNativeToolError();
          }
        } else {
          webNativeToolPendingSince = undefined;
        }
        const hasNewAssistant =
          (responseBaseline.userToken.length === 0 ||
            (observation.userToken !== responseBaseline.userToken &&
              !responseBaseline.logicalTurnIds.includes(
                observation.userToken,
              ))) &&
          !responseBaseline.logicalTurnIds.includes(
            observation.assistantToken,
          ) &&
          (observation.assistantCount > responseBaseline.assistantCount ||
            (observation.assistantToken.length > 0 &&
              observation.assistantToken !== responseBaseline.assistantToken));
        const observedRateLimit = this.#rateLimitObservation();
        if (
          !hasNewAssistant &&
          observedRateLimit &&
          Date.now() - observedRateLimit.observedAt >=
            RATE_LIMIT_RESPONSE_GRACE_MS
        ) {
          throw observedRateLimit.error;
        }
        responseStarted ||= hasChatGptResponseStarted(
          responseBaseline,
          observation,
          hasNewAssistant,
        );
        if (hasNewAssistant && observation.text) {
          input.onProgress?.("receiving");
          input.onSnapshot?.(observation.text);
        }
        if (input.allowWebNativeTools && !input.requireRetainedConversation)
          for (const entry of observation.publicCommentary ?? [])
            input.onCommentary?.(entry);
        if (
          input.onStreamSnapshot &&
          hasNewAssistant &&
          observation.streamSignal &&
          !observation.webNativeToolPresent &&
          !observation.mediaPending
        ) {
          const stream = observation.streamSignal;
          if (streamedMessageId && streamedMessageId !== stream.messageId)
            throw new Error(
              "Network answer changed the streamed message identity.",
            );
          const candidate = isBridgeTextStreamCandidate(
            stream.text,
            Boolean(streamedMessageId),
          );
          if (candidate && (streamedMessageId || !observation.terminalSignal)) {
            streamedMessageId = stream.messageId;
            input.onStreamSnapshot?.(stream.text);
          } else if (streamedMessageId && !candidate) {
            throw new BridgeStreamError(
              "Network answer changed its text frame.",
            );
          }
        }
        if (
          hasNewAssistant &&
          (!observation.busy || observation.terminalConfirmed) &&
          !observation.mediaPending
        )
          input.onProgress?.("validating");
        const completed = completion.update({
          hasNewAssistant,
          assistantToken: observation.assistantToken,
          userToken: observation.userToken,
          terminalConfirmed: observation.terminalConfirmed,
          text: observation.text,
          html: observation.html,
          hasRenderableMedia: observation.hasRenderableMedia,
          busy: observation.busy,
          responseBusy: observation.responseBusy,
          mediaPending:
            observation.mediaPending &&
            (mediaPendingSince === undefined ||
              Date.now() - mediaPendingSince < 60_000),
          webNativeToolPending: observation.webNativeToolPending,
          webNativeToolPresent: observation.webNativeToolPresent,
          completionActionVisible: observation.completionActionVisible,
        });
        trace.observe(
          { ...observation, text: hasNewAssistant ? observation.text : "" },
          completion.reason,
        );
        if (completed !== undefined) {
          const completedText =
            completed === CHAT_GPT_RICH_OUTPUT_ONLY ? "" : completed.trim();
          if (
            imageGenerationRetries === 0 &&
            !streamedMessageId &&
            observation.generatedImageUrls.length === 0 &&
            shouldRetryTransientImageGeneration(
              input.prompt,
              previousAssistantText,
              completedText,
            )
          ) {
            responseBaseline = observation;
            const prepareImageGenerationRetry = async (): Promise<void> => {
              await this.#resetComposerState(window, input.signal);
              if (input.allowWebNativeTools && input.connectorName?.trim()) {
                const connectorName = input.connectorName.trim();
                connectorBoundToConversation =
                  await this.#hasBoundConnectorConversation(
                    window,
                    connectorName,
                  );
                if (!connectorBoundToConversation)
                  await this.#selectFullMcpConnector(
                    window,
                    connectorName,
                    input.signal,
                  );
                await this.#selectMode(
                  window,
                  input.mode,
                  input.signal,
                  requestedFamily,
                );
                if (connectorBoundToConversation)
                  await this.#fillComposer(
                    window,
                    IMAGE_GENERATION_RETRY_PROMPT,
                  );
                else
                  await this.#appendPromptAfterConnector(
                    window,
                    IMAGE_GENERATION_RETRY_PROMPT,
                  );
              } else {
                await this.#fillComposer(window, IMAGE_GENERATION_RETRY_PROMPT);
              }
              const retryPrepared = await this.#observe(window);
              if (!hasComposerText(retryPrepared.composerText)) {
                throw new Error(
                  "ChatGPT composer did not retain the automatic image-generation retry.",
                );
              }
              await delay(120, input.signal);
              await this.#verifyBeforeSubmit(
                window,
                input,
                requestedFamily,
                connectorBoundToConversation,
              );
              await this.#watchGeneration(window, randomUUID());
              await this.pool.waitUntilAvailable(input.signal, (seconds) => {
                trace.event("cooldown-wait");
                input.onProgress?.(`cooldown_${seconds}`);
              });
            };
            await prepareImageGenerationRetry();
            trace.mark("image-retry-submitted");
            trace.event("submission-attempt");
            await this.#submit(window, prepareImageGenerationRetry);
            imageGenerationRetries += 1;
            responseStartDeadline = Date.now() + RESPONSE_START_TIMEOUT_MS;
            completion = new ChatGptCompletionTracker();
            responseStarted = false;
            webNativeToolPendingSince = undefined;
            mediaPendingSince = undefined;
            observation = await this.#waitForSubmission(
              window,
              responseBaseline,
              true,
              input.signal,
            );
            await this.#recordAcceptedSend(
              input,
              `image-retry-${imageGenerationRetries}`,
            ).catch(() => undefined);
            trace.event("submission-accepted");
            continue;
          }
          if (transferKey && observation.generatedImageUrls.length > 0) {
            if (this.#pendingImages.size >= 20) {
              const oldest = this.#pendingImages.keys().next().value;
              if (oldest !== undefined) this.#pendingImages.delete(oldest);
            }
            this.#pendingImages.set(transferKey, {
              text:
                completed === CHAT_GPT_RICH_OUTPUT_ONLY ? "" : completed.trim(),
              urls: observation.generatedImageUrls,
              expires: Date.now() + 5 * 60_000,
            });
          }
          const text = completedText;
          const result = await withMediaTextFallback<
            BridgeGeneratedImagesResult | string
          >(
            text,
            async () => {
              if (observation.mediaPending) {
                throw new Error(
                  "ChatGPT finished generating, but its image did not load within 60 seconds. The image was not transferred.",
                );
              }
              if (observation.generatedImageUrls.length > 0)
                input.onProgress?.("transferring");
              const images = await this.#saveGeneratedImages(
                window,
                observation.generatedImageUrls,
                input.turnId,
                input.signal,
              );
              if (images.length > 0)
                return { kind: "generated_images", text, images };
              if (!text || observation.hasRenderableMedia) {
                throw new Error(
                  "ChatGPT completed with rich media, but CodexGPT Bridge could not locate a transferable image.",
                );
              }
              return text;
            },
            input.signal,
          );
          if (transferKey) this.#pendingImages.delete(transferKey);
          if (input.threadId)
            await this.#conversations.remember(
              input.threadId,
              window.webContents.getURL(),
              sync?.receipt,
              projectUrl,
            );
          this.#receipt = sync?.receipt;
          await this.#rememberTemporarySource(window, input, observation);
          if (observation.terminalConfirmed) {
            const completionProof: ChatGptConfirmedCompletion = {
              userToken: observation.userToken,
              assistantMessageId: observation.assistantMessageId,
              requestCount: observation.generationRequestCount,
              text: observation.text,
            };
            this.#confirmedCompletion = completionProof;
            // Do not reload after a successful response. A page-wide Stop can be
            // stale even though end_turn proves this exact answer is complete.
            // Keep the proof and repair only if the next turn's pre-submit model
            // or connector checks are genuinely blocked.
          }
          this.#watchForPostCompletionRateLimit(window);
          return result;
        }
        if (!responseStarted && Date.now() >= responseStartDeadline) {
          throw new Error(
            "ChatGPT accepted the prompt but did not start a response within 60 seconds.",
          );
        }
        await delay(250, input.signal);
        observation = await this.#observe(window);
      }
      await this.#stopGenerating(window);
      throw new Error(
        input.allowWebNativeTools
          ? "ChatGPT Full Web turn exceeded its four-hour deadline."
          : "ChatGPT Web turn timed out after 15 minutes.",
      );
    } catch (error) {
      // Aborts can happen in any await (including the polling delay or media transfer),
      // not just at the top of the loop. Finish cleanup before releasing the browser queue.
      await this.#stopGenerating(window);
      if (
        error instanceof ChatGptSessionError &&
        bridgeOwnsComposerState &&
        !submissionAttempted
      ) {
        await this.#discardUnsubmittedComposerState(window);
      }
      if (
        error instanceof UnsupportedWebNativeToolError ||
        (error instanceof ChatGptRateLimitError && submissionAccepted)
      ) {
        // The prompt was accepted. Keep that exact chat and its synchronized context
        // for bounded correction/recovery; starting a blank chat loses the task and
        // any completed connector calls.
        if (input.threadId)
          await this.#conversations.remember(
            input.threadId,
            window.webContents.getURL(),
            sync?.receipt,
            projectUrl,
          );
        this.#receipt = sync?.receipt;
      }
      if (error instanceof ChatGptRateLimitError && submissionAccepted) {
        throw new ChatGptRateLimitError(
          error.retryAfterSeconds,
          true,
          error.rateLimitSource,
        );
      }
      throw error;
    } finally {
      this.#submissionInFlight = false;
      this.#observedRateLimit = undefined;
      await this.#watchGeneration(window, null);
    }
  }

  async #sendFullContextStage(
    window: ChatGptWindow,
    input: RunWebTurnInput,
    stage: FullContextMessage,
    family: string,
    trace: CompletionTrace,
    index: number,
    projectUrl?: string,
  ): Promise<void> {
    const connector = input.connectorName?.trim();
    if (
      !connector ||
      !input.allowWebNativeTools ||
      !stage.acknowledgement ||
      !input.execution ||
      bridgeExecutionLimitProblem(input.execution)
    )
      throw new FullContextTransferError(
        "The inert Full context stage failed its preflight. No stage was submitted.",
      );
    const stageInput = {
      ...input,
      operationId: createHash("sha256")
        .update(`${input.operationId}:context-stage-${index}`)
        .digest("hex"),
    };
    let submitted = false;
    let bound = false;
    const prepare = async (): Promise<void> => {
      input.signal.throwIfAborted();
      await this.#ensureTemporaryChat(window, input);
      await this.#assertServerSession(window, input.signal);
      await this.#resetComposerState(window, input.signal, connector);
      bound = await this.#hasBoundConnectorConversation(window, connector);
      if (!bound)
        await this.#selectFullMcpConnector(window, connector, input.signal, 2);
      await this.#selectMode(window, input.mode, input.signal, family);
      if (bound) await this.#fillComposer(window, stage.text);
      else await this.#appendPromptAfterConnector(window, stage.text);
      await this.#verifyBeforeSubmit(window, stageInput, family, bound);
    };
    try {
      await prepare();
      const baseline = await this.#observe(window);
      await this.#watchGeneration(window, randomUUID());
      await this.pool.waitUntilAvailable(input.signal, (seconds) =>
        input.onProgress?.(`cooldown_${seconds}`),
      );
      if (this.#operationKey)
        await this.journal.mark(this.#operationKey, "submitting");
      this.#submissionInFlight = true;
      submitted = true;
      input.onProgress?.("submitting");
      trace.mark(`context-stage-${index}-submitting`);
      await this.#submit(window, prepare);
      let observation = await this.#waitForSubmission(
        window,
        baseline,
        true,
        input.signal,
      );
      if (this.#operationKey)
        await this.journal.mark(this.#operationKey, "accepted");
      await this.#recordAcceptedSend(
        stageInput,
        `context-stage-${index}`,
      ).catch(() => undefined);
      if (input.threadId)
        await this.#conversations.remember(
          input.threadId,
          window.webContents.getURL(),
          undefined,
          projectUrl,
        );
      const completion = new ChatGptCompletionTracker();
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        input.signal.throwIfAborted();
        const limited = this.#rateLimitObservation();
        if (limited) throw limited.error;
        if (
          observation.error ||
          observation.webNativeToolPresent ||
          observation.mediaPending ||
          observation.hasRenderableMedia
        )
          throw new FullContextTransferError(
            "ChatGPT produced an error, tool call, or media during inert context transport. The final commit was withheld.",
          );
        const hasNewAssistant =
          (observation.userToken !== baseline.userToken ||
            !baseline.userToken) &&
          !baseline.logicalTurnIds.includes(observation.assistantToken) &&
          (observation.assistantCount > baseline.assistantCount ||
            (!!observation.assistantToken &&
              observation.assistantToken !== baseline.assistantToken));
        const completed = completion.update({
          hasNewAssistant,
          assistantToken: observation.assistantToken,
          userToken: observation.userToken,
          terminalConfirmed: observation.terminalConfirmed,
          text: observation.text,
          html: observation.html,
          hasRenderableMedia: observation.hasRenderableMedia,
          busy: observation.busy,
          responseBusy: observation.responseBusy,
          mediaPending: observation.mediaPending,
          webNativeToolPending: observation.webNativeToolPending,
          webNativeToolPresent: observation.webNativeToolPresent,
          completionActionVisible: observation.completionActionVisible,
        });
        if (completed !== undefined) {
          if (
            typeof completed !== "string" ||
            completed.trim() !== stage.acknowledgement
          )
            throw new FullContextTransferError(
              `ChatGPT did not acknowledge context part ${index} exactly. The final commit was withheld; canonical history was retained.`,
            );
          const transfer = input.execution.multipart;
          if (this.#operationKey && transfer)
            await this.journal.acknowledgeContextStage(
              this.#operationKey,
              transfer.transactionId,
              transfer.part,
              transfer.total,
              transfer.digest,
            );
          // An ACK can replace the empty-page Temporary Chat controls before
          // the next part. Retain its exact verified document and answer just
          // as for a completed user turn, without committing canonical context.
          await this.#rememberTemporarySource(window, input, observation);
          if (observation.terminalConfirmed)
            this.#confirmedCompletion = {
              userToken: observation.userToken,
              assistantMessageId: observation.assistantMessageId,
              requestCount: observation.generationRequestCount,
              text: observation.text,
            };
          if (this.modelReceipt) {
            this.modelReceipt = { ...this.modelReceipt, phase: "completed" };
            await this.recordModel?.(this.modelReceipt);
          }
          trace.mark(`context-stage-${index}-acknowledged`);
          return;
        }
        input.onProgress?.("generating");
        await delay(250, input.signal);
        observation = await this.#observe(window);
      }
      throw new FullContextTransferError(
        `Context part ${index} exceeded its three-minute acknowledgement deadline. The final commit was withheld.`,
      );
    } catch (error) {
      await this.#stopGenerating(window);
      if (!submitted) await this.#discardUnsubmittedComposerState(window);
      if (input.signal.aborted) throw error;
      throw error instanceof FullContextTransferError
        ? error
        : new FullContextTransferError(
            `Full context part ${index} did not finish (${errorMessage(error)}). Its submission will not be repeated automatically; the final commit was withheld.`,
          );
    } finally {
      this.#submissionInFlight = false;
      this.#observedRateLimit = undefined;
      await this.#watchGeneration(window, null);
    }
  }

  async #watchGeneration(
    window: ChatGptWindow,
    id: string | null,
  ): Promise<void> {
    if (id === null) {
      // Cleanup must not enter challenge recovery after submissionInFlight is
      // cleared: the failed request's exact page still belongs to the user.
      await window.webContents
        .executeJavaScript(`(${watchChatGptGeneration.toString()})(null)`)
        .catch(() => undefined);
      return;
    }
    // Unsupported page transports retain the conservative DOM completion path.
    await this.#execute<void>(
      window,
      "watch-generation",
      `(${watchChatGptGeneration.toString()})(${JSON.stringify(id)}, ${BRIDGE_FULL_TURN_TIMEOUT_MS})`,
    ).catch(() => undefined);
  }

  /**
   * ChatGPT can mount its request-frequency modal just after the completed
   * answer becomes returnable. Keep a bounded observer alive after delivery so
   * the stale modal is acknowledged before another task reaches Send.
   */
  #watchForPostCompletionRateLimit(window: ChatGptWindow): void {
    this.#postCompletionRateLimitWatch?.abort();
    const owner = new AbortController();
    this.#postCompletionRateLimitWatch = owner;
    void (async () => {
      const deadline = Date.now() + POST_COMPLETION_RATE_LIMIT_WATCH_MS;
      while (Date.now() < deadline) {
        await delay(100, owner.signal);
        if (window.isDestroyed() || this.#window !== window) return;
        const blocked = await window.webContents
          .executeJavaScript(`(${observeChatGptPageBlock.toString()})()`, true)
          .catch(() => null);
        if (blocked !== "rate-limit") continue;
        const acknowledged = await window.webContents
          .executeJavaScript(
            `(${acknowledgeChatGptRateLimitDialog.toString()})()`,
            true,
          )
          .catch(() => false);
        if (!acknowledged) this.pool.rateLimited();
        this.#refreshBrowserControls(window);
        return;
      }
    })()
      .catch((error: unknown) => {
        if (!(error instanceof Error && error.name === "AbortError")) {
          // Best-effort cleanup after a result was delivered. The next normal
          // browser stage still performs the authoritative page-block check.
        }
      })
      .finally(() => {
        if (this.#postCompletionRateLimitWatch === owner)
          this.#postCompletionRateLimitWatch = undefined;
      });
  }

  #rateLimitObservation():
    | { readonly error: ChatGptRateLimitError; readonly observedAt: number }
    | undefined {
    return this.#observedRateLimit;
  }

  #rememberRecoverableToolFailure(observation: Observation): void {
    if (
      !observation.webNativeToolPresent ||
      !observation.userToken ||
      !observation.assistantToken ||
      !observation.assistantMessageId
    ) {
      this.#recoverableToolFailure = undefined;
      return;
    }
    this.#recoverableToolFailure = {
      userToken: observation.userToken,
      assistantToken: observation.assistantToken,
      assistantMessageId: observation.assistantMessageId,
      requestCount: observation.generationRequestCount,
      error: observation.webNativeToolError,
    };
  }

  async #saveGeneratedImages(
    window: ChatGptWindow,
    imageUrls: readonly string[],
    turnId: string | undefined,
    signal: AbortSignal,
  ): Promise<readonly BridgeGeneratedImage[]> {
    const downloads = await downloadGeneratedImages(
      imageUrls,
      (url, init) => window.webContents.session.fetch(url, init),
      signal,
    );
    if (downloads.length === 0) return [];
    signal.throwIfAborted();

    const directory = join(
      process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
      "generated_images",
      turnId && /^[a-zA-Z0-9_-]{1,128}$/.test(turnId)
        ? turnId
        : `codexgpt-bridge-${randomUUID()}`,
    );
    await mkdir(directory, { recursive: true });
    const images: BridgeGeneratedImage[] = [];
    for (const download of downloads) {
      signal.throwIfAborted();
      const path = join(
        directory,
        `chatgpt-image-${randomUUID()}.${download.extension}`,
      );
      await writeFile(path, download.bytes, { flag: "wx" });
      images.push({
        base64: download.bytes.toString("base64"),
        mimeType: download.mimeType,
        localPath: path,
      });
    }
    return images;
  }

  async #rememberTemporarySource(
    window: ChatGptWindow,
    input: RunWebTurnInput,
    observation: Observation,
  ): Promise<void> {
    if (
      !this.#temporaryChat ||
      !input.threadId ||
      !this.#verifiedTemporaryDocumentToken
    )
      return;
    const temporary = await this.#observeTemporaryChat(window);
    if (
      temporary.documentToken !== this.#verifiedTemporaryDocumentToken ||
      temporary.inactive ||
      temporary.ambiguous
    ) {
      this.#temporarySource = undefined;
      return;
    }
    this.#temporarySource = {
      thread: input.threadId,
      url: window.webContents.getURL(),
      documentToken: temporary.documentToken,
      userToken: observation.userToken,
      assistantToken: observation.assistantToken,
      assistantMessageId: observation.assistantMessageId,
      requestCount: observation.generationRequestCount,
      text: observation.text,
      streamConfirmed: observation.terminalConfirmed,
      ...(input.allowWebNativeTools && input.connectorName?.trim()
        ? { connectorName: input.connectorName.trim() }
        : {}),
    };
  }

  async #isRetainedTemporarySource(
    window: ChatGptWindow,
    input: Pick<RunWebTurnInput, "threadId">,
  ): Promise<boolean> {
    const proof = this.#temporarySource;
    const reject = (reason: string): false => {
      this.#preparationTrace?.event(`temporary-source-${reason}`);
      return false;
    };
    if (!proof) return reject("missing");
    // Full MCP can render only the assistant search unit (fallback-turn-0),
    // omitting the submitted user bubble entirely. In that surface, bind the
    // source to the owned, stream-confirmed generation and exact message ID.
    // DOM-only completions still require a rendered user identity.
    if (
      !proof.assistantToken ||
      (!proof.userToken &&
        !(
          proof.streamConfirmed &&
          proof.assistantMessageId &&
          proof.requestCount > 0
        ))
    )
      return reject("identity-missing");
    if (proof.thread !== input.threadId) return reject("task-changed");
    if (proof.url !== window.webContents.getURL()) return reject("url-changed");
    const observation = await this.#observe(window);
    const temporary = await this.#observeTemporaryChat(window);
    // This binds the page's identity, not its generation state. The normal
    // pre-submit checks separately reject active responses and verify any
    // stream-confirmed stale Stop before permitting another submission.
    if (temporary.documentToken !== proof.documentToken)
      return reject("document-changed");
    // The native App surface first renders fallback-turn-0 with no user bubble,
    // then hydrates real turn groups when the composer is used again. Those DOM
    // tokens are not durable identities. A previously stream-confirmed answer
    // is still bound to this document, exact message, request count and body.
    if (!proof.streamConfirmed && observation.userToken !== proof.userToken)
      return reject("user-changed");
    if (
      !proof.streamConfirmed &&
      observation.assistantToken !== proof.assistantToken
    )
      return reject("assistant-changed");
    if (observation.assistantMessageId !== proof.assistantMessageId)
      return reject("message-changed");
    if (observation.generationRequestCount !== proof.requestCount)
      return reject("generation-changed");
    if (!sameCompletedBody(observation.text, proof.text))
      return reject("body-changed");
    this.#preparationTrace?.event("temporary-source-retained");
    return true;
  }

  async #observeTemporaryChat(
    window: ChatGptWindow,
  ): Promise<ReturnType<typeof observeTemporaryChat>> {
    return this.#execute<ReturnType<typeof observeTemporaryChat>>(
      window,
      "temporary-chat-proof",
      `(${observeTemporaryChat.toString()})()`,
    );
  }

  async #ensureTemporaryChat(
    window: ChatGptWindow,
    input: RunWebTurnInput,
  ): Promise<void> {
    if (!this.#temporaryChat) return;
    const deadline = Date.now() + 8_000;
    let unpersonalized = false;
    do {
      input.signal.throwIfAborted();
      const state = await this.#observeTemporaryChat(window);
      const proof = this.#temporarySource;
      const sameDocument =
        proof?.thread === input.threadId &&
        proof?.url === window.webContents.getURL() &&
        proof?.documentToken === state.documentToken;
      const temporaryUrl = isTemporaryChatUrl(
        window.webContents.getURL(),
        this.#baseUrl,
      );
      if (!temporaryUrl && !sameDocument) break;
      const retained =
        sameDocument && (await this.#isRetainedTemporarySource(window, input));
      const sameRetainedDocument =
        retained &&
        this.#temporarySource?.url === window.webContents.getURL() &&
        this.#temporarySource.documentToken === state.documentToken;
      if (state.inactive || state.ambiguous) break;
      // Typing can briefly unmount the old answer. Wait only in this exact
      // owned document, and require the complete source proof to return.
      if (!temporaryUrl && !sameRetainedDocument) {
        await delay(100, input.signal);
        continue;
      }
      // Completed Temporary Chats can omit the empty-page header toggle. Only
      // the exact document previously verified as temporary may inherit proof;
      // an explicit inactive or conflicting control always rejects submission.
      if (
        !state.inactive &&
        !state.ambiguous &&
        (state.active || sameRetainedDocument)
      ) {
        unpersonalized = Boolean(
          input.allowWebNativeTools && state.unpersonalized,
        );
        // The server-rendered header may start Unpersonalized before account
        // preferences hydrate. Observe it; never click to change that preference.
        if (!unpersonalized) {
          this.#verifiedTemporaryDocumentToken = state.documentToken;
          return;
        }
      }
      await delay(100, input.signal);
    } while (Date.now() < deadline);
    if (unpersonalized)
      throw new PreparationError(
        "Temporary Chat 目前為 Unpersonalized，無法使用 Full MCP App。請在 ChatGPT 自行選擇是否允許 Personalized，或停用暫時模式後建立新任務。尚未送出訊息；Bridge 不會自動更改個人化設定。",
        "error",
      );
    throw new PreparationError(
      "無法驗證 Temporary Chat 已啟用，尚未送出訊息。請開啟 ChatGPT 檢查暫時聊天介面；不會改用一般對話。",
      "error",
    );
  }

  async #ensureReady(
    window: ChatGptWindow,
    signal: AbortSignal,
  ): Promise<void> {
    // The document may already expose a usable composer while subresources are loading.
    // Waiting for a did-finish-load event here races with loadURL and can waste 20 seconds.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const observation = await this.#observe(window);
      if (observation.composer) {
        await this.#assertServerSession(window, signal);
        return;
      }
      await delay(250, signal);
    }
    throw new Error(
      "ChatGPT is not signed in or the composer UI is unavailable. Open the ChatGPT login window first.",
    );
  }

  async #assertServerSession(
    window: ChatGptWindow,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#backendAccess.get(window)?.blocked)
      await this.#recoverCloudflareChallenge(window, signal);
    let result;
    try {
      result = await probeChatGptPageSession(
        this.#baseUrl,
        window.webContents,
        signal,
      );
    } catch (error) {
      const backend = this.#backendAccess.get(window);
      if (!(error instanceof ChatGptSessionChallengeError) || !backend)
        throw error;
      backend.markChallenge(new URL("/api/auth/session", this.#baseUrl).href);
      await this.#recoverCloudflareChallenge(window, signal);
      result = await probeChatGptPageSession(
        this.#baseUrl,
        window.webContents,
        signal,
      );
    }
    this.#usageAccount = result.usageAccount;
  }

  async #readSelection(window: ChatGptWindow): Promise<ModelUiObservation> {
    return this.#execute<ModelUiObservation>(
      window,
      "observe-model-selection",
      `(${observeModelSelection.toString()})(${modelPickerRoots.toString()})`,
    );
  }

  async #readModelMenu(window: ChatGptWindow): Promise<ModelMenuKind> {
    return this.#execute<ModelMenuKind>(
      window,
      "model-menu-state",
      `(${observeModelMenu.toString()})(${modelPickerRoots.toString()})`,
    );
  }

  async #openModelMenu(
    window: ChatGptWindow,
    signal: AbortSignal,
  ): Promise<ModelMenuKind> {
    return this.#timed("model-menu-ready", async () => {
      const deadline = Date.now() + 8_000;
      let clicks = 0;
      let clickedAt = 0;
      let keyboardActivated = false;
      let state: ModelMenuKind;
      do {
        signal.throwIfAborted();
        state = await this.#readModelMenu(window);
        if (state !== "closed" && state !== "loading") return state;
        // A server-rendered button can appear before its handler hydrates. Allow
        // one fresh activation after an unacknowledged click, never while the
        // button is expanded or a portal (including a loading one) is mounted.
        if (
          state === "closed" &&
          clicks < 2 &&
          (clicks === 0 || Date.now() - clickedAt >= 3_000) &&
          (await this.#clickComposerModeControl(window))
        ) {
          clicks++;
          clickedAt = Date.now();
        }
        // Attaching an App can move the composer while a pointer activation is
        // in flight. Activate only the same verified, focusable model control;
        // never use a keyboard shortcut on the composer or on an open popup.
        if (
          state === "closed" &&
          clicks === 2 &&
          !keyboardActivated &&
          Date.now() - clickedAt >= 2_000 &&
          (await this.#clickComposerModeControl(window, true))
        ) {
          keyboardActivated = true;
        }
        await delay(50, signal);
      } while (Date.now() < deadline);
      return state;
    });
  }

  async #verifyBeforeSubmit(
    window: ChatGptWindow,
    input: RunWebTurnInput,
    family: string,
    connectorBoundToConversation = false,
  ): Promise<void> {
    input.signal.throwIfAborted();
    await this.#ensureTemporaryChat(window, input);
    await this.#dismissChatGptMenus(window);
    let observed = await this.#readSelection(window);
    // A unique, visible and enabled composer control is direct effort evidence
    // for mode-only routes. Opening a portal is only necessary to inspect a
    // pinned model family or to resolve a missing/mismatched effort.
    if (!isModeOnlySelectionVerified(input.mode, family, observed)) {
      let menu = await this.#openModelMenu(window, input.signal);
      if (menu === "configure-entry") {
        await this.#openIntelligenceConfigure(window, input.signal);
        menu = await this.#readModelMenu(window);
      }
      observed = await this.#readSelection(window);
      if (
        menu === "closed" ||
        menu === "loading" ||
        menu === "configure-entry"
      ) {
        observed = { ...observed, mode: null, surface: "missing" };
      } else {
        const deadline = Date.now() + 3_000;
        while (
          !observed.ambiguous &&
          !observed.disabled &&
          (observed.mode === null ||
            (family && observed.model === null) ||
            !nativeModelDescriptionsMatch(
              family,
              input.mode,
              observed.modelDescriptions ?? [],
            )) &&
          Date.now() < deadline
        ) {
          await delay(50, input.signal);
          observed = await this.#readSelection(window);
        }
      }
    }
    await this.#dismissChatGptMenus(window);
    const receipt = verifyModelSelection(
      input.operationId ?? turnKey(input),
      input.mode,
      family,
      observed,
      input.execution,
    );
    this.modelReceipt = receipt;
    await this.#timed("model-receipt-write", async () => {
      await this.recordModel?.(receipt);
    });
    if (receipt.confidence === "REJECTED") {
      throw new PreparationError(
        `Model selection verification failed: requested ${family || "current model"} / ${input.mode}; observed ${observed.model ?? "unknown model"} / ${observed.mode ?? "unknown effort"}. No prompt was submitted.`,
        observed.surface === "missing" || observed.mode === null
          ? "model-selection-missing"
          : observed.ambiguous
            ? "model-selection-ambiguous"
            : observed.disabled
              ? "model-selection-disabled"
              : "model-selection-mismatch",
      );
    }
    const composerState = await this.#readComposerState(window);
    if (input.allowWebNativeTools) {
      const connectorName = input.connectorName?.trim();
      const exactSelections = connectorName
        ? composerState.nativeToolSelections.filter(
            (selection) => selection === connectorName,
          ).length
        : 0;
      const exactSelected =
        composerState.nativeToolSelectionCount === 1 && exactSelections === 1;
      const exactConversationBinding =
        connectorName &&
        connectorBoundToConversation &&
        composerState.nativeToolSelectionCount === 0
          ? await this.#hasBoundConnectorConversation(window, connectorName)
          : false;
      if (!connectorName || (!exactSelected && !exactConversationBinding)) {
        throw new PreparationError(
          `Full MCP requires an exact ChatGPT connector binding named ${JSON.stringify(connectorName ?? "")}. No prompt was submitted.`,
          "full-mcp-connector-unavailable",
        );
      }
    } else if (composerState.nativeToolSelectionCount !== 0) {
      throw new PreparationError(
        "ChatGPT still has a native App or Connector selected. Bridge blocked submission so the Codex tool protocol cannot be routed to an App template.",
        "native-tool-selection-active",
      );
    }
    await this.#timed("server-session-before-submit", () =>
      this.#assertServerSession(window, input.signal),
    );
  }

  async #selectFamily(
    window: ChatGptWindow,
    family: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    await this.#dismissChatGptMenus(window);
    const menu = await this.#openModelMenu(window, signal);
    if (menu !== "slider" && menu !== "plain" && menu !== "models")
      return false;
    const before = await this.#readSelection(window);
    if (
      before.model &&
      !before.disabled &&
      !before.ambiguous &&
      modelSelectionLabelMatches(family, before.model)
    ) {
      await this.#dismissChatGptMenus(window);
      return true;
    }
    const selected = await this.#execute<boolean>(
      window,
      "select-requested-model",
      `(${revealModelFamilyOptions.toString()})(${modelPickerRoots.toString()})`,
    );
    if (!selected && menu !== "models") {
      await this.#dismissChatGptMenus(window);
      return false;
    }
    await delay(200, signal);
    const clicked = await this.#execute<boolean>(
      window,
      "select-requested-model-option",
      `(() => {
        const equal = ${modelSelectionLabelMatches.toString()};
        const root = document.querySelector('[data-testid="composer-intelligence-picker-content"]') || document.querySelector('[role="menu"]');
        const candidates = [...(root?.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"]') || [])].filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && !el.closest('[inert], [aria-hidden="true"]')
            && getComputedStyle(el).visibility !== 'hidden' && el.getAttribute('aria-disabled') !== 'true'
            && !(el instanceof HTMLButtonElement && el.disabled)
            && equal(${JSON.stringify(family)}, (el.textContent || '').trim());
        });
        if (candidates.length !== 1) return false;
        candidates[0].click(); return true;
      })()`,
    );
    if (!clicked)
      throw new PreparationError(
        `Requested ChatGPT model ${family} is unavailable; no fallback model was selected.`,
        "model-selection-missing",
      );
    await delay(200, signal);
    await this.#dismissChatGptMenus(window);
    return true;
  }

  async #setLunaThinkMode(
    window: ChatGptWindow,
    enabled: boolean,
    signal: AbortSignal,
    allowUnavailable = false,
  ): Promise<boolean> {
    signal.throwIfAborted();
    await this.#dismissChatGptMenus(window);
    const targetMode: BridgeWebMode = enabled ? "think" : "luna";
    const before = await this.#readSelection(window);
    if (before.mode === targetMode && !before.ambiguous && !before.disabled) {
      return true;
    }
    if (
      before.ambiguous ||
      before.disabled ||
      (before.mode !== "luna" && before.mode !== "think")
    ) {
      if (allowUnavailable) return false;
      throw new PreparationError(
        `ChatGPT ${targetMode} cannot be selected because the Luna composer state is unavailable or ambiguous. No prompt was submitted.`,
        before.ambiguous
          ? "model-selection-ambiguous"
          : before.disabled
            ? "model-selection-disabled"
            : "model-selection-missing",
      );
    }

    const composerBefore = await this.#readComposerState(window);
    if (!composerBefore.composer || hasComposerText(composerBefore.draftText)) {
      throw new PreparationError(
        "ChatGPT /think can only be changed in an empty composer. No prompt was submitted.",
        "model-selection-mismatch",
      );
    }
    const selectionsBefore = [...composerBefore.nativeToolSelections];
    const sameSelections = (selections: readonly string[]): boolean =>
      selections.length === selectionsBefore.length &&
      selections.every((value, index) => value === selectionsBefore[index]);

    const focused = await this.#execute<boolean>(
      window,
      "focus-composer-for-think",
      `(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return element.isConnected && rect.width > 0 && rect.height > 0
            && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const composer = [...document.querySelectorAll('#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]')]
          .find(visible);
        if (!(composer instanceof HTMLElement)) return false;
        composer.focus();
        if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
          const end = composer.value.length;
          composer.setSelectionRange(end, end);
        } else {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(composer);
          range.collapse(false);
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        return document.activeElement === composer || composer.contains(document.activeElement);
      })()`,
    );
    if (!focused) {
      throw new PreparationError(
        "ChatGPT composer could not be focused for /think selection. No prompt was submitted.",
        "model-selection-missing",
      );
    }

    for (const character of "/think") {
      signal.throwIfAborted();
      await window.webContents.insertText(character);
      await delay(35, signal);
    }

    type ThinkCommandObservation = {
      readonly rootCount: number;
      readonly exactCount: number;
      readonly highlighted: boolean;
    };
    const readCommand = (): Promise<ThinkCommandObservation> =>
      this.#execute<ThinkCommandObservation>(
        window,
        "observe-think-command",
        `(() => {
          const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return element.isConnected && rect.width > 0 && rect.height > 0
              && style.display !== 'none' && style.visibility !== 'hidden'
              && !element.closest('[inert], [aria-hidden="true"], [data-message-author-role], [data-testid^="conversation-turn-"]');
          };
          const normalized = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
          const composer = [...document.querySelectorAll('#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]')]
            .find(visible);
          const composerRect = composer?.getBoundingClientRect();
          const nearComposer = (element) => {
            if (!composerRect) return false;
            const rect = element.getBoundingClientRect();
            return rect.right >= composerRect.left && rect.left <= composerRect.right
              && rect.bottom >= Math.max(0, composerRect.top - 700)
              && rect.top <= composerRect.bottom + 140;
          };
          const roots = [...document.querySelectorAll('.popover[aria-busy="false"]')]
            .filter(element => visible(element) && nearComposer(element));
          const rows = roots.flatMap(root => [...root.querySelectorAll('.__menu-item[tabindex="0"], [role="option"], [role="menuitem"]')])
            .filter(visible);
          const exact = rows.filter(row => {
            const own = normalized((row.textContent ?? '').split('\\n')[0]);
            return own === 'Think' || [...row.querySelectorAll('*')].some(child => normalized(child.textContent) === 'Think');
          });
          return {
            rootCount: roots.length,
            exactCount: exact.length,
            highlighted: exact.length === 1 && (
              exact[0].getAttribute('aria-selected') === 'true'
              || exact[0].getAttribute('data-highlighted') !== null
              || exact[0].getAttribute('data-active') === 'true'
            )
          };
        })()`,
      );

    const clearTypedCommand = async (): Promise<void> => {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ESCAPE" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "ESCAPE" });
      for (let index = 0; index < "/think".length; index += 1) {
        window.webContents.sendInputEvent({
          type: "keyDown",
          keyCode: "BACKSPACE",
        });
        window.webContents.sendInputEvent({
          type: "keyUp",
          keyCode: "BACKSPACE",
        });
      }
      const deadline = Date.now() + 1_000;
      do {
        signal.throwIfAborted();
        const state = await this.#readComposerState(window);
        if (
          !hasComposerText(state.draftText) &&
          sameSelections(state.nativeToolSelections)
        )
          return;
        await delay(50, signal);
      } while (Date.now() < deadline);
      throw new PreparationError(
        "ChatGPT /think capability probe could not restore the empty composer. No prompt was submitted.",
        "model-selection-mismatch",
      );
    };

    const commandDeadline = Date.now() + 3_000;
    let command = await readCommand();
    while (
      command.rootCount === 0 &&
      command.exactCount === 0 &&
      Date.now() < commandDeadline
    ) {
      await delay(50, signal);
      command = await readCommand();
    }
    if (command.rootCount !== 1 || command.exactCount !== 1) {
      await clearTypedCommand();
      if (allowUnavailable && command.rootCount === 0) return false;
      throw new PreparationError(
        `ChatGPT /think command is unavailable or ambiguous (popovers=${command.rootCount}, exactRows=${command.exactCount}). No prompt was submitted.`,
        command.rootCount > 1 || command.exactCount > 1
          ? "model-selection-ambiguous"
          : "model-selection-missing",
      );
    }
    if (!command.highlighted) {
      window.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "ARROWDOWN",
      });
      window.webContents.sendInputEvent({
        type: "keyUp",
        keyCode: "ARROWDOWN",
      });
      await delay(100, signal);
      command = await readCommand();
      if (
        command.rootCount !== 1 ||
        command.exactCount !== 1 ||
        !command.highlighted
      ) {
        await clearTypedCommand();
        throw new PreparationError(
          "ChatGPT /think command could not be uniquely highlighted. No prompt was submitted.",
          "model-selection-ambiguous",
        );
      }
    }
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ENTER" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "ENTER" });

    const verificationDeadline = Date.now() + 5_000;
    let observed = await this.#readSelection(window);
    while (
      (observed.mode !== targetMode ||
        observed.ambiguous ||
        observed.disabled) &&
      Date.now() < verificationDeadline
    ) {
      await delay(50, signal);
      observed = await this.#readSelection(window);
    }
    const composerAfter = await this.#readComposerState(window);
    if (
      observed.mode !== targetMode ||
      observed.ambiguous ||
      observed.disabled ||
      hasComposerText(composerAfter.draftText) ||
      !sameSelections(composerAfter.nativeToolSelections)
    ) {
      throw new PreparationError(
        `ChatGPT /think did not verify ${targetMode} or preserve the empty composer and selected connector. No prompt was submitted.`,
        observed.ambiguous
          ? "model-selection-ambiguous"
          : "model-selection-mismatch",
      );
    }
    return true;
  }

  async #selectMode(
    window: ChatGptWindow,
    mode: RunWebTurnInput["mode"],
    signal: AbortSignal,
    family = "",
  ): Promise<void> {
    if (mode === "luna" || mode === "think") {
      await this.#setLunaThinkMode(window, mode === "think", signal);
      return;
    }
    const target = bridgeIntelligenceTarget(mode, family || undefined);
    const retained = await this.#readSelection(window);
    if (
      mode !== "pro" &&
      verifyModelSelection("selection-check", mode, family, retained)
        .confidence !== "REJECTED"
    )
      return;
    if (family && !(await this.#selectFamily(window, family, signal))) {
      if (
        await this.#selectModeViaIntelligenceConfigure(window, target, signal)
      )
        return;
      throw new PreparationError(
        `Requested ChatGPT model ${family} could not be selected. No prompt was submitted.`,
        "model-menu-unavailable",
      );
    }
    const current = await this.#readSelection(window);
    if (
      mode !== "pro" &&
      current.mode === mode &&
      !current.ambiguous &&
      !current.disabled
    )
      return; // The mandatory post-attachment verification still runs before submission.

    const directMenuState = await this.#readModelMenu(window);
    if (directMenuState === "models") {
      await this.#dismissChatGptMenus(window);
      if (current.mode === mode || mode === "high") {
        return;
      }
    }

    let directMenuError: unknown;
    try {
      if (
        await this.#timed("select-direct-menu", () =>
          this.#selectModeViaDirectEffortMenu(window, mode, signal),
        )
      )
        return;
    } catch (error) {
      // A recognized Pro control must fail explicitly instead of falling through
      // to an older picker that could accept a different model or effort.
      if (error instanceof PreparationError) throw error;
      if (mode === "pro") throw error;
      directMenuError = error;
      await this.#dismissChatGptMenus(window);
    }

    // A recognized plain effort menu does not need a slow Configure-dialog probe.
    // This changes only the selection path; final state verification remains mandatory.
    if (
      await this.#timed("select-plain-menu", () =>
        this.#selectPlainEffortMenu(window, mode, signal),
      )
    )
      return;

    let configureError: unknown;
    try {
      if (
        await this.#timed("select-configure-menu", () =>
          this.#selectModeViaIntelligenceConfigure(window, target, signal),
        )
      )
        return;
      await this.#dismissChatGptMenus(window);
    } catch (error) {
      if (error instanceof PreparationError) throw error;
      configureError = error;
      await this.#dismissChatGptMenus(window);
    }

    const details = [directMenuError, configureError]
      .filter((error) => error !== undefined)
      .map(errorMessage)
      .join("; ");
    throw new PreparationError(
      `ChatGPT ${mode} could not be selected using a recognized model control. No prompt was submitted.${details ? " " + details : ""}`,
      "model-menu-unavailable",
    );
  }

  async #selectPlainEffortMenu(
    window: ChatGptWindow,
    mode: IntelligenceBridgeMode,
    signal: AbortSignal,
  ): Promise<boolean> {
    const menuKind = await this.#readModelMenu(window);
    if (menuKind === "models") {
      const current = await this.#readSelection(window);
      await this.#dismissChatGptMenus(window);
      if (current.mode === mode || mode === "high") {
        return true;
      }
      return false;
    }
    if (menuKind !== "plain") return false;
    const find = () =>
      this.#execute<"selected" | "missing" | "disabled" | "ambiguous">(
        window,
        "select-plain-effort",
        `(() => {
        const aliases = { instant: ['instant','light','low','低'], medium: ['medium','中','中等'], high: ['high','高'], 'extra-high': ['extra high','xhigh','極高','极高'], pro: ['pro'] };
        const candidates = [...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"], [role="listbox"] [role="option"]')].filter(el => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || el.closest('[inert], [aria-hidden="true"]') || getComputedStyle(el).visibility === 'hidden') return false;
          const label = (el.textContent || '').trim().toLowerCase().replace(/[-_]/g, ' ').replace(/ +/g, ' ');
          return aliases[${JSON.stringify(mode)}].includes(label);
        });
        if (!candidates.length) return 'missing';
        if (candidates.length !== 1) return 'ambiguous';
        const option = candidates[0];
        if (option.getAttribute('aria-disabled') === 'true' || option.disabled === true) return 'disabled';
        option.click(); return 'selected';
      })()`,
      );
    const state = await find();
    if (state === "disabled" || state === "ambiguous")
      throw new PreparationError(
        `ChatGPT ${mode} effort menu is ${state}. No prompt was submitted.`,
        state === "disabled"
          ? "model-selection-disabled"
          : "model-selection-ambiguous",
      );
    if (state !== "selected") return false;
    await delay(150, signal);
    return true;
  }

  async #selectModeViaDirectEffortMenu(
    window: ChatGptWindow,
    mode: IntelligenceBridgeMode,
    signal: AbortSignal,
  ): Promise<boolean> {
    await this.#dismissChatGptMenus(window);
    let menuKind = await this.#openModelMenu(window, signal);
    if (menuKind === "models") {
      const deadline = Date.now() + 1_500;
      while (menuKind === "models" && Date.now() < deadline) {
        await delay(100, signal);
        menuKind = await this.#readModelMenu(window);
      }
    }
    if (menuKind === "models") {
      const current = await this.#readSelection(window);
      await this.#dismissChatGptMenus(window);
      if (current.mode === mode || mode === "high") {
        return true;
      }
      return false;
    }
    if (menuKind === "loading") {
      throw new PreparationError(
        "ChatGPT reasoning controls remained incomplete after the model menu opened.",
        "model-menu-unavailable",
      );
    }
    if (menuKind !== "slider") return false;

    const proSliderModel =
      mode === "pro" ? await this.#readProSliderModel(window) : undefined;
    const readSlider = () => this.#readEffortSlider(window, true);
    let slider = await readSlider();
    for (let attempt = 0; slider === undefined && attempt < 8; attempt += 1) {
      await delay(150, signal);
      slider = await readSlider();
    }
    const sliderSupportsPro =
      slider !== undefined && slider.max - slider.min + 1 >= 5;
    if (mode === "pro" && proSliderModel === undefined && !sliderSupportsPro) {
      const pro = await this.#execute<
        | { readonly x: number; readonly y: number; readonly disabled: boolean }
        | undefined
      >(
        window,
        "direct-effort-pro-option",
        // Preserve regex escapes when sending this script to the renderer.
        String.raw`(() => {
          const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          };
          const option = [...document.querySelectorAll('[role="menuitemradio"], [role="option"], [role="menuitem"]')]
            .filter(visible)
            .find((element) => /^Pro\b/i.test((element.textContent || element.getAttribute('aria-label') || '').trim()));
          if (!(option instanceof HTMLElement)) return undefined;
          const rect = option.getBoundingClientRect();
          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            disabled: option.getAttribute('aria-disabled') === 'true' || ('disabled' in option && option.disabled === true),
          };
        })()`,
      );
      if (pro === undefined) return false;
      if (pro.disabled)
        throw new PreparationError(
          "ChatGPT Pro mode is disabled for this account.",
          "model-selection-disabled",
        );
      this.#sendMouseClick(window, pro.x, pro.y);
      await delay(300, signal);
      return true;
    }
    if (slider === undefined) return false;
    if (slider.disabled)
      throw new PreparationError(
        "ChatGPT reasoning slider is disabled. No prompt was submitted.",
        "model-selection-disabled",
      );
    const plan = planEffortSliderSelection(
      mode,
      slider.min,
      slider.max,
      slider.value,
    );
    for (const keyCode of plan.keys) {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode });
      await delay(100, signal);
    }
    await delay(300, signal);
    const observedSlider = await this.#readEffortSlider(window, false);
    const selected =
      observedSlider !== undefined &&
      !observedSlider.disabled &&
      observedSlider.value === plan.targetValue;
    if (!selected) {
      throw new PreparationError(
        `ChatGPT ${mode} reasoning level could not be selected.`,
        "model-selection-mismatch",
      );
    }
    if (mode === "pro" && proSliderModel !== undefined) {
      const confirmed = await this.#execute<boolean>(
        window,
        "direct-effort-pro-slider-verify",
        String.raw`(() => {
          const picker = document.querySelector('[data-testid="composer-intelligence-picker-content"]');
          const label = picker?.querySelector('[role="menuitem"][aria-expanded]')?.textContent || '';
          const model = picker?.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent || '';
          return /Pro(?:\s|$)/i.test(label)
            && model.trim() === ${JSON.stringify(proSliderModel)};
        })()`,
      );
      if (!confirmed) {
        throw new PreparationError(
          "ChatGPT did not confirm Pro for the current model at the selected slider position. No prompt was submitted.",
          "model-selection-mismatch",
        );
      }
    }
    await this.#dismissChatGptMenus(window);
    return true;
  }

  async #readProSliderModel(
    window: ChatGptWindow,
  ): Promise<string | undefined> {
    return this.#readProSliderModelValue(window);
  }

  async #readEffortSlider(
    window: ChatGptWindow,
    focus: boolean,
  ): Promise<ModelSliderState | undefined> {
    return this.#execute<ModelSliderState | undefined>(
      window,
      "model-effort-slider",
      `(${readModelSlider.toString()})(${modelPickerRoots.toString()}, ${JSON.stringify(focus)})`,
    );
  }

  async #readProSliderModelValue(
    window: ChatGptWindow,
  ): Promise<string | undefined> {
    return this.#execute<string | undefined>(
      window,
      "pro-slider-current-model",
      `(() => {
        const picker = document.querySelector('[data-testid="composer-intelligence-picker-content"]');
        // The model panel mounts before the animated slider on a fresh page.
        if (!picker?.querySelector('[data-testid="composer-model-picker-slider-advanced-view"]')) return undefined;
        const model = picker.querySelector('[role="menuitemradio"][aria-checked="true"]');
        if (!(model instanceof HTMLElement)) throw new Error('The Pro slider did not expose its current model.');
        const toggle = picker.querySelector('[role="menuitem"][aria-expanded="true"]');
        if (toggle instanceof HTMLElement) toggle.click();
        return (model.textContent || '').trim();
      })()`,
    );
  }

  async #selectModeViaIntelligenceConfigure(
    window: ChatGptWindow,
    target: IntelligenceTarget,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!(await this.#openIntelligenceConfigure(window, signal))) return false;
    try {
      const before = await this.#readConfigureOptions(window);
      const family = target.model ?? before.selectedModel;
      if (!family)
        throw new PreparationError(
          "ChatGPT did not expose its current model in Intelligence Configure.",
          "model-selection-missing",
        );
      await this.#selectConfigureModel(window, family, signal);
      await this.#selectConfigureMode(window, target.mode, signal);
      if (target.effort !== undefined) {
        await this.#selectConfigureEffort(
          window,
          target.effort,
          target.mode,
          signal,
        );
      }

      const selected = await this.#readConfigureOptions(window);
      const modelSelected =
        selected.selectedModel !== null &&
        modelLabelsEqual(selected.selectedModel, family);
      const modeSelected = selected.selectedMode === target.mode;
      const effortSelected =
        target.effort === undefined ||
        selected.selectedEffort === target.effort;
      if (!modelSelected || !modeSelected || !effortSelected) {
        throw new PreparationError(
          `ChatGPT Intelligence Configure did not confirm ${target.label} (${formatConfigureOptions(selected)}).`,
          "model-selection-mismatch",
        );
      }
      return true;
    } finally {
      await this.#dismissChatGptMenus(window);
    }
  }

  async #openIntelligenceConfigure(
    window: ChatGptWindow,
    signal: AbortSignal,
  ): Promise<boolean> {
    const menu = await this.#readModelMenu(window);
    if (menu === "configure") return true;
    // A recognized slider/plain menu cannot become Configure by repeated clicks.
    // Only follow a real Configure entry, and wait for its dialog to mount once.
    if (menu !== "configure-entry") return false;
    if (!(await this.#clickIntelligenceConfigureMenuItem(window))) return false;
    const deadline = Date.now() + 3_000;
    do {
      signal.throwIfAborted();
      if (await this.#isIntelligenceConfigureOpen(window)) return true;
      await delay(50, signal);
    } while (Date.now() < deadline);
    throw new PreparationError(
      "ChatGPT Configure dialog did not become ready. No prompt was submitted.",
      "model-menu-unavailable",
    );
  }

  async #clickComposerModeControl(
    window: ChatGptWindow,
    keyboard = false,
  ): Promise<boolean> {
    const target = await this.#execute<
      | { readonly x: number; readonly y: number; readonly expanded: boolean }
      | undefined
    >(
      window,
      "click-intelligence-mode-control",
      `(${composerModelControlTarget.toString()})(${JSON.stringify(keyboard)})`,
    );
    if (target === undefined || target.expanded) return false;
    if (keyboard) {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "SPACE" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "SPACE" });
    } else {
      this.#sendMouseClick(window, target.x, target.y);
    }
    return true;
  }

  #sendMouseClick(window: ChatGptWindow, x: number, y: number): void {
    window.webContents.sendInputEvent({
      type: "mouseDown",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    window.webContents.sendInputEvent({
      type: "mouseUp",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  async #clickIntelligenceConfigureMenuItem(
    window: ChatGptWindow,
  ): Promise<boolean> {
    return this.#execute<boolean>(
      window,
      "click-intelligence-configure",
      `(() => {
        const normalize = (value) => String(value ?? '').trim().replace(/\\s+/g, ' ');
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const candidates = [...document.querySelectorAll('[role="menu"] [data-testid="model-configure-modal"], [role="menu"] button, [role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"], [data-testid="composer-intelligence-picker-content"] [role="menuitem"]')]
          .filter((element) => visible(element) && !element.closest('aside, nav, [role="navigation"], [data-testid*="sidebar"], [data-message-author-role], pre, code'));
        const target = candidates.find((element) => element.getAttribute('data-testid') === 'model-configure-modal')
          || candidates.find((element) => /^(Configure(?:\\.{3}|\\u2026)|設定|设置|配置)$/i.test(normalize(element.innerText || element.textContent)));
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
      })()`,
    );
  }

  async #isIntelligenceConfigureOpen(window: ChatGptWindow): Promise<boolean> {
    return this.#execute<boolean>(
      window,
      "intelligence-configure-open",
      `(() => {
        const normalize = (value) => String(value ?? '').trim().replace(/\\s+/g, ' ');
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        return [...document.querySelectorAll('[role="dialog"], [data-testid="model-configure-modal"]')]
          .some((element) => {
            const text = normalize(element.innerText || element.textContent);
            return visible(element) && /\\bIntelligence\\b|智慧|智能/i.test(text) && /\\bModel\\b|模型/i.test(text);
          });
      })()`,
    ).catch(() => false);
  }

  async #selectConfigureModel(
    window: ChatGptWindow,
    model: string,
    signal: AbortSignal,
  ): Promise<void> {
    const before = await this.#readConfigureOptions(window);
    if (before.selectedModel && modelLabelsEqual(before.selectedModel, model))
      return;
    const opened = await this.#clickConfigureSectionValueControl(
      window,
      "^Model$|^模型$",
      "^(?:GPT[- ]?)?(?:[0-9]+(?:[.][0-9]+)*(?: [A-Za-z0-9 -]+)?|o[0-9]+.*)$|^(?:Latest|最新的|最新)$",
    );
    if (!opened) {
      throw new Error(
        `Could not find the ChatGPT model selector in Intelligence Configure (${formatConfigureOptions(before)}).`,
      );
    }
    await delay(300, signal);
    if (!(await this.#clickConfigureOption(window, model))) {
      const available = await this.#readConfigureOptions(window);
      throw new Error(
        `ChatGPT does not expose model ${model} in Intelligence Configure (${formatConfigureOptions(available)}).`,
      );
    }
    await delay(300, signal);
  }

  async #selectConfigureMode(
    window: ChatGptWindow,
    mode: IntelligenceMode,
    signal: AbortSignal,
  ): Promise<void> {
    const label = INTELLIGENCE_MODE_LABELS[mode];
    if (!(await this.#clickConfigureOption(window, label))) {
      const available = await this.#readConfigureOptions(window);
      throw new Error(
        `ChatGPT does not expose ${label} mode in Intelligence Configure (${formatConfigureOptions(available)}).`,
      );
    }
    await delay(300, signal);
  }

  async #selectConfigureEffort(
    window: ChatGptWindow,
    effort: IntelligenceEffort,
    mode: IntelligenceMode,
    signal: AbortSignal,
  ): Promise<void> {
    const selected = await this.#readConfigureOptions(window);
    if (selected.selectedEffort === effort) return;
    const opened = await this.#clickConfigureSectionValueControl(
      window,
      mode === "pro"
        ? "^Pro thinking effort$|^Pro 推理|^Pro 思考"
        : "^(?:Thinking effort|Pro thinking effort)$|^推理|^思考",
      "^(Light|Standard|Extended|Heavy|輕量|轻量|標準|标准|延伸|擴展|扩展|重度)$",
    );
    if (!opened) {
      throw new Error(
        `Could not find the ChatGPT reasoning effort selector in Intelligence Configure (${formatConfigureOptions(selected)}).`,
      );
    }
    await delay(300, signal);
    const label = INTELLIGENCE_EFFORT_LABELS[effort];
    if (!(await this.#clickConfigureOption(window, label))) {
      const available = await this.#readConfigureOptions(window);
      throw new Error(
        `ChatGPT does not expose ${label} effort in Intelligence Configure (${formatConfigureOptions(available)}).`,
      );
    }
    await delay(300, signal);
  }

  async #clickConfigureSectionValueControl(
    window: ChatGptWindow,
    sectionPattern: string,
    valuePattern: string,
  ): Promise<boolean> {
    return this.#execute<boolean>(
      window,
      "click-configure-section-value",
      `(() => {
        const sectionRe = new RegExp(${JSON.stringify(sectionPattern)}, 'i');
        const valueRe = new RegExp(${JSON.stringify(valuePattern)}, 'i');
        const normalize = (value) => String(value ?? '').trim().replace(/\\s+/g, ' ');
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const scope = [...document.querySelectorAll('[role="dialog"], [data-testid="model-configure-modal"]')]
          .filter(visible)
          .find((element) => {
            const text = normalize(element.innerText || element.textContent);
            return /\\bIntelligence\\b|智慧|智能/i.test(text) && /\\bModel\\b|模型/i.test(text);
          });
        if (!scope) return false;
        const elements = [...scope.querySelectorAll('*')].filter(visible);
        const labels = elements
          .map((element) => ({
            element,
            text: normalize(element.innerText || element.textContent),
            rect: element.getBoundingClientRect(),
          }))
          .filter((entry) => sectionRe.test(entry.text));
        const controls = elements
          .filter((element) => element.matches('button, [role="button"], [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"]'))
          .map((element) => ({
            element,
            text: normalize(element.innerText || element.textContent),
            rect: element.getBoundingClientRect(),
          }))
          .filter((entry) => valueRe.test(entry.text));
        for (const label of labels) {
          const labelCenterY = label.rect.top + label.rect.height / 2;
          const sameRow = controls
            .filter((control) => {
              const controlCenterY = control.rect.top + control.rect.height / 2;
              return Math.abs(controlCenterY - labelCenterY) < 80 && control.rect.left > label.rect.left;
            })
            .sort((left, right) => left.rect.left - right.rect.left);
          const target = sameRow[0];
          if (target?.element instanceof HTMLElement) {
            target.element.click();
            return true;
          }
        }
        return false;
      })()`,
    );
  }

  async #clickConfigureOption(
    window: ChatGptWindow,
    label: string,
  ): Promise<boolean> {
    return this.#execute<boolean>(
      window,
      `click-configure-option-${label}`,
      `(() => {
        const label = ${JSON.stringify(label)};
        const normalize = (value) => String(value ?? '').trim().replace(/\\s+/g, ' ');
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const dialogs = [...document.querySelectorAll('[role="dialog"], [data-testid="model-configure-modal"]')]
          .filter(visible)
          .filter((element) => {
            const text = normalize(element.innerText || element.textContent);
            return /\\bIntelligence\\b|智慧|智能/i.test(text) && /\\bModel\\b|模型/i.test(text);
          });
        const dialog = dialogs.length === 1 ? dialogs[0] : undefined;
        if (!dialog) return false;
        const dialogRect = dialog.getBoundingClientRect();
        const inConfigureArea = (element) => {
          const rect = element.getBoundingClientRect();
          const inDialog = rect.left >= dialogRect.left - 8
            && rect.top >= dialogRect.top - 8
            && rect.right <= dialogRect.right + 8
            && rect.bottom <= dialogRect.bottom + 8;
          const inAdjacentPopover = rect.left >= dialogRect.left - 8
            && rect.left <= dialogRect.right + 560
            && rect.top >= dialogRect.top - 8
            && rect.top <= dialogRect.bottom + 320;
          return inDialog || inAdjacentPopover;
        };
        const candidates = [...document.querySelectorAll('button, [role="button"], [role="radio"], [role="option"], [role="menuitem"], [role="menuitemradio"]')]
          .filter((element) => visible(element) && inConfigureArea(element));
        const target = candidates.find((element) => {
          const text = normalize(element.innerText || element.textContent);
          return text === label || text.startsWith(label + ' ') || text.startsWith(label + '\\n');
        });
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
      })()`,
    );
  }

  async #readConfigureOptions(
    window: ChatGptWindow,
  ): Promise<IntelligenceConfigureOptions> {
    return this.#execute<IntelligenceConfigureOptions>(
      window,
      "read-configure-options",
      `(() => {
        const normalize = (value) => String(value ?? '').trim().replace(/\\s+/g, ' ');
        const unique = (values) => [...new Set(values.filter(Boolean))];
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const enabled = (element) => element.getAttribute('aria-disabled') !== 'true'
          && !('disabled' in element && element.disabled === true);
        const blank = {
          models: [],
          modes: [],
          efforts: [],
          selectedModel: null,
          selectedMode: null,
          selectedEffort: null,
          textSnippet: '',
        };
        const allVisible = (selector) => [...document.querySelectorAll(selector)].filter(visible);
        const scope = allVisible('[role="dialog"], [data-testid="model-configure-modal"]')
          .find((element) => {
            const text = normalize(element.innerText || element.textContent);
            return /\\bIntelligence\\b|智慧|智能/i.test(text) && /\\bModel\\b|模型/i.test(text);
          });
        if (!scope) return blank;
        const text = normalize(scope.innerText || scope.textContent);
        const elements = [...scope.querySelectorAll('*')].filter(visible);
        const modelRe = /^(?:GPT[- ]?)?(?:[0-9]+(?:[.][0-9]+)*(?: [A-Za-z0-9 -]+)?|o[0-9]+.*)$|^(?:Latest|最新的|最新)$/i;
        const effortRe = /^(Light|Standard|Extended|Heavy)$/i;
        const elementText = (element) => normalize(element.innerText || element.textContent);
        const toMode = (value) => {
          const normalized = normalize(value);
          if (/^Instant\\b/i.test(normalized)) return 'instant';
          if (/^Thinking\\b/i.test(normalized)) return 'thinking';
          if (/^Pro\\b/i.test(normalized)) return 'pro';
          return null;
        };
        const selectedModelControl = elements.find((element) => element.matches('[role="combobox"]') && modelRe.test(elementText(element)));
        const selectedModel = selectedModelControl ? elementText(selectedModelControl) : null;
        const modelOptions = allVisible('[role="option"]')
          .filter(enabled)
          .map(elementText)
          .filter((value) => modelRe.test(value));
        const modeRows = elements.filter((element) => element.matches('[role="radio"]') && enabled(element));
        const modes = unique(modeRows.map((element) => toMode(elementText(element))));
        const checkedMode = modeRows.find((element) => element.getAttribute('aria-checked') === 'true');
        const selectedMode = checkedMode ? toMode(elementText(checkedMode)) : null;
        const selectedEffortControl = elements.find((element) => element.matches('[role="combobox"]') && effortRe.test(elementText(element)));
        const selectedEffort = selectedEffortControl ? elementText(selectedEffortControl).toLowerCase() : null;
        const effortOptions = allVisible('[role="option"]')
          .filter(enabled)
          .map(elementText)
          .filter((value) => effortRe.test(value));
        return {
          models: unique([selectedModel, ...modelOptions]),
          modes,
          efforts: unique([selectedEffort, ...effortOptions]),
          selectedModel,
          selectedMode,
          selectedEffort,
          textSnippet: text.slice(0, 1200),
        };
      })()`,
    ).catch(() => ({
      models: [],
      modes: [],
      efforts: [],
      selectedModel: null,
      selectedMode: null,
      selectedEffort: null,
      textSnippet: "",
    }));
  }

  async #dismissChatGptMenus(window: ChatGptWindow): Promise<void> {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ESCAPE" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "ESCAPE" });
    await delay(150).catch(() => undefined);
  }

  async #readComposerState(window: ChatGptWindow): Promise<{
    readonly composer: boolean;
    readonly focused: boolean;
    readonly text: string;
    readonly draftText: string;
    readonly nativeToolSelectionCount: number;
    readonly nativeToolSelections: readonly string[];
    readonly surface: string;
  }> {
    return this.#execute(
      window,
      "observe-composer-state",
      `(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return element.isConnected
            && rect.width > 0
            && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden';
        };
        const candidates = [...document.querySelectorAll('#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]')];
        const composer = candidates.find(visible);
        const surface = JSON.stringify(candidates.map(el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return { width: Math.round(rect.width), height: Math.round(rect.height), display: style.display, visibility: style.visibility, focused: document.activeElement === el, connected: el.isConnected };
        }));
        if (!(composer instanceof HTMLElement)) {
          return { composer: false, focused: false, text: '', draftText: '', nativeToolSelectionCount: 0, nativeToolSelections: [], surface };
        }
        const form = composer.closest('form');
        const root = form ?? composer;
        const selected = [...root.querySelectorAll([
          '[data-id^="plugin:"][data-keyword]',
          '[data-id^="connector:"][data-keyword]',
          '[data-id^="app:"][data-keyword]',
          '[data-plugin-id][data-keyword]',
          '[data-connector-id][data-keyword]',
          '[app-mention-name][app-mention-display-name][app-mention-path^="app://"][contenteditable="false"]'
        ].join(', '))].filter(visible);
        const nativeToolSelections = selected
          .map(element => (element.getAttribute('app-mention-display-name') ?? element.getAttribute('data-keyword') ?? '').trim())
          .filter(Boolean);
        const text = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
          ? composer.value
          : composer.textContent ?? '';
        let draftText = text;
        if (!(composer instanceof HTMLTextAreaElement) && !(composer instanceof HTMLInputElement)) {
          const copy = composer.cloneNode(true);
          if (copy instanceof Element) {
            for (const node of copy.querySelectorAll([
              '[data-id^="plugin:"][data-keyword]',
              '[data-id^="connector:"][data-keyword]',
              '[data-id^="app:"][data-keyword]',
              '[data-plugin-id][data-keyword]',
              '[data-connector-id][data-keyword]',
              '[app-mention-name][app-mention-display-name][app-mention-path^="app://"][contenteditable="false"]'
            ].join(', '))) node.remove();
            draftText = copy.textContent ?? '';
          }
        }
        return {
          composer: true,
          focused: document.activeElement === composer || composer.contains(document.activeElement),
          text,
          draftText,
          nativeToolSelectionCount: selected.length,
          nativeToolSelections,
          surface
        };
      })()`,
    );
  }

  async #resetComposerState(
    window: ChatGptWindow,
    signal: AbortSignal,
    retainedConnector?: string,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.#dismissChatGptMenus(window);
    const focusComposer = () =>
      this.#execute<boolean>(
        window,
        "focus-composer-for-reset",
        `(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return element.isConnected
            && rect.width > 0
            && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden';
        };
        const composer = [...document.querySelectorAll('#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]')]
          .find(visible);
        if (!(composer instanceof HTMLElement)) return false;
        composer.focus();
        if (!(composer instanceof HTMLTextAreaElement) && !(composer instanceof HTMLInputElement)) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(composer);
          range.collapse(false);
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        return document.activeElement === composer || composer.contains(document.activeElement);
      })()`,
      );
    if (!(await focusComposer())) {
      throw new PreparationError(
        "ChatGPT composer could not be focused for a clean submission. No prompt was submitted.",
        "native-tool-selection-active",
      );
    }

    // Retained conversations can already have an empty composer. Do not send
    // deletion shortcuts into a freshly mounted editor when there is no draft
    // or native selection to clear; still require the actual editor as proof.
    const initial = await this.#readComposerState(window);
    // ChatGPT can persist the selected App across editor remounts. Full MCP
    // may reuse only its exact, sole connector with no remaining prompt text.
    // Local/native-tool-isolated turns never opt in to this branch.
    if (
      initial.composer &&
      initial.focused &&
      retainedConnector &&
      initial.nativeToolSelectionCount === 1 &&
      initial.nativeToolSelections[0] === retainedConnector &&
      !hasComposerText(initial.draftText)
    )
      return;
    if (
      initial.composer &&
      initial.focused &&
      !hasComposerText(initial.text) &&
      initial.nativeToolSelectionCount === 0
    ) {
      return;
    }

    // A selected App/Connector is a structured Lexical node backed by React
    // state. Directly replacing textContent can hide the pill while retaining
    // its request routing. Real keyboard deletion updates both DOM and state.
    // Electron queues these native events. After an App approval card closes,
    // Lexical can acknowledge focus before its selection is ready, so one
    // immediate Ctrl+A/Backspace leaves an invisible draft behind. Retry the
    // real keyboard cleanup with a short selection-settle interval.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      signal.throwIfAborted();
      if (attempt > 1 && !(await focusComposer())) break;
      window.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "A",
        modifiers: ["control"],
      });
      window.webContents.sendInputEvent({
        type: "keyUp",
        keyCode: "A",
        modifiers: ["control"],
      });
      await delay(50 * attempt, signal);
      // Removing a retained App can unmount its editor. Never send Backspace
      // to the document while ChatGPT is replacing that editor.
      let selected = await this.#readComposerState(window);
      const remountDeadline = Date.now() + 8_000;
      while (!selected.composer && Date.now() < remountDeadline) {
        await delay(100, signal);
        selected = await this.#readComposerState(window);
      }
      if (!selected.composer) break;
      if (
        !hasComposerText(selected.text) &&
        selected.nativeToolSelectionCount === 0
      )
        return;
      if (!selected.focused) continue;
      window.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "BACKSPACE",
      });
      window.webContents.sendInputEvent({
        type: "keyUp",
        keyCode: "BACKSPACE",
      });

      let deadline = Date.now() + 650;
      let remountObserved = false;
      do {
        signal.throwIfAborted();
        const state = await this.#readComposerState(window);
        if (!state.composer && !remountObserved) {
          remountObserved = true;
          deadline = Date.now() + 8_000;
        }
        if (
          state.composer &&
          !hasComposerText(state.text) &&
          state.nativeToolSelectionCount === 0
        ) {
          return;
        }
        await delay(100, signal);
      } while (Date.now() < deadline);
    }
    const state = await this.#readComposerState(window);
    throw new PreparationError(
      `ChatGPT did not clear the unsent composer state (text=${hasComposerText(state.text)}, appSelections=${state.nativeToolSelectionCount}). No prompt was submitted.`,
      "native-tool-selection-active",
    );
  }

  async #discardUnsubmittedComposerState(window: ChatGptWindow): Promise<void> {
    // The Bridge owns this draft. Clear it with the same trusted-keyboard path
    // used before submission, then prove it stays empty after Lexical settles.
    // A reload is only a best-effort fallback because ChatGPT can restore drafts.
    const signal = AbortSignal.timeout(15_000);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await this.#resetComposerState(window, signal);
        await delay(500, signal);
        const state = await this.#readComposerState(window);
        if (
          state.composer &&
          !hasComposerText(state.text) &&
          state.nativeToolSelectionCount === 0
        )
          return;
      }
    } catch {
      // Fall through to a reload and one final trusted cleanup attempt.
    }
    const url = window.webContents.getURL();
    if (!url) return;
    await window.loadURL(url).catch(() => undefined);
    const reloadSignal = AbortSignal.timeout(15_000);
    await this.#ensureReady(window, reloadSignal).catch(() => undefined);
    await this.#resetComposerState(window, reloadSignal).catch(() => undefined);
  }

  async #hasBoundConnectorConversation(
    window: ChatGptWindow,
    connectorName: string,
  ): Promise<boolean> {
    // ChatGPT may omit the original user/App pill from its native response
    // surface. Reattaching that App remounts the conversation and picker. Reuse
    // only our completed, verified App submission in the exact retained page;
    // a reload, task switch, another response or changed App invalidates it.
    const proof = this.#temporarySource;
    if (
      proof?.streamConfirmed &&
      proof.connectorName === connectorName &&
      proof.thread === this.#activeThread &&
      (await this.#isRetainedTemporarySource(window, {
        threadId: this.#activeThread,
      }))
    ) {
      this.#preparationTrace?.event("connector-conversation-retained");
      return true;
    }
    return this.#execute<boolean>(
      window,
      "connector-conversation-binding",
      `(() => {
        const connectorName = ${JSON.stringify(connectorName)};
        const normalize = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
        const userMessages = [...new Set(document.querySelectorAll('[data-message-author-role="user"], [data-user-message-bubble], [data-chatgpt-search-unit-key$=":user"], [data-content-search-unit-key$=":user"]'))]
          .filter(element => !element.closest('#prompt-textarea, [contenteditable="true"], pre, code'));
        const exactPill = userMessages.some((message) =>
          [...message.querySelectorAll('[data-inline-selection-pill][data-keyword], a[href*="/plugins/"], [app-mention-name][app-mention-display-name][app-mention-path^="app://"]')]
            .some((element) =>
              normalize(element.getAttribute('app-mention-display-name') ?? element.getAttribute('data-keyword') ?? element.textContent) === connectorName
            )
        );
        if (exactPill) return true;

        // ChatGPT's Electron renderer can omit the old App pill/link while it
        // still keeps the conversation bound and hides that App from the
        // picker. Bridge-authored Full MCP protocol plus a later native tool
        // card proves this exact conversation previously ran through the named
        // connector; ordinary user text or a file with the same name cannot.
        const quotedConnector = 'connector named "' + connectorName + '"';
        const bridgeProtocolTurns = userMessages
          .map((message) => message.closest('[data-testid^="conversation-turn-"]'))
          .filter((turn) => {
            const text = normalize(turn?.textContent);
            return text.includes('[Codex Full MCP protocol v1]')
              && text.includes('Pass this turn_token unchanged')
              && text.includes('Call codex_tool_inventory')
              && text.includes(quotedConnector);
          });
        if (bridgeProtocolTurns.length === 0) return false;
        const turns = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')];
        return bridgeProtocolTurns.some((protocolTurn) => {
          const start = turns.indexOf(protocolTurn);
          for (let index = start + 1; index < turns.length; index += 1) {
            const turn = turns[index];
            if (turn.querySelector('[data-message-author-role="user"]')) break;
            if (turn.querySelector('button[aria-label="Open tool call list"]')) return true;
          }
          return false;
        });
      })()`,
    );
  }

  async #selectFullMcpConnector(
    window: ChatGptWindow,
    connectorName: string,
    signal: AbortSignal,
    maxAttempts = 3,
  ): Promise<void> {
    const retained = await this.#readComposerState(window);
    if (
      retained.composer &&
      retained.nativeToolSelectionCount === 1 &&
      retained.nativeToolSelections[0] === connectorName &&
      !hasComposerText(retained.draftText)
    )
      return;
    const firstWord = connectorName.split(/\s+/u)[0] ?? connectorName;
    // Project files and Apps share ChatGPT's @ picker. An abbreviated App query
    // can leave only a similarly ranked file row visible, so search with the
    // complete configured App label first and retain the short query as fallback.
    const mentionQueries = [connectorName.slice(0, 80), firstWord.slice(0, 40)];
    const serializedName = JSON.stringify(connectorName);
    let visibleTitles: readonly string[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      signal.throwIfAborted();
      const mentionQuery =
        mentionQueries[(attempt - 1) % mentionQueries.length] ?? connectorName;
      const focused = await this.#execute<boolean>(
        window,
        "focus-composer-for-connector",
        `(() => {
          const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return element.isConnected
              && rect.width > 0
              && rect.height > 0
              && style.display !== 'none'
              && style.visibility !== 'hidden';
          };
          const composer = [...document.querySelectorAll('#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]')]
            .find(visible);
          if (!(composer instanceof HTMLElement)) return false;
          composer.focus();
          return document.activeElement === composer || composer.contains(document.activeElement);
        })()`,
      );
      if (!focused) {
        throw new PreparationError(
          "ChatGPT composer could not be focused to select the Full MCP connector. No prompt was submitted.",
          "native-tool-selection-active",
        );
      }
      // ChatGPT's App picker is opened by the standalone `@` input event. On a
      // retained App-backed conversation its React/Lexical surface can take
      // longer than one task to mount, and a bulk query insertion is then lost.
      // Wait for that surface and enter the query like real keyboard input.
      await window.webContents.insertText("@");
      await delay(350 + (attempt - 1) * 150, signal);
      for (const character of mentionQuery) {
        signal.throwIfAborted();
        await window.webContents.insertText(character);
        await delay(35, signal);
      }

      const deadline = Date.now() + 3_000;
      let exactCount: number;
      do {
        signal.throwIfAborted();
        const menu = await this.#execute<{
          readonly exactCount: number;
          readonly visibleTitles: readonly string[];
        }>(
          window,
          "observe-connector-menu",
          `(() => {
            const connectorName = ${serializedName};
            const visible = (element) => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return element.isConnected
                && rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden';
            };
            const normalized = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
            const composer = [...document.querySelectorAll('#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]')]
              .find(visible);
            const composerRect = composer?.getBoundingClientRect();
            const nearComposer = (element) => {
              if (!composerRect) return false;
              const rect = element.getBoundingClientRect();
              return rect.right >= composerRect.left
                && rect.left <= composerRect.right
                && rect.bottom >= Math.max(0, composerRect.top - 700)
                && rect.top <= composerRect.bottom + 120;
            };
            const declaredRows = [...document.querySelectorAll('.__menu-item[tabindex="0"], [role="option"], [role="menuitem"]')];
            const exactInteractive = [...document.querySelectorAll('button, [role="button"], [tabindex="0"]')]
              .filter(element => {
                if (!visible(element) || !nearComposer(element)) return false;
                if (element.closest('[data-message-author-role], [data-testid^="conversation-turn-"]')) return false;
                const ownTitle = normalized((element.textContent ?? '').split('\\n')[0]);
                return ownTitle === connectorName
                  || [...element.querySelectorAll('*')].some(child => normalized(child.textContent) === connectorName);
              });
            const rows = [...new Set([...declaredRows, ...exactInteractive])]
              .filter(element => visible(element) && nearComposer(element))
              .filter(element => !element.closest('[data-message-author-role], [data-testid^="conversation-turn-"]'));
            const title = (row) => normalized((row.textContent ?? '').split('\\n')[0]);
            const exact = rows.filter(row =>
              title(row) === connectorName
              || [...row.querySelectorAll('*')].some(child => normalized(child.textContent) === connectorName)
            );
            return {
              exactCount: exact.length,
              visibleTitles: rows.map(title).filter(Boolean).slice(0, 20)
            };
          })()`,
        );
        exactCount = menu.exactCount;
        visibleTitles = menu.visibleTitles;
        if (exactCount !== 0) break;
        await delay(50, signal);
      } while (Date.now() < deadline);

      if (exactCount > 1) {
        throw new PreparationError(
          `ChatGPT exposed duplicate connector rows named ${JSON.stringify(connectorName)}. No prompt was submitted.`,
          "full-mcp-connector-unavailable",
        );
      }
      if (exactCount === 1) {
        const activated = await this.#execute<boolean>(
          window,
          "activate-connector",
          `(() => {
            const connectorName = ${serializedName};
            const visible = (element) => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return element.isConnected
                && rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden';
            };
            const normalized = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
            const composer = [...document.querySelectorAll('#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]')]
              .find(visible);
            const composerRect = composer?.getBoundingClientRect();
            const nearComposer = (element) => {
              if (!composerRect) return false;
              const rect = element.getBoundingClientRect();
              return rect.right >= composerRect.left
                && rect.left <= composerRect.right
                && rect.bottom >= Math.max(0, composerRect.top - 700)
                && rect.top <= composerRect.bottom + 120;
            };
            const declaredRows = [...document.querySelectorAll('.__menu-item[tabindex="0"], [role="option"], [role="menuitem"]')];
            const exactInteractive = [...document.querySelectorAll('button, [role="button"], [tabindex="0"]')]
              .filter(element => {
                if (!visible(element) || !nearComposer(element)) return false;
                if (element.closest('[data-message-author-role], [data-testid^="conversation-turn-"]')) return false;
                const ownTitle = normalized((element.textContent ?? '').split('\\n')[0]);
                return ownTitle === connectorName
                  || [...element.querySelectorAll('*')].some(child => normalized(child.textContent) === connectorName);
              });
            const rows = [...new Set([...declaredRows, ...exactInteractive])]
              .filter(element => visible(element) && nearComposer(element))
              .filter(element => !element.closest('[data-message-author-role], [data-testid^="conversation-turn-"]'));
            const exact = rows.filter(row => {
              const title = normalized((row.textContent ?? '').split('\\n')[0]);
              return title === connectorName
                || [...row.querySelectorAll('*')].some(child => normalized(child.textContent) === connectorName);
            });
            if (exact.length !== 1 || !(exact[0] instanceof HTMLElement)) return false;
            exact[0].click();
            return true;
          })()`,
        );
        if (activated) {
          const selectedDeadline = Date.now() + 3_000;
          do {
            signal.throwIfAborted();
            const state = await this.#readComposerState(window);
            if (
              state.nativeToolSelectionCount === 1 &&
              state.nativeToolSelections[0] === connectorName
            ) {
              return;
            }
            await delay(50, signal);
          } while (Date.now() < selectedDeadline);
        }
      }

      await this.#resetComposerState(window, signal);
      await delay(250 * attempt, signal);
    }

    const catalog = visibleTitles.length
      ? " The picker opened, but did not expose that App."
      : " The App picker did not expose any rows.";
    throw new PreparationError(
      `ChatGPT could not select the exact Full MCP connector ${JSON.stringify(connectorName)} after ${maxAttempts} ${maxAttempts === 1 ? "attempt" : "attempts"}.${catalog} Create or enable that connector, then retry. No prompt was submitted.`,
      "full-mcp-connector-unavailable",
    );
  }

  async #appendPromptAfterConnector(
    window: ChatGptWindow,
    prompt: string,
  ): Promise<void> {
    const focused = await this.#execute<boolean>(
      window,
      "focus-composer-after-connector",
      `(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return element.isConnected
            && rect.width > 0
            && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden';
        };
        const composer = [...document.querySelectorAll('#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]')]
          .find(visible);
        if (!(composer instanceof HTMLElement)) return false;
        composer.focus();
        if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
          const end = composer.value.length;
          composer.setSelectionRange(end, end);
        } else {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(composer);
          range.collapse(false);
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        return document.activeElement === composer || composer.contains(document.activeElement);
      })()`,
    );
    if (!focused) {
      throw new PreparationError(
        "ChatGPT composer could not be focused after selecting the Full MCP connector. No prompt was submitted.",
        "native-tool-selection-active",
      );
    }
    await window.webContents.insertText(` ${prompt}`);
  }

  async #fillComposer(window: ChatGptWindow, prompt: string): Promise<void> {
    const focused = await this.#execute<boolean>(
      window,
      "focus-composer-for-fill",
      `(() => {
        const candidates = [...document.querySelectorAll('#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]')].filter(element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const emptyEditable = element instanceof HTMLElement && element.isContentEditable && !(element.textContent ?? '').trim();
          return element.isConnected && rect.width > 0 && (rect.height > 0 || emptyEditable)
            && style.display !== 'none' && style.visibility !== 'hidden'
            && !element.closest('[inert], [aria-hidden="true"], aside, nav, [data-message-author-role], [data-user-message-bubble], pre, code, [role="menu"], [role="dialog"]');
        });
        const roots = candidates.filter(element => !candidates.some(other => other !== element && other.contains(element)));
        if (roots.length !== 1 || !(roots[0] instanceof HTMLElement)) return false;
        const composer = roots[0];
        composer.focus({ preventScroll: true });
        if (document.activeElement !== composer && !composer.contains(document.activeElement)) return false;
        if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
          composer.setSelectionRange(0, composer.value.length);
        } else {
          const selection = window.getSelection();
          if (!selection) return false;
          const range = document.createRange();
          range.selectNodeContents(composer);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return true;
      })()`,
    );
    if (!focused)
      throw new PreparationError(
        "ChatGPT composer could not be safely focused to insert the prompt. No prompt was submitted.",
        "native-tool-selection-active",
      );
    // Let the browser and editor own input. Direct DOM replacement followed by
    // another synthetic event can leave Lexical state and Send out of sync.
    await window.webContents.insertText(prompt);
  }

  async #attachImages(
    window: ChatGptWindow,
    images: RunWebTurnInput["images"],
    signal: AbortSignal,
  ): Promise<void> {
    const files = chatGptImageFiles(images);
    if (files.length === 0) return;
    const serialized = JSON.stringify(files);
    const accepted = await this.#execute<{
      readonly ok: boolean;
      readonly reason?: string;
    }>(
      window,
      "attach-images",
      `(() => {
        const files = ${serialized};
        const composer = document.querySelector('#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]');
        const form = composer?.closest('form') ?? document.querySelector('form[data-chatgpt-composer]');
        const selector = 'input[data-testid="upload-photos-input"], input[type="file"][multiple]:not([accept]), input[type="file"][accept*="image"]';
        const input = form?.querySelector(selector) ?? document.querySelector(selector);
        if (!(input instanceof HTMLInputElement)) return { ok: false, reason: 'upload input missing' };
        if (input.disabled) return { ok: false, reason: 'upload input disabled' };
        try {
          const transfer = new DataTransfer();
          for (const file of files) {
            const binary = atob(file.base64);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
            transfer.items.add(new File([bytes], file.name, { type: file.mimeType, lastModified: Date.now() }));
          }
          input.files = transfer.files;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
      })()`,
    );
    if (!accepted.ok) {
      throw new Error(
        `ChatGPT image attachment failed: ${accepted.reason ?? "unknown browser error"}.`,
      );
    }

    const expectedNames = files.map((file) => file.name);
    const expectedNamesJson = JSON.stringify(expectedNames);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (signal.aborted) {
        throw new DOMException("Provider turn was cancelled.", "AbortError");
      }
      const state = await this.#execute<{
        readonly ready: boolean;
        readonly error: string;
      }>(
        window,
        "wait-for-images",
        `(() => {
          const expectedNames = ${expectedNamesJson};
          const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          };
          const composer = document.querySelector('#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]');
          const form = composer?.closest('form') ?? document;
          const candidates = [...form.querySelectorAll(
            '[role="group"], .composer-attachment-surface:is(button, [role="button"]), button[aria-label^="Remove file:"] , button[aria-label^="Remove file "]'
          )].filter(visible);
          const candidateName = (element) => {
            const labelled = element.getAttribute('aria-label') || '';
            const removed = /^Remove file(?: \\d+)?: (.+)$/.exec(labelled);
            return element.getAttribute('data-file-name')
              || removed?.[1]
              || labelled
              || (element.getAttribute('role') === 'group' ? (element.textContent || '').trim() : '');
          };
          const attached = expectedNames.every((name) =>
            candidates.some((candidate) => candidateName(candidate) === name)
          );
          const uploading = form.querySelector(
            '[aria-busy="true"], [role="progressbar"], [data-inline-file-uploading]'
          ) !== null;
          const send = form.querySelector('[data-testid="send-button"], button[type="submit"]');
          const sendReady = send instanceof HTMLButtonElement
            ? !send.disabled && send.getAttribute('aria-disabled') !== 'true'
            : false;
          const alerts = [...document.querySelectorAll('[role="alert"]')]
            .filter(visible)
            .map((element) => (element.textContent || '').trim())
            .filter(Boolean);
          return { ready: attached && !uploading && sendReady, error: alerts.join(' | ') };
        })()`,
      );
      if (state.error.length > 0) {
        throw new Error(
          `ChatGPT did not accept the input image: ${state.error}`,
        );
      }
      if (state.ready) return;
      await delay(100, signal);
    }
    throw new Error(
      "ChatGPT accepted the image upload event but did not finish attaching it within 60 seconds.",
    );
  }

  async #submit(
    window: ChatGptWindow,
    afterChallenge?: () => Promise<void>,
  ): Promise<void> {
    const clicked = await this.#execute<boolean>(
      window,
      "submit",
      `(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const composer = document.querySelector('#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]');
        const form = composer?.closest('form');
        const button = form?.querySelector('[data-testid="send-button"], button[type="submit"]')
          || document.querySelector('[data-testid="send-button"], form[data-chatgpt-composer] button[type="submit"]')
          || [...(form?.querySelectorAll('button') || [])].filter(visible).find((element) => /send|傳送|发送/i.test(element.getAttribute('aria-label') || ''));
        if (!(button instanceof HTMLButtonElement) || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
        button.click();
        return true;
      })()`,
      afterChallenge,
    );
    if (clicked) return;
    // Model verification may have moved focus. Restore it before the Enter
    // fallback, which also covers ChatGPT retaining a stale Stop in place of
    // the send button while its composer is otherwise usable.
    await this.#execute<boolean>(
      window,
      "focus-composer-for-submit",
      `(() => {
        const composer = document.querySelector('#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]');
        if (!(composer instanceof HTMLElement)) return false;
        composer.focus();
        return document.activeElement === composer || composer.contains(document.activeElement);
      })()`,
      afterChallenge,
    );
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ENTER" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "ENTER" });
  }

  async #waitForSubmission(
    window: ChatGptWindow,
    baseline: Observation,
    promptHadText: boolean,
    signal: AbortSignal,
  ): Promise<Observation> {
    const deadline = Date.now() + SUBMISSION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal.aborted) {
        throw new DOMException("Provider turn was cancelled.", "AbortError");
      }
      const observation = await this.#observe(window);
      if (observation.error.length > 0) throw new Error(observation.error);
      if (
        isChatGptSubmissionAcknowledged(baseline, observation, promptHadText)
      ) {
        return observation;
      }
      if (
        this.#observedRateLimit &&
        Date.now() - this.#observedRateLimit.observedAt >=
          RATE_LIMIT_RESPONSE_GRACE_MS
      ) {
        throw this.#observedRateLimit.error;
      }
      await delay(100, signal);
    }
    throw new Error(
      "ChatGPT did not acknowledge the submitted prompt within 15 seconds. The send/composer UI contract may have changed.",
    );
  }

  async #observe(window: ChatGptWindow): Promise<Observation> {
    const { renderedText, codeTexts, ...observation } =
      await this.#execute<ChatGptBrowserObservation>(
        window,
        "observe",
        `(${observeChatGpt.toString()})(${chatGptDomToMarkdown.toString()})`,
      );
    const text = chatGptAssistantText(renderedText, codeTexts);
    return {
      ...observation,
      text,
      terminalConfirmed:
        observation.terminalSignal !== null &&
        observation.terminalSignal.messageId ===
          observation.assistantMessageId &&
        sameCompletedBody(text, observation.terminalSignal.text),
    };
  }

  async #stopGenerating(window: ChatGptWindow): Promise<void> {
    await window.webContents
      .executeJavaScript(
        `(() => {
          const button = document.querySelector('[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"]');
          if (button) button.click();
        })()`,
        true,
      )
      .catch(() => undefined);
  }
}

export interface BridgeTaskStatus {
  readonly threadId: string;
  readonly mode: string;
  readonly state: string;
  readonly stage?: string;
  readonly queueAhead?: number;
  readonly failureCode?: OperationFailureCode;
  readonly recovery?: OperationRecovery;
  readonly error?: string;
  readonly titleSyncWarning?: string;
  readonly modelReceipt?: ModelExecutionReceipt;
}

export class ChatGptBrowserController {
  readonly #projects: ChatGptProjectBrowser;
  readonly #journal: OperationJournal;
  readonly #pool = new TurnPool(BRIDGE_WEB_TASK_CONCURRENCY);
  readonly #conversations: ChatGptConversations;
  readonly #sessions = new Map<string, ChatGptBrowserSession>();
  readonly #login: ChatGptBrowserSession;
  #usageAccount: ChatGptUsageAccount | undefined;
  constructor(
    private readonly baseUrl = DEFAULT_CHATGPT_URL,
    conversationFile?: string,
    private readonly recordModel?: (
      receipt: ModelExecutionReceipt,
    ) => Promise<void>,
    private readonly recordCompletion?: (
      record: CompletionDiagnostic,
    ) => Promise<void>,
    private readonly readThreadTitle?: (
      threadId: string,
    ) => Promise<string | undefined>,
    private readonly recordAcceptedUsage?: (input: {
      readonly eventId: string;
      readonly account: ChatGptUsageAccount;
      readonly model: ChatGptUsageModel;
    }) => Promise<void>,
    private readonly createWindow: CreateChatGptWindow = async (options) =>
      new BrowserWindow(options),
  ) {
    this.#projects = new ChatGptProjectBrowser(
      baseUrl,
      CHATGPT_PARTITION,
      conversationFile
        ? `${conversationFile}.projects-pending.json`
        : undefined,
      this.createWindow,
    );
    this.#conversations = new ChatGptConversations(baseUrl, conversationFile);
    this.#journal = new OperationJournal(
      conversationFile ? `${conversationFile}.operations.json` : undefined,
    );
    this.#login = new ChatGptBrowserSession(
      baseUrl,
      this.#conversations,
      this.#pool,
      this.#journal,
      this.recordModel,
      this.recordCompletion,
      undefined,
      undefined,
      true,
      (input) => this.#recordAcceptedUsage(input),
      this.createWindow,
    );
  }

  async #recordAcceptedUsage(input: {
    readonly eventId: string;
    readonly account: ChatGptUsageAccount;
    readonly mode: BridgeWebMode;
    readonly modelLabel?: string | null;
  }): Promise<void> {
    this.#usageAccount = input.account;
    await this.recordAcceptedUsage?.({
      eventId: input.eventId,
      account: input.account,
      model: classifyChatGptUsageModel(input.mode, input.modelLabel),
    });
  }

  usageAccount(): ChatGptUsageAccount | undefined {
    return this.#usageAccount ?? this.#login.usageAccount();
  }

  async refreshUsageAccount(): Promise<ChatGptUsageAccount | undefined> {
    this.#usageAccount = await this.#login.refreshUsageAccount();
    return this.#usageAccount;
  }
  openLoginWindow(show = true): Promise<ChatGptBrowserStatus> {
    return this.#login.openLoginWindow(show);
  }
  async hasConversation(threadId?: string): Promise<boolean> {
    return !!threadId && !!(await this.#conversations.get(threadId));
  }
  status(): Promise<ChatGptBrowserStatus> {
    return this.#login.status();
  }
  probeCapabilities(): Promise<ChatGptAccountCapabilities> {
    return this.#login.probeCapabilities();
  }
  probeNativeModelFamilies(): Promise<readonly BridgeNativeModelFamily[]> {
    return this.#login.probeNativeModelFamilies();
  }
  async smokeTest(): Promise<BrowserSmokeResult> {
    const capabilities = await this.probeCapabilities();
    const mode = selectBrowserSmokeMode(capabilities.availableModes);
    const response = await this.#login.runTurn({
      operationId: `browser-smoke-${randomUUID()}`,
      prompt: BROWSER_SMOKE_PROMPT,
      images: [],
      signal: AbortSignal.timeout(3 * 60_000),
      mode,
      temporaryChat: true,
    });
    return completeBrowserSmoke(mode, response);
  }
  async installPasskeyLoginState(
    state: PasskeyLoginState,
  ): Promise<ChatGptBrowserStatus> {
    if (
      [...this.#sessions.values()].some((session) =>
        ["queued", "generating", "waiting-tools", "waiting-challenge"].includes(
          session.state,
        ),
      )
    ) {
      throw new Error(
        "Wait for current Web tasks to finish before importing a passkey session.",
      );
    }
    for (const session of this.#sessions.values()) await session.close();
    this.#sessions.clear();
    return await this.#login.installPasskeyLoginState(state);
  }
  tasks(): readonly BridgeTaskStatus[] {
    return [...this.#sessions].map(([threadId, session]) => ({
      threadId,
      mode: session.mode,
      state: session.state,
      stage: session.stage,
      queueAhead: session.queueAhead,
      ...(session.failureCode ? { failureCode: session.failureCode } : {}),
      ...(session.failureCode
        ? { recovery: operationRecovery(session.failureCode) }
        : {}),
      ...(session.error ? { error: session.error } : {}),
      ...(session.titleSyncWarning
        ? { titleSyncWarning: session.titleSyncWarning }
        : {}),
      ...(session.modelReceipt ? { modelReceipt: session.modelReceipt } : {}),
    }));
  }
  queueStatus(): ReturnType<TurnPool["status"]> {
    return this.#pool.status();
  }
  async openTask(threadId: string): Promise<void> {
    const session = this.#sessions.get(threadId);
    if (!session) throw new Error("Unknown Web task.");
    session.keepPageAlive();
    try {
      await session.openTask();
    } finally {
      session.scheduleIdlePageExpiry();
    }
  }
  cancelTask(threadId: string): void {
    this.#sessions.get(threadId)?.cancel();
  }
  async runTurn(
    input: RunWebTurnInput,
  ): Promise<string | BridgeGeneratedImagesResult> {
    const key = input.threadId ?? randomUUID();
    let session = this.#sessions.get(key);
    if (!session) {
      session = new ChatGptBrowserSession(
        this.baseUrl,
        this.#conversations,
        this.#pool,
        this.#journal,
        this.recordModel,
        this.recordCompletion,
        (name, signal) => this.#projects.resolve(name, signal),
        this.readThreadTitle,
        false,
        (input) => this.#recordAcceptedUsage(input),
        this.createWindow,
      );
      this.#sessions.set(key, session);
    }
    session.keepPageAlive();
    try {
      return await session.runTurn(input);
    } finally {
      if (!input.threadId) {
        await session.close();
        this.#sessions.delete(key);
      } else if (
        ["completed", "waiting-tools", "failed", "cancelled"].includes(
          session.state,
        )
      ) {
        session.scheduleIdlePageExpiry();
      }
    }
  }
  async close(): Promise<void> {
    this.#projects.close();
    for (const session of this.#sessions.values()) {
      session.cancel();
      await session.close();
    }
    this.#sessions.clear();
    await this.#login.close();
  }
}
