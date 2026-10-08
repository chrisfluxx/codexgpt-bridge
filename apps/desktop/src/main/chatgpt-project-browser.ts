import type { ChatGptWindow, CreateChatGptWindow } from "./chatgpt-window.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BrowserWindow } from "electron";
import { delay } from "./browser-delay.js";
import { PreparationError } from "./completion-diagnostics.js";
import {
  chatGptProjectAction,
  type ProjectAction,
  type ProjectSurface,
} from "./chatgpt-project-dom.js";
import { normalizeChatGptProjectUrl } from "./chatgpt-projects.js";
import { probeChatGptServerSession } from "./chatgpt-session-probe.js";
import { SharedSerialRunner } from "./shared-serial-runner.js";

export class ChatGptProjectBrowser {
  readonly #runner = new SharedSerialRunner<string>(120_000, 0, 0);
  readonly #shutdown = new AbortController();
  #window: ChatGptWindow | undefined;
  #pending = new Set<string>();
  #loaded = false;
  constructor(
    private readonly baseUrl: string,
    private readonly partition: string,
    private readonly pendingFile?: string,
    private readonly createWindow: CreateChatGptWindow = async (options) =>
      new BrowserWindow(options),
  ) {}

  async #loadPending(): Promise<void> {
    if (this.#loaded) return;
    if (this.pendingFile) {
      try {
        const data: unknown = JSON.parse(
          await readFile(this.pendingFile, "utf8"),
        );
        if (
          !Array.isArray(data) ||
          !data.every((value) => typeof value === "string")
        )
          throw new Error("專案建立紀錄損毀，請檢查 Bridge 資料。");
        this.#pending = new Set(data as string[]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.#loaded = true;
  }

  async #savePending(): Promise<void> {
    if (!this.pendingFile) return;
    await mkdir(dirname(this.pendingFile), { recursive: true });
    const temporary = `${this.pendingFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify([...this.#pending]), "utf8");
    await rename(temporary, this.pendingFile);
  }

  resolve(name: string, signal: AbortSignal): Promise<string> {
    // Unique queue entries force a fresh search, even after an account switch or failed creation.
    return this.#runner.run(
      randomUUID(),
      AbortSignal.any([signal, this.#shutdown.signal]),
      async (queuedSignal) => {
        const timeout = AbortSignal.timeout(60_000);
        try {
          return await this.#resolve(
            name,
            AbortSignal.any([queuedSignal, timeout]),
          );
        } catch (error) {
          if (timeout.aborted && !queuedSignal.aborted)
            throw new PreparationError(
              "ChatGPT Project 搜尋／建立逾時，尚未送出訊息。請確認專案頁可用後重試。",
              "timeout",
            );
          throw error;
        }
      },
    );
  }

  close(): void {
    this.#shutdown.abort();
    if (this.#window && !this.#window.isDestroyed()) this.#window.destroy();
    this.#window = undefined;
  }

  async #resolve(name: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    await this.#loadPending();
    signal.throwIfAborted();
    if (!name.trim() || name.length > 200)
      throw new Error("Codex 專案名稱無效。");
    const window = await this.createWindow({
      width: 1180,
      height: 820,
      show: false,
      title: "ChatGPT Projects - CodexGPT Bridge",
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.#window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const origin = new URL(this.baseUrl).origin;
    const act = async (action: ProjectAction): Promise<ProjectSurface> => {
      signal.throwIfAborted();
      if (new URL(window.webContents.getURL()).origin !== origin)
        throw new Error("ChatGPT 專案頁已離開登入來源，尚未送出訊息。");
      const state = (await window.webContents.executeJavaScript(
        `(${chatGptProjectAction.toString()})(${JSON.stringify(action)}, ${JSON.stringify(name)})`,
        true,
      )) as ProjectSurface;
      if (state.error)
        throw new Error(`ChatGPT 專案頁發生錯誤，尚未送出訊息：${state.error}`);
      return state;
    };
    const wait = async (
      action: "search" | "fill" | "create" | "destination",
      accept: (state: ProjectSurface) => boolean,
    ): Promise<ProjectSurface> => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const state = await act(action);
        if (accept(state)) return state;
        await delay(150, signal);
      }
      const stage = {
        search: "專案搜尋欄位",
        fill: "新專案名稱欄位",
        create: "建立專案按鈕",
        destination: "Project 目的地",
      }[action];
      throw new PreparationError(
        `ChatGPT ${stage ?? "專案介面"}未就緒，尚未送出訊息。請確認專案頁介面後重試。`,
        "timeout",
      );
    };
    const enterName = async (action: "search" | "fill"): Promise<void> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await wait(action, (state) => state.clicked);
        // Real browser editing events reach controlled inputs, unlike value setters
        // plus synthetic input/change events. Clear first so a hydration retry also
        // generates a change when the visible value already equals the target.
        window.webContents.sendInputEvent({
          type: "keyDown",
          keyCode: "BACKSPACE",
        });
        window.webContents.sendInputEvent({
          type: "keyUp",
          keyCode: "BACKSPACE",
        });
        await window.webContents.insertText(name);
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          const state = await act("inspect");
          if (action === "search" ? state.searchAccepted : state.nameAccepted)
            return;
          await delay(150, signal);
        }
      }
      throw new Error(
        action === "search"
          ? "ChatGPT 尚未接收專案搜尋輸入，尚未建立專案或送出訊息。請重試。"
          : "ChatGPT 尚未接收新專案名稱，尚未建立專案或送出訊息。請重試。",
      );
    };
    const settledSearch = async (): Promise<ProjectSurface> => {
      const deadline = Date.now() + 12_000;
      let signature = "";
      let stableSince = Date.now();
      let lastStatus = "";
      while (Date.now() < deadline) {
        const state = await act("inspect");
        lastStatus = state.searchStatus;
        if (!state.ready || state.signature !== signature) {
          signature = state.signature;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 1_000) {
          return state;
        }
        await delay(150, signal);
      }
      throw new Error(
        `ChatGPT 專案搜尋結果尚未更新完成，尚未建立專案或送出訊息。${lastStatus}`,
      );
    };
    const abort = (): void => {
      if (!window.isDestroyed()) window.destroy();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await window.loadURL(new URL("/projects", origin).href);
      await probeChatGptServerSession(
        this.baseUrl,
        (url, init) => window.webContents.session.fetch(url, init),
        signal,
      );
      await enterName("search");
      const found = await settledSearch();
      if (found.matches > 1)
        throw new Error(
          `ChatGPT 有多個同名專案「${name}」，請先將同名專案改成不同名稱；尚未送出訊息。`,
        );
      if (found.matches === 1) {
        if (!(await act("open")).clicked)
          throw new Error(
            "ChatGPT 專案搜尋結果已改變或新對話入口不可用，尚未送出訊息。請重試。",
          );
      } else {
        if (!found.empty)
          throw new Error(
            `無法確認「${name}」不存在（有部分相符結果），請先在 ChatGPT 確認專案名稱；尚未建立專案。`,
          );
        if (this.#pending.has(name))
          throw new Error(
            `上次建立「${name}」的結果未確認，為避免重複不會再次建立。請先在 ChatGPT 確認同名專案是否已建立。`,
          );
        if (!(await act("new")).clicked)
          throw new Error("ChatGPT 新增專案介面不可用，尚未建立專案。");
        await enterName("fill");
        this.#pending.add(name);
        await this.#savePending();
        await wait("create", (state) => state.clicked);
        // Never repeat the create click after an uncertain outcome. A retry starts from search.
      }
      await wait("destination", (state) => state.destination);
      this.#pending.delete(name);
      await this.#savePending();
      return normalizeChatGptProjectUrl(
        window.webContents.getURL(),
        this.baseUrl,
      );
    } finally {
      signal.removeEventListener("abort", abort);
      if (!window.isDestroyed()) window.destroy();
      if (this.#window === window) this.#window = undefined;
    }
  }
}
