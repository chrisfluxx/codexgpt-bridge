import { Menu, Notification, Tray } from "electron";
import { bridgeAppIcon } from "./app-icon.js";
import type { DesktopSettings } from "./preload.cjs";
import type { ReleaseUpdateStatus } from "./release-update.js";

const labels = {
  en: {
    open: "Open main window",
    quit: "Quit",
    check: "Check for updates",
    update: "View update",
    title: "CodexGPT Bridge update available",
    body: "Version {version} is available. Click to view the update.",
  },
  "zh-TW": {
    open: "開啟主視窗",
    quit: "結束",
    check: "檢查更新",
    update: "查看更新",
    title: "CodexGPT Bridge 有新版本",
    body: "版本 {version} 已推出，點擊查看更新。",
  },
  "zh-CN": {
    open: "打开主窗口",
    quit: "退出",
    check: "检查更新",
    update: "查看更新",
    title: "CodexGPT Bridge 有新版本",
    body: "版本 {version} 已推出，点击查看更新。",
  },
  ja: {
    open: "メインウィンドウを開く",
    quit: "終了",
    check: "更新を確認",
    update: "更新を表示",
    title: "CodexGPT Bridge の更新があります",
    body: "バージョン {version} が利用可能です。クリックして更新を表示。",
  },
  ko: {
    open: "기본 창 열기",
    quit: "종료",
    check: "업데이트 확인",
    update: "업데이트 보기",
    title: "CodexGPT Bridge 업데이트",
    body: "버전 {version}을 사용할 수 있습니다. 클릭하여 업데이트를 확인하세요.",
  },
};

export class BridgeSystemTray {
  static current: BridgeSystemTray | undefined;
  readonly tray: Tray;
  menu!: Menu;
  #locale: DesktopSettings["locale"];
  #update: ReleaseUpdateStatus | undefined;
  #notification: Notification | undefined;

  constructor(
    locale: DesktopSettings["locale"],
    private readonly onOpen: () => void,
    private readonly onQuit: () => void,
    private readonly updateActions?: { check: () => void; open: () => void },
  ) {
    this.#locale = locale;
    const size = process.platform === "darwin" ? 18 : 32;
    this.tray = new Tray(bridgeAppIcon().resize({ width: size, height: size }));
    this.tray.setToolTip("CodexGPT Bridge");
    this.tray.on("click", onOpen);
    this.tray.on("double-click", onOpen);
    this.tray.on("balloon-click", () =>
      (this.updateActions?.open ?? this.onOpen)(),
    );
    this.setLocale(locale);
    BridgeSystemTray.current = this;
  }

  setLocale(locale: DesktopSettings["locale"]): void {
    this.#locale = locale;
    this.#rebuildMenu();
  }

  setUpdateStatus(status: ReleaseUpdateStatus): void {
    this.#update = status;
    this.#rebuildMenu();
  }

  notifyUpdate(version: string): boolean {
    if (this.tray.isDestroyed()) return false;
    const text = labels[this.#locale];
    const body = text.body.replace("{version}", version);
    if (process.platform === "win32") {
      this.tray.displayBalloon({
        title: text.title,
        content: body,
        iconType: "info",
        respectQuietTime: true,
      });
    } else if (Notification.isSupported()) {
      this.#notification = new Notification({ title: text.title, body });
      this.#notification.on("click", () =>
        (this.updateActions?.open ?? this.onOpen)(),
      );
      this.#notification.show();
    }
    // The menu remains available even when the OS suppresses popup notifications.
    return true;
  }

  #rebuildMenu(): void {
    if (this.tray.isDestroyed()) return;
    const text = labels[this.#locale];
    const version =
      this.#update &&
      ["available", "ready", "installing"].includes(this.#update.phase)
        ? this.#update.availableVersion
        : undefined;
    this.tray.setToolTip(
      version
        ? `CodexGPT Bridge — ${text.update} ${version}`
        : "CodexGPT Bridge",
    );
    this.menu = Menu.buildFromTemplate([
      { label: "CodexGPT Bridge", enabled: false },
      { type: "separator" },
      { id: "open", label: text.open, click: this.onOpen },
      ...(this.updateActions
        ? [
            ...(version
              ? [
                  {
                    id: "update",
                    label: `${text.update} ${version}`,
                    click: this.updateActions.open,
                  },
                ]
              : []),
            {
              id: "check-update",
              label: text.check,
              enabled:
                !this.#update ||
                !["checking", "downloading", "installing"].includes(
                  this.#update.phase,
                ),
              click: this.updateActions.check,
            },
          ]
        : []),
      { type: "separator" },
      { id: "quit", label: text.quit, click: this.onQuit },
    ]);
    this.tray.setContextMenu(this.menu);
  }
}
