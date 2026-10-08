import { useEffect, useState } from "react";
import type {
  DesktopDoctorReport,
  DesktopSettings,
  ReleaseUpdateStatus,
  WebProviderStatus,
} from "../main/preload.cjs";
import {
  CATALOGS,
  translator,
  type MessageKey,
  type Translator,
} from "./i18n.js";

const EMPTY_SETTINGS: DesktopSettings = {
  locale: "en",
  chatGptProjects: { enabled: false },
  temporaryChat: false,
  interactionMode: "automatic",
  webToolMode: "full",
  fullMcpConnectorName: "CodexGPT Bridge",
};

function webTaskStage(stage: string, t: Translator): string {
  if (/^queued_/.test(stage)) return t("stageQueued");
  const cooldown = /^cooldown_(\d+)$/.exec(stage);
  if (cooldown) return t("stageCooldown", { seconds: cooldown[1] ?? "" });
  const labels: Record<string, string> = {
    idle: t("stageIdle"),
    queued: t("stageQueued"),
    preparing: t("stagePreparing"),
    selecting: t("stageSelecting"),
    submitting: t("stageSubmitting"),
    generating: t("stageGenerating"),
    receiving: t("stageReceiving"),
    validating: t("stageValidating"),
    transferring: t("stageTransferring"),
    repairing: t("stageRepairing"),
    reusing: t("stageReusing"),
    rebuilding: t("stageRebuilding"),
    reconnecting: t("stageReconnecting"),
    waiting_challenge: t("stageWaitingChallenge"),
    resuming_challenge: t("stageResumingChallenge"),
    waiting_media: t("stageWaitingMedia"),
    waiting_web_tool: t("stageWaitingWebTool"),
    completed: t("stageCompleted"),
    "waiting-tools": t("stageWaitingTools"),
    "waiting-challenge": t("stageWaitingChallenge"),
    cancelled: t("stageCancelled"),
    failed: t("stageFailed"),
  };
  return labels[stage] ?? stage;
}

function webModeLabel(modelId: string): string {
  const mode = modelId.slice(modelId.lastIndexOf("/") + 1);
  return mode
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const EMPTY_PROVIDER: WebProviderStatus = {
  running: false,
  installed: false,
  modelId: "codexgpt-bridge/instant",
  modelIds: [
    "codexgpt-bridge/instant",
    "codexgpt-bridge/medium",
    "codexgpt-bridge/high",
    "codexgpt-bridge/extra-high",
    "codexgpt-bridge/pro",
    "codexgpt-bridge/luna",
    "codexgpt-bridge/think",
  ],
  configPath: "",
  browserWindowOpen: false,
  browserSignedIn: false,
  toolMode: "full",
};

export function App() {
  const [settings, setSettings] = useState<DesktopSettings>(EMPTY_SETTINGS);
  const [webProvider, setWebProvider] =
    useState<WebProviderStatus>(EMPTY_PROVIDER);
  const [update, setUpdate] = useState<ReleaseUpdateStatus>({
    phase: "unconfigured",
    currentVersion: "",
  });
  const [doctor, setDoctor] = useState<DesktopDoctorReport | null>(null);
  const t = translator(settings.locale);
  const [message, setMessage] = useState(t("loading"));
  const [busy, setBusy] = useState(false);
  const availableWebModeLabels = webProvider.modelIds.map(webModeLabel);

  useEffect(() => {
    if (update.currentVersion) {
      document.title = `CodexGPT Bridge${webProvider.developmentProfile ? " DEV" : ""} v${update.currentVersion}`;
    }
  }, [update.currentVersion, webProvider.developmentProfile]);

  useEffect(
    () =>
      window.codexgptBridge.onUpdateFocus(() => {
        document
          .getElementById("bridge-updates")
          ?.scrollIntoView({ behavior: "smooth" });
      }),
    [],
  );

  useEffect(() => {
    void Promise.all([
      window.codexgptBridge.getSettings(),
      window.codexgptBridge.getWebProviderStatus(),
      window.codexgptBridge.getUpdateStatus(),
    ])
      .then(([nextSettings, nextWebProvider, nextUpdate]) => {
        setSettings(nextSettings);
        document.documentElement.lang = nextSettings.locale;
        setWebProvider(nextWebProvider);
        setUpdate(nextUpdate);
        const nextTranslator = translator(nextSettings.locale);
        setMessage(
          nextWebProvider.error ??
            (nextWebProvider.installed
              ? nextTranslator("readySelectModel")
              : nextTranslator("setupModels")),
        );
      })
      .catch((error: unknown) =>
        setMessage(
          error instanceof Error ? error.message : t("operationFailed"),
        ),
      );
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const [nextProvider, nextUpdate] = await Promise.all([
          window.codexgptBridge.getWebProviderStatus(),
          window.codexgptBridge.getUpdateStatus(),
        ]);
        if (!cancelled) {
          setWebProvider(nextProvider);
          setUpdate(nextUpdate);
        }
      } catch {
        // Keep the last provider status while a refresh is unavailable.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("operationFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">{t("heroEyebrow")}</p>
          <div className="appTitle">
            <h1>CodexGPT Bridge</h1>
            {update.currentVersion && (
              <span className="appVersion" title={t("updateCurrent")}>
                v{update.currentVersion}
              </span>
            )}
          </div>
          <p className="subtitle">{t("heroSubtitle")}</p>
        </div>
        <label className="languagePicker">
          <span>{t("language")}</span>
          <select
            value={settings.locale}
            disabled={busy}
            onChange={(event) =>
              void run(async () => {
                const locale = event.target.value as DesktopSettings["locale"];
                const nextSettings =
                  await window.codexgptBridge.setLocale(locale);
                const currentCatalog = CATALOGS[settings.locale];
                const nextTranslator = translator(nextSettings.locale);
                setMessage((current) => {
                  const key = (
                    Object.keys(currentCatalog) as MessageKey[]
                  ).find((key) => currentCatalog[key] === current);
                  return key ? nextTranslator(key) : current;
                });
                setSettings(nextSettings);
                document.documentElement.lang = nextSettings.locale;
              })
            }
          >
            <option value="en">{t("english")}</option>
            <option value="zh-TW">{t("traditionalChinese")}</option>
            <option value="zh-CN">{t("simplifiedChinese")}</option>
            <option value="ja">{t("japanese")}</option>
            <option value="ko">{t("korean")}</option>
          </select>
        </label>
        <span
          className={`status ${webProvider.running ? "online" : "offline"}`}
        >
          {webProvider.running ? t("providerOnline") : t("providerOffline")}
        </span>
      </header>

      {["available", "ready"].includes(update.phase) &&
        update.availableVersion && (
          <section className="card updateNotice" role="status">
            <span>
              {t("updateNotice", { version: update.availableVersion })}
            </span>
            <button
              className="secondary"
              onClick={() =>
                document
                  .getElementById("bridge-updates")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            >
              {t("viewUpdate")}
            </button>
          </section>
        )}

      <section className="card providerCard">
        <div className="sectionHeading">
          <div>
            <p className="eyebrow">{t("providerHeading")}</p>
            <h2>
              {t("providerModes", { count: availableWebModeLabels.length })}
            </h2>
          </div>
          <div className="metrics">
            <span>
              {webProvider.running
                ? t("providerOnlineShort")
                : t("providerOfflineShort")}
            </span>
            <span>
              {webProvider.repairable
                ? t("repairNeeded")
                : webProvider.installed
                  ? t("installedInCodex")
                  : t("notInstalled")}
            </span>
            <span>
              {webProvider.browserSignedIn
                ? t("signedIn")
                : t("loginUnchecked")}
            </span>
          </div>
        </div>
        <p>{availableWebModeLabels.join(" · ")}</p>
        {webProvider.error !== undefined && (
          <p className="providerError">{webProvider.error}</p>
        )}
        {webProvider.passkeyLogin?.error !== undefined && (
          <p className="providerError">{webProvider.passkeyLogin.error}</p>
        )}
        {webProvider.chromeLogin?.error !== undefined && (
          <p className="providerError">{webProvider.chromeLogin.error}</p>
        )}
        <div className="modelPreference">
          <label htmlFor="chatgpt-browser-host">{t("browserHost")}</label>
          <select
            id="chatgpt-browser-host"
            value={settings.chatGptBrowserHost ?? "embedded"}
            disabled={
              busy ||
              ["waiting", "ready", "verifying"].includes(
                webProvider.chromeLogin?.phase ?? "idle",
              )
            }
            onChange={(event) => {
              const host =
                event.currentTarget.value === "chrome" ? "chrome" : "embedded";
              void run(async () => {
                setSettings(
                  await window.codexgptBridge.setChatGptBrowserHost(host),
                );
                setWebProvider(await window.codexgptBridge.openChatGptLogin());
                setMessage(t("browserHostChanged"));
              });
            }}
          >
            <option value="embedded">{t("browserEmbedded")}</option>
            <option value="chrome">{t("browserChrome")}</option>
          </select>
          <p className="projectHelp">{t("browserHostHelp")}</p>
        </div>
        {settings.chatGptBrowserHost === "chrome" &&
          webProvider.chromeLogin?.phase !== "idle" && (
            <p role="status" data-testid="chrome-login-instructions">
              {webProvider.chromeLogin?.phase === "challenge"
                ? t("chromeVerificationInstructions")
                : webProvider.chromeLogin?.phase === "verifying"
                  ? t("chromeLoginVerifying")
                  : webProvider.chromeLogin?.phase === "ready"
                    ? t("chromeLoginReady")
                    : t("chromeLoginInstructions")}
            </p>
          )}
        {settings.chatGptBrowserHost === "chrome" &&
          !webProvider.chromeLogin?.verified && (
            <p className="projectHelp">{t("chromeLoginBeforeTest")}</p>
          )}
        <div className="actions">
          <button
            className="secondary"
            disabled={
              busy ||
              ["waiting", "ready", "verifying"].includes(
                webProvider.chromeLogin?.phase ?? "idle",
              )
            }
            onClick={() =>
              void run(async () => {
                setWebProvider(await window.codexgptBridge.openChatGptLogin());
                setMessage(
                  t(
                    settings.chatGptBrowserHost === "chrome"
                      ? "chromeLoginInstructions"
                      : "loginWindowOpened",
                  ),
                );
              })
            }
          >
            {t(
              webProvider.chromeLogin?.phase === "challenge"
                ? "chromeVerificationOpen"
                : "openLogin",
            )}
          </button>
          {settings.chatGptBrowserHost === "chrome" &&
            ["waiting", "ready", "verifying", "challenge"].includes(
              webProvider.chromeLogin?.phase ?? "idle",
            ) && (
              <button
                data-testid="chrome-login-continue"
                disabled={
                  busy ||
                  !["ready", "challenge"].includes(
                    webProvider.chromeLogin?.phase ?? "idle",
                  )
                }
                onClick={() =>
                  void run(async () => {
                    setMessage(t("chromeLoginVerifying"));
                    const next =
                      await window.codexgptBridge.continueChromeLogin();
                    setWebProvider(next);
                    setMessage(
                      t(
                        next.chromeLogin?.verified
                          ? "chromeLoginVerified"
                          : "chromeVerificationInstructions",
                      ),
                    );
                  })
                }
              >
                {t(
                  webProvider.chromeLogin?.phase === "challenge"
                    ? "chromeVerificationContinue"
                    : "chromeLoginContinue",
                )}
              </button>
            )}
          {webProvider.passkeyLogin?.available === true &&
            settings.interactionMode !== "manual" &&
            settings.chatGptBrowserHost !== "chrome" &&
            !webProvider.browserSignedIn && (
              <button
                className="secondary"
                disabled={
                  busy || webProvider.passkeyLogin.phase === "importing"
                }
                onClick={() =>
                  void run(async () => {
                    if (webProvider.passkeyLogin?.phase === "waiting") {
                      setMessage(t("passkeyImporting"));
                      setWebProvider(
                        await window.codexgptBridge.continuePasskeyLogin(),
                      );
                      setMessage(t("passkeyVerified"));
                    } else {
                      setWebProvider(
                        await window.codexgptBridge.beginPasskeyLogin(),
                      );
                      setMessage(t("passkeyInstructions"));
                    }
                  })
                }
              >
                {webProvider.passkeyLogin.phase === "waiting"
                  ? t("passkeyContinue")
                  : webProvider.passkeyLogin.phase === "importing"
                    ? t("passkeyWorking")
                    : t("passkeyUse")}
              </button>
            )}
          <button
            className="secondary"
            data-testid="browser-smoke"
            disabled={
              busy ||
              webProvider.browserSmoke?.status === "running" ||
              settings.interactionMode === "manual" ||
              (settings.chatGptBrowserHost === "chrome" &&
                !webProvider.chromeLogin?.verified)
            }
            onClick={() =>
              void run(async () => {
                setMessage(t("browserSmokeTesting"));
                const next = await window.codexgptBridge.runBrowserSmoke();
                setWebProvider(next);
                setMessage(
                  next.browserSmoke?.status !== "passed"
                    ? t("chromeVerificationInstructions")
                    : t("browserSmokePassed", {
                        mode: next.browserSmoke?.mode ?? t("selectedMode"),
                      }),
                );
              })
            }
          >
            {webProvider.browserSmoke?.status === "running"
              ? t("testing")
              : webProvider.browserSmoke?.status === "passed"
                ? t("testAgain")
                : t("testConnection")}
          </button>
          <button
            disabled={busy || webProvider.webOnly?.managed === true}
            onClick={() =>
              void run(async () => {
                setMessage(
                  webProvider.repairable
                    ? t("repairingCodex")
                    : webProvider.installed
                      ? t("removingModels")
                      : t("detectingModels"),
                );
                const repairing = webProvider.repairable === true;
                const next = repairing
                  ? await window.codexgptBridge.repairWebProvider()
                  : webProvider.installed
                    ? await window.codexgptBridge.removeWebProvider()
                    : await window.codexgptBridge.installWebProvider();
                setWebProvider(next);
                setMessage(
                  repairing && next.installed
                    ? t("connectionRepaired")
                    : next.installed
                      ? t("modelsInstalled", { count: next.modelIds.length })
                      : t("modelsRemoved"),
                );
              })
            }
          >
            {busy
              ? t("working")
              : webProvider.repairable
                ? t("repairConnection")
                : webProvider.installed
                  ? t("removeModels")
                  : t("installModels")}
          </button>
        </div>
        {webProvider.browserSmoke?.status === "passed" && (
          <section
            className="browserSmokeResult"
            aria-label={t("browserSmokeAria")}
          >
            <strong>
              {t("browserSmokePassedHeading", {
                mode: webProvider.browserSmoke.mode ?? t("selectedMode"),
              })}
            </strong>
            <ul>
              {webProvider.browserSmoke.checks?.map((check) => (
                <li key={check.id}>✓ {check.label}</li>
              ))}
            </ul>
          </section>
        )}
        {webProvider.browserSmoke?.status === "failed" && (
          <p className="providerError">
            {t("browserSmokeFailed", {
              error: webProvider.browserSmoke.error ?? t("operationFailed"),
            })}
          </p>
        )}
        <p role="status" aria-live="polite">
          {message}
        </p>
        <section
          className="projectSettings"
          aria-labelledby="temporary-chat-heading"
        >
          <h3 id="temporary-chat-heading">{t("temporaryChatHeading")}</h3>
          <label className="projectToggle">
            <input
              type="checkbox"
              checked={settings.temporaryChat}
              disabled={busy}
              onChange={(event) => {
                const enabled = event.target.checked;
                void run(async () => {
                  setSettings(
                    await window.codexgptBridge.setTemporaryChat(enabled),
                  );
                  setMessage(
                    enabled
                      ? t("temporaryChatEnabled")
                      : t("temporaryChatDisabled"),
                  );
                });
              }}
            />
            {t("temporaryChatToggle")}
          </label>
          <p className="projectHelp">{t("temporaryChatHelp")}</p>
        </section>
        <section className="projectSettings" aria-labelledby="advanced-heading">
          <h3 id="advanced-heading">{t("advancedHeading")}</h3>
          <label className="projectToggle">
            <span>{t("interactionMode")}</span>
            <select
              aria-label={t("interactionMode")}
              aria-describedby="interaction-help"
              value={settings.interactionMode ?? "automatic"}
              disabled={busy || settings.webToolMode !== "full"}
              onChange={(event) => {
                const interactionMode = event.target.value as
                  "automatic" | "manual";
                void run(async () => {
                  setSettings(
                    await window.codexgptBridge.setAdvancedSettings({
                      interactionMode,
                    }),
                  );
                  setWebProvider(
                    await window.codexgptBridge.getWebProviderStatus(),
                  );
                });
              }}
            >
              <option value="automatic">{t("automaticInteraction")}</option>
              <option value="manual">{t("manualInteraction")}</option>
            </select>
          </label>
          <p className="projectHelp" id="interaction-help">
            {t(
              settings.webToolMode !== "full"
                ? "manualRequiresFullMcp"
                : settings.interactionMode === "manual"
                  ? "manualHelp"
                  : "automaticHelp",
            )}
          </p>
          {(
            [
              ["freshConversationPerTurn", "freshConversation"],
              ["autoApproveToolCalls", "autoApproveOnce"],
              ["startAtLogin", "startAtLogin"],
              ["manualPro", "manualPro"],
            ] as const
          ).map(([key, label]) => (
            <label className="projectToggle" key={key}>
              <input
                type="checkbox"
                checked={settings[key] === true}
                disabled={
                  busy ||
                  (key === "manualPro" &&
                    settings.interactionMode !== "manual") ||
                  ((key === "autoApproveToolCalls" ||
                    key === "freshConversationPerTurn") &&
                    settings.interactionMode === "manual")
                }
                onChange={(event) => {
                  const enabled = event.target.checked;
                  void run(async () =>
                    setSettings(
                      await window.codexgptBridge.setAdvancedSettings({
                        [key]: enabled,
                      }),
                    ),
                  );
                }}
              />
              {t(label)}
            </label>
          ))}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const silenceTimeoutSeconds = Number(
                new FormData(event.currentTarget).get("silenceTimeoutSeconds"),
              );
              void run(async () =>
                setSettings(
                  await window.codexgptBridge.setAdvancedSettings({
                    silenceTimeoutSeconds,
                  }),
                ),
              );
            }}
          >
            <label>
              {t("silenceTimeout")}{" "}
              <input
                type="number"
                name="silenceTimeoutSeconds"
                disabled={settings.interactionMode === "manual"}
                min="0"
                max="14400"
                step="1"
                key={settings.silenceTimeoutSeconds ?? 0}
                defaultValue={settings.silenceTimeoutSeconds ?? 0}
              />
            </label>
            <button
              type="submit"
              className="secondary"
              disabled={busy || settings.interactionMode === "manual"}
            >
              {t("saveAdvanced")}
            </button>
          </form>
        </section>
        {(webProvider.manualTasks ?? []).map((task) => (
          <section className="projectSettings" key={task.id}>
            <h3>
              {t("manualTask")}: {task.threadId} · {task.modelFamily}{" "}
              {task.mode}
            </h3>
            {task.total > 1 && (
              <p>
                {task.part}/{task.total}
              </p>
            )}
            <p>{task.retained ? t("manualReuse") : t("manualFresh")}</p>
            <div className="actions">
              <button
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    window.codexgptBridge.copyManualPrompt(task.id),
                  )
                }
              >
                {t("copyManualPrompt")}
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void run(() => window.codexgptBridge.openManualChat())
                }
              >
                {t("openManualChat")}
              </button>
              <button
                disabled={busy || task.sent}
                onClick={() =>
                  void run(async () => {
                    await window.codexgptBridge.manualSent(task.id);
                    setWebProvider(
                      await window.codexgptBridge.getWebProviderStatus(),
                    );
                  })
                }
              >
                {task.sent ? t("manualSentConfirmed") : t("manualSent")}
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void run(() => window.codexgptBridge.cancelManual(task.id))
                }
              >
                {t("manualCancel")}
              </button>
            </div>
            {task.images.length > 0 && <p>{t("manualAttachments")}</p>}
            {task.acknowledgement && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const acknowledgement = String(
                    new FormData(event.currentTarget).get("acknowledgement") ??
                      "",
                  );
                  void run(async () => {
                    await window.codexgptBridge.manualAcknowledge(
                      task.id,
                      acknowledgement,
                    );
                    setWebProvider(
                      await window.codexgptBridge.getWebProviderStatus(),
                    );
                  });
                }}
              >
                <label>
                  {t("manualStageAck")}{" "}
                  <input
                    name="acknowledgement"
                    key={task.part}
                    required
                    autoComplete="off"
                  />
                </label>
                <button type="submit" disabled={busy || !task.sent}>
                  {t("manualAckNext")}
                </button>
              </form>
            )}
            {task.sent && !task.acknowledgement && (
              <form
                className="manualAnswerForm"
                onSubmit={(event) => {
                  event.preventDefault();
                  const text = String(
                    new FormData(event.currentTarget).get("finalAnswer") ?? "",
                  );
                  void run(async () => {
                    await window.codexgptBridge.completeManual(task.id, text);
                    setWebProvider(
                      await window.codexgptBridge.getWebProviderStatus(),
                    );
                  });
                }}
              >
                <p className="projectHelp">{t("manualAnswerHelp")}</p>
                <label>
                  {t("manualAnswerLabel")}
                  <textarea
                    name="finalAnswer"
                    required
                    rows={3}
                    maxLength={2000000}
                  />
                </label>
                <button type="submit" disabled={busy}>
                  {t("manualAnswerSubmit")}
                </button>
              </form>
            )}
            {task.images.map((image) => (
              <a
                key={image.imageUrl}
                href={image.imageUrl}
                download={`${image.ref}.png`}
              >
                {image.ref}
              </a>
            ))}
            <details>
              <summary>{t("manualPromptPreview")}</summary>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  maxHeight: "24rem",
                  overflow: "auto",
                }}
              >
                {task.prompt}
              </pre>
            </details>
          </section>
        ))}
        <section
          className="projectSettings"
          aria-labelledby="chatgpt-projects-heading"
        >
          <h3 id="chatgpt-projects-heading">{t("projectsHeading")}</h3>
          <label className="projectToggle">
            <input
              type="checkbox"
              checked={settings.chatGptProjects.enabled}
              disabled={busy}
              onChange={(event) => {
                const enabled = event.target.checked;
                void run(async () => {
                  setSettings(
                    await window.codexgptBridge.setChatGptProjectsEnabled(
                      enabled,
                    ),
                  );
                  setMessage(
                    enabled ? t("projectsEnabled") : t("projectsDisabled"),
                  );
                });
              }}
            />
            {t("projectsToggle")}
          </label>
          <p className="projectHelp">{t("projectsHelpA")}</p>
          <p className="projectHelp">{t("projectsHelpB")}</p>
        </section>
        <form
          className="modelPreference"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void run(async () => {
              const next = await window.codexgptBridge.setFullMcp({
                mode: String(data.get("toolMode")) as "simple" | "full",
                connectorName: String(data.get("connectorName") ?? ""),
                tunnelId: String(data.get("tunnelId") ?? ""),
                runtimeApiKey: String(data.get("runtimeApiKey") ?? ""),
                tunnelClientPath: String(data.get("tunnelClientPath") ?? ""),
              });
              setSettings(next);
              setWebProvider(
                await window.codexgptBridge.getWebProviderStatus(),
              );
              setMessage(
                next.webToolMode === "full"
                  ? t("fullMcpConnectedMessage")
                  : t("simpleModeMessage"),
              );
            });
          }}
        >
          <div className="transportHeading">
            <div>
              <strong>{t("toolConnection")}</strong>
              <p>
                {settings.webToolMode === "full"
                  ? webProvider.fullMcp?.ready
                    ? t("fullMcpConnected")
                    : t("fullMcpNotConnected")
                  : t("simpleMode")}
              </p>
            </div>
          </div>
          <label htmlFor="web-tool-mode">{t("toolTransportMode")}</label>
          <select
            id="web-tool-mode"
            aria-describedby="tool-transport-help"
            name="toolMode"
            key={`mode-${settings.webToolMode}`}
            defaultValue={settings.webToolMode}
          >
            <option value="simple">{t("simpleModeOption")}</option>
            <option value="full">{t("fullMcpOption")}</option>
          </select>
          <p className="projectHelp" id="tool-transport-help">
            {t("toolTransportHelp")}
          </p>
          <details className="advancedSettings">
            <summary>{t("advancedTunnel")}</summary>
            <div className="advancedSettingsFields">
              <label htmlFor="full-mcp-connector">{t("connectorName")}</label>
              <input
                id="full-mcp-connector"
                name="connectorName"
                key={`connector-${settings.fullMcpConnectorName}`}
                defaultValue={settings.fullMcpConnectorName}
                maxLength={120}
              />
              <label htmlFor="full-mcp-tunnel">{t("tunnelId")}</label>
              <input
                id="full-mcp-tunnel"
                name="tunnelId"
                key={`tunnel-${settings.fullMcpTunnelId ?? ""}`}
                defaultValue={settings.fullMcpTunnelId ?? ""}
                placeholder="tunnel_…"
              />
              <label htmlFor="full-mcp-key">{t("apiKey")}</label>
              <input
                id="full-mcp-key"
                name="runtimeApiKey"
                type="password"
                autoComplete="off"
                placeholder={
                  settings.fullMcpRuntimeKeyFile
                    ? t("savedApiKey")
                    : t("pasteApiKey")
                }
              />
              <label htmlFor="full-mcp-client">{t("tunnelClientPath")}</label>
              <input
                id="full-mcp-client"
                name="tunnelClientPath"
                key={`client-${settings.fullMcpTunnelClientPath ?? ""}`}
                defaultValue={settings.fullMcpTunnelClientPath ?? ""}
                placeholder={t("autoDetected")}
              />
            </div>
          </details>
          <button className="secondary" disabled={busy} type="submit">
            {t("apply")}
          </button>
          {webProvider.fullMcp && (
            <p
              className={
                webProvider.fullMcp.ready ? undefined : "providerError"
              }
            >
              {webProvider.fullMcp.ready
                ? t("tunnelReady")
                : t("tunnelNotReady")}
            </p>
          )}
        </form>
        <p>
          {webProvider.toolMode === "full"
            ? t("fullMcpRequirement")
            : t("simpleProtocolHelp")}
        </p>
        {webProvider.installed && (
          <details className="modelEvidence">
            <summary>{t("connectionDetails")}</summary>
            {webProvider.modelIds.map((modelId) => (
              <code className="endpoint" key={modelId}>
                {modelId}
              </code>
            ))}
            {webProvider.baseUrl !== undefined && (
              <code className="endpoint">{webProvider.baseUrl}</code>
            )}
          </details>
        )}
        {webProvider.installed && webProvider.queue && (
          <div className="metrics taskMetrics" aria-label={t("webTaskQueue")}>
            <span>
              {t("active")} {webProvider.queue.active}/
              {webProvider.queue.capacity}
            </span>
            <span>
              {t("queued")} {webProvider.queue.queued}
            </span>
            <span>
              {t("cooldown")}{" "}
              {webProvider.queue.cooldownSeconds > 0
                ? `${webProvider.queue.cooldownSeconds}s`
                : t("ready")}
            </span>
          </div>
        )}
        {((webProvider.installed &&
          (webProvider.usage || webProvider.officialUsage)) ||
          webProvider.webOnly?.managed) && (
          <details className="modelEvidence">
            <summary>{t("diagnosticInfo")}</summary>
            {webProvider.webOnly?.managed && (
              <div className="actions">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setMessage(t("restoringProvider"));
                      setWebProvider(
                        await window.codexgptBridge.setWebOnlyMode(false),
                      );
                      setMessage(t("providerRestored"));
                    })
                  }
                >
                  {t("restoreLegacyProvider")}
                </button>
              </div>
            )}
            {webProvider.usage && (
              <>
                <p>
                  <strong>{t("localUsage")}</strong>
                </p>
                <p>
                  {t("localUsageSummary", {
                    retained: webProvider.usage.retainedOperations,
                    limit: webProvider.usage.retentionLimit,
                    completed: webProvider.usage.completedOperations,
                    failed: webProvider.usage.failedOperations,
                    pending: webProvider.usage.pendingOperations,
                  })}
                </p>
                <p>
                  {t("localUsageEstimate", {
                    browser:
                      webProvider.usage.estimatedBrowserInputTokens.toLocaleString(),
                    source:
                      webProvider.usage.estimatedSourceContextTokens.toLocaleString(),
                  })}
                </p>
                <p>
                  {Object.entries(webProvider.usage.byMode)
                    .map(
                      ([mode, usage]) =>
                        mode + ": " + usage.completed + "/" + usage.operations,
                    )
                    .join(" · ") || t("noRecordedOperations")}
                </p>
                <p>{t("localReceiptsHelp")}</p>
              </>
            )}
            {webProvider.officialUsage && (
              <>
                <p>
                  <strong>{t("accountUsage")}</strong>
                </p>
                <div className="actions">
                  <button
                    className="secondary"
                    disabled={busy || settings.interactionMode === "manual"}
                    onClick={() =>
                      void run(async () => {
                        setWebProvider(
                          await window.codexgptBridge.refreshChatGptUsage(),
                        );
                      })
                    }
                  >
                    {t("refreshAccount")}
                  </button>
                </div>
                <p>
                  {webProvider.officialUsage.accountObserved
                    ? `${webProvider.officialUsage.plan ?? t("unsupported")} · ${webProvider.officialUsage.accountKeyHint ?? ""}`
                    : t("accountNotObserved")}
                </p>
                <div className="metrics taskMetrics">
                  <span>
                    {t("accepted24h")}:{" "}
                    {webProvider.officialUsage.accepted.last24Hours}
                  </span>
                  <span>
                    {t("accepted7d")}:{" "}
                    {webProvider.officialUsage.accepted.last7Days}
                  </span>
                  <span>
                    {t("accepted30d")}:{" "}
                    {webProvider.officialUsage.accepted.last30Days}
                  </span>
                </div>
                <p>{t("usageDisclaimer")}</p>
              </>
            )}
          </details>
        )}
        {(webProvider.tasks ?? []).map((task) => (
          <div className="approvalRow" key={task.threadId}>
            <div>
              <strong>{task.threadId}</strong>
              <span>
                {task.mode} · {webTaskStage(task.stage ?? task.state, t)}
                {(task.queueAhead ?? 0) > 0 &&
                  ` · ${t("queueAhead", { count: task.queueAhead ?? 0 })}`}
              </span>
              {task.error && (
                <p className="providerError">
                  {task.failureCode && `[${task.failureCode}] `}
                  {task.error}
                </p>
              )}
              {task.titleSyncWarning && (
                <p className="providerError">{task.titleSyncWarning}</p>
              )}
              {task.recovery && (
                <div className="recoveryHint">
                  <strong>{task.recovery.title}</strong>
                  <p>{task.recovery.instruction}</p>
                  <span>
                    {task.recovery.automatic
                      ? t("recoveryAutomatic")
                      : t("recoveryManual")}
                  </span>
                </div>
              )}
              {task.modelReceipt && (
                <details className="modelEvidence">
                  <summary>
                    {task.modelReceipt.confidence} · {task.modelReceipt.phase}
                  </summary>
                  <p>
                    {t("requested")}:{" "}
                    {task.modelReceipt.requestedModel ?? t("currentWebModel")} /{" "}
                    {task.modelReceipt.requestedMode}
                  </p>
                  <p>
                    {t("route")}: {task.modelReceipt.requestedRoute}
                  </p>
                  <p>
                    {t("observed")}:{" "}
                    {task.modelReceipt.observed.model ?? t("modelNotExposed")} /{" "}
                    {task.modelReceipt.observed.modeLabel ??
                      t("effortNotExposed")}
                  </p>
                  {task.modelReceipt.execution && (
                    <>
                      <p>
                        {t("send")}: {task.modelReceipt.execution.attempt} ·{" "}
                        {t("transport")}{" "}
                        {task.modelReceipt.execution.toolTransport} ·{" "}
                        {t("operation")}{" "}
                        {task.modelReceipt.execution.operationToolTransport} ·{" "}
                        {task.modelReceipt.execution.toolCount}{" "}
                        {t("codexTools")}
                      </p>
                      <p>
                        {t("browserInput")} (
                        {task.modelReceipt.execution.inputBasis}
                        ):{" "}
                        {task.modelReceipt.execution.inputTokens.toLocaleString()}{" "}
                        /{" "}
                        {task.modelReceipt.execution.hardInputTokenLimit.toLocaleString()}{" "}
                        {t("tokens")} ·{" "}
                        {task.modelReceipt.execution.remainingInputTokens.toLocaleString()}{" "}
                        {t("remaining")}
                      </p>
                      {task.modelReceipt.execution.sourceContextTokens !==
                        task.modelReceipt.execution.inputTokens && (
                        <p>
                          {t("sourceContextSummary", {
                            count:
                              task.modelReceipt.execution.sourceContextTokens.toLocaleString(),
                          })}
                        </p>
                      )}
                      <p>
                        {t("countedSummary", {
                          text: task.modelReceipt.execution.textTokens.toLocaleString(),
                          images:
                            task.modelReceipt.execution.imageReserveTokens.toLocaleString(),
                          reserve:
                            task.modelReceipt.execution.platformReserveTokens.toLocaleString(),
                          status: task.modelReceipt.execution.status,
                          profile: task.modelReceipt.execution.budgetProfile,
                        })}
                      </p>
                      <p>
                        {t("payloadSummary", {
                          characters:
                            task.modelReceipt.execution.textCharacters.toLocaleString(),
                          images: task.modelReceipt.execution.imageCount,
                        })}
                      </p>
                    </>
                  )}
                  <p>
                    {t("checkedSummary", {
                      time: task.modelReceipt.checkedAt,
                    })}
                  </p>
                </details>
              )}
            </div>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (task.recovery?.action === "open-login") {
                    setWebProvider(
                      await window.codexgptBridge.openChatGptLogin(),
                    );
                    setMessage(t("loginWindowOpened"));
                    return;
                  }
                  await window.codexgptBridge.openWebTask(task.threadId);
                })
              }
            >
              {task.recovery?.action === "open-login"
                ? t("openSignIn")
                : task.state === "waiting-challenge"
                  ? t("openVerification")
                  : t("openChat")}
            </button>
            <button
              disabled={
                ![
                  "queued",
                  "generating",
                  "waiting-tools",
                  "waiting-challenge",
                ].includes(task.state)
              }
              onClick={() =>
                void run(() =>
                  window.codexgptBridge.cancelWebTask(task.threadId),
                )
              }
            >
              {t("cancel")}
            </button>
          </div>
        ))}
      </section>

      <section className="card maintenanceCard" id="bridge-updates">
        <div className="sectionHeading">
          <div>
            <p className="eyebrow">{t("maintenance")}</p>
            <h2>{t("updatesDoctor")}</h2>
          </div>
          <div className="metrics">
            <span>
              {t("updateCurrent")}: {update.currentVersion || "—"}
            </span>
            {update.availableVersion && (
              <span>
                {t("updateAvailable")}: {update.availableVersion}
              </span>
            )}
            <span>{update.phase}</span>
          </div>
        </div>
        {update.phase === "unconfigured" && <p>{t("updateUnconfigured")}</p>}
        {update.phase !== "unconfigured" && <p>{t("autoUpdateReminder")}</p>}
        {update.manifestPath && <p>{t("localUpdateSource")}</p>}
        {update.phase === "ready" && <p>{t("updateReady")}</p>}
        {update.error && <p className="providerError">{update.error}</p>}
        <div className="actions">
          <button
            className="secondary"
            disabled={
              busy ||
              update.phase === "unconfigured" ||
              update.phase === "checking" ||
              update.phase === "downloading" ||
              update.phase === "installing"
            }
            onClick={() =>
              void run(async () =>
                setUpdate(await window.codexgptBridge.checkForUpdate()),
              )
            }
          >
            {t("checkUpdate")}
          </button>
          <button
            className="secondary"
            disabled={busy || update.phase !== "available"}
            onClick={() =>
              void run(async () =>
                setUpdate(await window.codexgptBridge.downloadUpdate()),
              )
            }
          >
            {t("downloadUpdate")}
          </button>
          <button
            disabled={busy || update.phase !== "ready"}
            onClick={() =>
              void run(async () => {
                setMessage(t("installUpdate"));
                setUpdate(await window.codexgptBridge.installUpdate());
              })
            }
          >
            {t("installUpdate")}
          </button>
        </div>
        <div className="actions">
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () =>
                setDoctor(await window.codexgptBridge.runDoctor()),
              )
            }
          >
            {t("runDoctor")}
          </button>
          <button
            className="secondary"
            disabled={
              busy ||
              doctor === null ||
              !doctor.checks.some(
                (check) => check.repairable && check.status === "fail",
              )
            }
            onClick={() =>
              void run(async () =>
                setDoctor(await window.codexgptBridge.repairDoctor()),
              )
            }
          >
            {t("repairSafe")}
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const path = await window.codexgptBridge.exportDoctor();
                if (path) setMessage(path);
              })
            }
          >
            {t("exportDoctor")}
          </button>
        </div>
        {doctor === null ? (
          <p>{t("doctorNotRun")}</p>
        ) : (
          <details
            className="modelEvidence"
            open={doctor.overall !== "healthy"}
          >
            <summary>
              {doctor.overall === "healthy"
                ? t("doctorHealthy")
                : doctor.overall === "attention"
                  ? t("doctorAttention")
                  : t("doctorBroken")}
            </summary>
            {doctor.checks.map((check) => (
              <p
                className={
                  check.status === "fail" ? "providerError" : undefined
                }
                key={check.id}
              >
                {check.status.toUpperCase()} · {check.label} — {check.detail}
              </p>
            ))}
          </details>
        )}
      </section>

      <footer>{message}</footer>
    </main>
  );
}
