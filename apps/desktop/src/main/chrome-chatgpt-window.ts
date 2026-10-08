import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import type {
  BrowserWindowConstructorOptions,
  Menu,
  WindowOpenHandlerResponse,
} from "electron";
import type {
  ChatGptWindow,
  ChatGptInputEvent,
  ChatGptWindowOpenDetails as WindowOpenHandlerDetails,
} from "./chatgpt-window.js";
import { ChatGptSessionError } from "./chatgpt-session-probe.js";

function chromeExecutable(): string {
  if (process.env.CODEXGPT_BRIDGE_CHROME_PATH?.trim())
    return resolve(process.env.CODEXGPT_BRIDGE_CHROME_PATH.trim());
  if (process.platform === "win32")
    return join(
      process.env.PROGRAMFILES || "C:\\Program Files",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    );
  if (process.platform === "darwin")
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return "/usr/bin/google-chrome";
}

/** One installed Chrome process with a dedicated, persistent Bridge profile. */
export class ChromeChatGptHost {
  #opening: Promise<BrowserContext> | undefined;
  #browser: Browser | undefined;
  #child: ChildProcess | undefined;
  #manualLogin:
    { readonly child: ChildProcess; phase: "waiting" | "ready" } | undefined;
  #loginError: string | undefined;
  #manualStarting = false;
  #driverAllowed: boolean;
  #verified = false;
  readonly #windows = new Set<ChromeChatGptWindow>();
  constructor(
    private readonly profile: string,
    private readonly executable = chromeExecutable(),
    private readonly requireManualLogin = false,
  ) {
    this.#driverAllowed = !requireManualLogin;
  }

  manualLoginStatus(): {
    readonly phase: "idle" | "waiting" | "ready";
    readonly error?: string;
    readonly verified: boolean;
  } {
    return {
      phase: this.#manualStarting
        ? "waiting"
        : (this.#manualLogin?.phase ?? "idle"),
      ...(this.#loginError ? { error: this.#loginError } : {}),
      verified: this.#verified,
    };
  }

  async beginManualLogin(url: string): Promise<void> {
    if (this.#manualLogin || this.#manualStarting) return;
    this.#manualStarting = true;
    this.#verified = false;
    this.#driverAllowed = false;
    try {
      await this.close();
      await access(this.executable);
      await mkdir(this.profile, { recursive: true });
      await unlink(join(this.profile, "DevToolsActivePort")).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      // Authentication happens in ordinary Chrome. No browser driver or debugging
      // endpoint is connected until the user closes Chrome and chooses Continue.
      const child = spawn(
        this.executable,
        [
          `--user-data-dir=${this.profile}`,
          "--new-window",
          "--disable-background-mode",
          "--no-first-run",
          "--no-default-browser-check",
          url,
        ],
        { stdio: "ignore" },
      );
      const login = { child, phase: "waiting" as "waiting" | "ready" };
      this.#manualLogin = login;
      this.#loginError = undefined;
      child.once("error", (error) => {
        if (this.#manualLogin !== login) return;
        this.#manualLogin = undefined;
        this.#loginError = error.message;
      });
      child.once("exit", (code, signal) => {
        if (this.#manualLogin !== login) return;
        if (code === 0 && !signal) login.phase = "ready";
        else {
          this.#manualLogin = undefined;
          this.#loginError =
            "The dedicated login Chrome did not close normally. Open login again.";
        }
      });
    } catch (error) {
      this.#loginError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.#manualStarting = false;
    }
  }

  finishManualLogin(): void {
    if (!this.#manualLogin)
      throw new Error("Open Chrome login before choosing Continue.");
    if (this.#manualLogin.phase !== "ready")
      throw new Error(
        "Finish signing in, close the dedicated Chrome window, then choose Continue.",
      );
    this.#manualLogin = undefined;
    this.#loginError = undefined;
    this.#driverAllowed = true;
  }

  confirmVerifiedLogin(): void {
    this.#verified = true;
  }
  invalidateVerifiedLogin(): void {
    this.#verified = false;
  }

  async restoreSavedLogin(): Promise<boolean> {
    if (this.#manualLogin || this.#manualStarting) return false;
    // A saved profile permits a fresh server-session probe only. Model turns
    // remain blocked until that probe confirms the account and ready composer.
    for (const path of [
      join(this.profile, "Default", "Network", "Cookies"),
      join(this.profile, "Default", "Cookies"),
    ]) {
      const saved = await stat(path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      });
      if (saved?.isFile() && saved.size > 0) {
        this.#driverAllowed = true;
        return true;
      }
    }
    return false;
  }

  async #context(): Promise<BrowserContext> {
    if (this.#manualLogin || this.#manualStarting)
      throw new Error(
        "Chrome sign-in is waiting for you. Finish signing in, close the dedicated Chrome window, then choose Continue in Bridge.",
      );
    if (!this.#driverAllowed)
      throw new ChatGptSessionError(
        "Complete Chrome login and choose Continue in Bridge before testing or starting Web models.",
        "chatgpt_web_session_expired",
        false,
      );
    if (this.#opening) return this.#opening;
    const opening = (async () => {
      await access(this.executable).catch(() => {
        throw new Error(
          `Google Chrome was not found at ${this.executable}. Select the embedded browser or install Chrome.`,
        );
      });
      await mkdir(this.profile, { recursive: true });
      const portFile = join(this.profile, "DevToolsActivePort");
      await unlink(portFile).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      const child = spawn(
        this.executable,
        [
          `--user-data-dir=${this.profile}`,
          "--remote-debugging-address=127.0.0.1",
          "--remote-debugging-port=0",
          "--disable-background-mode",
          "--no-first-run",
          "--no-default-browser-check",
          "--no-startup-window",
        ],
        { stdio: "ignore", windowsHide: true },
      );
      this.#child = child;
      let launchError: Error | undefined;
      child.once("error", (error) => {
        launchError = error;
      });
      const deadline = Date.now() + 30_000;
      let endpoint: string | undefined;
      while (Date.now() < deadline) {
        if (launchError) throw launchError;
        if (child.exitCode !== null)
          throw new Error(
            "The dedicated Bridge Chrome process closed before it was ready.",
          );
        const port = Number(
          (await readFile(portFile, "utf8").catch(() => "")).split(/\r?\n/u)[0],
        );
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          endpoint = `http://127.0.0.1:${port}`;
          break;
        }
        await delay(100);
      }
      if (!endpoint)
        throw new Error(
          "The dedicated Bridge Chrome process did not become ready within 30 seconds.",
        );
      const browser = await chromium.connectOverCDP(endpoint);
      this.#browser = browser;
      browser.on("disconnected", () => {
        if (this.#browser === browser) {
          this.#browser = undefined;
          this.#opening = undefined;
        }
      });
      const context = browser.contexts()[0];
      if (!context)
        throw new Error(
          "The dedicated Bridge Chrome profile has no browser context.",
        );
      return context;
    })();
    this.#opening = opening;
    try {
      return await opening;
    } catch (error) {
      this.#opening = undefined;
      this.#child?.kill();
      this.#child = undefined;
      throw error;
    }
  }

  async createWindow(
    options: BrowserWindowConstructorOptions,
    purpose: "login" | "turn" = "turn",
  ): Promise<ChatGptWindow> {
    if (this.requireManualLogin && !this.#verified && purpose !== "login")
      throw new ChatGptSessionError(
        "Verify Chrome login in Bridge before testing or starting Web models.",
        "chatgpt_web_session_expired",
        false,
      );
    const context = await this.#context();
    const existing = context
      .pages()
      .find(
        (page) =>
          page.url() === "about:blank" &&
          ![...this.#windows].some((window) => window.page === page),
      );
    const page = existing ?? (await context.newPage());
    const window = await ChromeChatGptWindow.create(page, context);
    this.#windows.add(window);
    window.on("closed", () => this.#windows.delete(window));
    if (options.show) window.show();
    return window;
  }

  async close(): Promise<void> {
    await this.#opening?.catch(() => undefined);
    const login = this.#manualLogin;
    this.#manualLogin = undefined;
    if (
      login &&
      login.child.exitCode === null &&
      login.child.signalCode === null
    ) {
      login.child.kill();
      await Promise.race([
        new Promise<void>((done) => login.child.once("exit", () => done())),
        delay(3_000),
      ]);
    }
    for (const window of this.#windows) window.destroy();
    this.#windows.clear();
    const browser = this.#browser;
    this.#browser = undefined;
    this.#opening = undefined;
    this.#verified = false;
    this.#driverAllowed = !this.requireManualLogin;
    if (browser?.isConnected()) {
      const cdp = await browser.newBrowserCDPSession().catch(() => undefined);
      await cdp?.send("Browser.close").catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
    const child = this.#child;
    this.#child = undefined;
    if (child && child.exitCode === null) {
      await Promise.race([
        new Promise<void>((done) => child.once("exit", () => done())),
        delay(3_000),
      ]);
      if (child.exitCode === null) child.kill();
    }
  }
}

class ChromeChatGptWindow extends EventEmitter implements ChatGptWindow {
  readonly requiresManualVerification = true;
  readonly webContents: ChromeChatGptContents;
  #destroyed = false;
  #visible = true;
  #minimized = false;
  private constructor(
    readonly page: Page,
    context: BrowserContext,
    readonly cdp: CDPSession,
    readonly windowId: number,
  ) {
    super();
    this.webContents = new ChromeChatGptContents(page, context, cdp);
    page.on("close", () => {
      if (!this.#destroyed) {
        this.#destroyed = true;
        this.emit("closed");
      }
    });
  }
  static async create(
    page: Page,
    context: BrowserContext,
  ): Promise<ChromeChatGptWindow> {
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    return new ChromeChatGptWindow(page, context, cdp, windowId);
  }
  isDestroyed(): boolean {
    return this.#destroyed || this.page.isClosed();
  }
  isVisible(): boolean {
    return this.#visible && !this.isDestroyed();
  }
  isMinimized(): boolean {
    return this.#minimized;
  }
  restore(): void {
    this.#minimized = false;
    void this.cdp
      .send("Browser.setWindowBounds", {
        windowId: this.windowId,
        bounds: { windowState: "normal" },
      })
      .catch(() => undefined);
  }
  show(): void {
    this.#visible = true;
    this.restore();
  }
  focus(): void {
    void this.page.bringToFront().catch(() => undefined);
  }
  destroy(): void {
    if (this.isDestroyed()) return;
    this.emit("close");
    this.#destroyed = true;
    void this.page.close().catch(() => undefined);
    this.emit("closed");
  }
  async loadURL(url: string): Promise<void> {
    await this.webContents.settled();
    await this.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  }
  // Chrome owns its native navigation and zoom controls.
  setMenu(_menu: Menu | null): void {
    /* Native Chrome controls. */
  }
  setMenuBarVisibility(_visible: boolean): void {
    /* Native Chrome controls. */
  }
}

class ChromeChatGptContents extends EventEmitter {
  #inputs: Promise<unknown> = Promise.resolve();
  #inputError: unknown;
  #zoom = 1;
  #handler:
    | ((details: WindowOpenHandlerDetails) => WindowOpenHandlerResponse)
    | undefined;
  readonly navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: () => this.queue(() => this.page.goBack()),
    goForward: () => this.queue(() => this.page.goForward()),
  };
  readonly session: ChatGptWindow["webContents"]["session"];
  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly cdp: CDPSession,
  ) {
    super();
    this.session = {
      fetch: (url, init) => this.fetch(url, init),
      clearStorageData: async () => {
        await context.clearCookies();
        await cdp.send("Storage.clearDataForOrigin", {
          origin: "https://chatgpt.com",
          storageTypes: "all",
        });
      },
      flushStorageData: () => undefined,
      cookies: {
        set: async (cookie) => {
          const { expirationDate, sameSite, ...value } = cookie;
          await context.addCookies([
            {
              ...value,
              name: cookie.name ?? "",
              value: cookie.value ?? "",
              ...(expirationDate === undefined
                ? {}
                : { expires: expirationDate }),
              sameSite:
                sameSite === "no_restriction"
                  ? "None"
                  : sameSite === "strict"
                    ? "Strict"
                    : "Lax",
            },
          ]);
        },
        flushStore: async () => undefined,
      },
    };
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.emit("did-navigate");
    });
    page.on("load", () => this.emit("did-stop-loading"));
    page.on("popup", (popup) => {
      void this.adoptPopup(popup).catch(() =>
        popup.close().catch(() => undefined),
      );
    });
  }
  private async adoptPopup(popup: Page): Promise<void> {
    await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
    const url = popup.url();
    const decision = this.#handler?.({
      url,
      frameName: "",
      features: "",
      disposition: "new-window",
      referrer: { url: this.page.url(), policy: "default" },
    });
    if (decision?.action !== "allow") {
      await popup.close();
      return;
    }
    const window = await ChromeChatGptWindow.create(popup, this.context);
    this.emit("did-create-window", window, { url });
    await popup.route("**/*", async (route) => {
      const request = route.request();
      if (
        request.isNavigationRequest() &&
        request.frame() === popup.mainFrame()
      ) {
        let prevented = false;
        window.webContents.emit(
          "will-navigate",
          {
            preventDefault: () => {
              prevented = true;
            },
          },
          request.url(),
        );
        if (prevented) {
          await route.abort("blockedbyclient");
          return;
        }
      }
      await route.continue();
    });
  }
  async settled(): Promise<void> {
    await this.#inputs;
    if (this.#inputError) {
      const error = this.#inputError;
      this.#inputError = undefined;
      throw error;
    }
  }
  private queue(action: () => Promise<unknown>): void {
    this.#inputs = this.#inputs.then(action).catch((error) => {
      this.#inputError ??= error;
    });
  }
  async executeJavaScript<T = unknown>(
    code: string,
    _userGesture?: boolean,
  ): Promise<T> {
    await this.settled();
    return (await this.page.evaluate(code)) as T;
  }
  getURL(): string {
    return this.page.url();
  }
  async insertText(text: string): Promise<void> {
    await this.settled();
    await this.page.keyboard.insertText(text);
  }
  sendInputEvent(event: ChatGptInputEvent): void {
    if (
      event.type === "keyDown" ||
      event.type === "keyUp" ||
      event.type === "char"
    ) {
      const keyEvent = event as Electron.KeyboardInputEvent;
      const keys: Record<string, [string, number]> = {
        ENTER: ["Enter", 13],
        RETURN: ["Enter", 13],
        ESCAPE: ["Escape", 27],
        BACKSPACE: ["Backspace", 8],
        DELETE: ["Delete", 46],
        TAB: ["Tab", 9],
        LEFT: ["ArrowLeft", 37],
        RIGHT: ["ArrowRight", 39],
        UP: ["ArrowUp", 38],
        DOWN: ["ArrowDown", 40],
      };
      const [key, keyCode] = keys[keyEvent.keyCode.toUpperCase()] ?? [
        keyEvent.keyCode,
        keyEvent.keyCode.length === 1
          ? keyEvent.keyCode.toUpperCase().charCodeAt(0)
          : 0,
      ];
      const modifiers = keyEvent.modifiers ?? [];
      const mask =
        (modifiers.includes("alt") ? 1 : 0) |
        (modifiers.includes("control") ? 2 : 0) |
        (modifiers.includes("meta") ? 4 : 0) |
        (modifiers.includes("shift") ? 8 : 0);
      const type = event.type;
      this.queue(() =>
        this.cdp.send("Input.dispatchKeyEvent", {
          type,
          key,
          code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
          windowsVirtualKeyCode: keyCode,
          modifiers: mask,
          ...(type === "char" ? { text: keyEvent.keyCode } : {}),
        }),
      );
      return;
    }
    const mouse = event as Electron.MouseInputEvent;
    const types: Record<
      string,
      "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel"
    > = {
      mouseDown: "mousePressed",
      mouseUp: "mouseReleased",
      mouseMove: "mouseMoved",
      mouseWheel: "mouseWheel",
    };
    const type = types[event.type];
    if (!type) {
      this.#inputError = new Error(
        `Unsupported Chrome input event: ${event.type}`,
      );
      return;
    }
    this.queue(() =>
      this.cdp.send("Input.dispatchMouseEvent", {
        type,
        x: mouse.x,
        y: mouse.y,
        button: mouse.button ?? "none",
        clickCount: mouse.clickCount ?? 1,
      }),
    );
  }
  getZoomFactor(): number {
    return this.#zoom;
  }
  setZoomFactor(factor: number): void {
    this.#zoom = factor;
    this.queue(() =>
      this.cdp.send("Emulation.setPageScaleFactor", {
        pageScaleFactor: factor,
      }),
    );
  }
  reload(): void {
    this.queue(() => this.page.reload());
  }
  setWindowOpenHandler(
    handler: (details: WindowOpenHandlerDetails) => WindowOpenHandlerResponse,
  ): void {
    this.#handler = handler;
  }
  private async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    init.signal?.throwIfAborted();
    // Same-origin session checks run in Chrome. Browser credentials and TLS
    // remain owned by Chrome.
    if (
      init.redirect !== "manual" &&
      new URL(url).origin === new URL(this.page.url()).origin
    ) {
      const id = `bridge-fetch-${randomUUID()}`;
      const onAbort = (): void => {
        void this.page
          .evaluate((id) => {
            const entry = (
              globalThis as unknown as Record<string, AbortController>
            )[id];
            entry?.abort();
          }, id)
          .catch(() => undefined);
      };
      init.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const value = await this.page.evaluate(
          async ({ id, url, method, body, headers }) => {
            const controller = new AbortController();
            const storage = globalThis as unknown as Record<
              string,
              AbortController
            >;
            storage[id] = controller;
            try {
              const response = await fetch(url, {
                ...(method ? { method } : {}),
                ...(body === undefined ? {} : { body }),
                headers,
                credentials: "include",
                signal: controller.signal,
              });
              return {
                status: response.status,
                headers: [...response.headers.entries()],
                body: await response.text(),
              };
            } finally {
              delete storage[id];
            }
          },
          {
            id,
            url,
            method: init.method,
            body: typeof init.body === "string" ? init.body : undefined,
            headers: Object.fromEntries(new Headers(init.headers)),
          },
        );
        init.signal?.throwIfAborted();
        return new Response(value.body, {
          status: value.status,
          headers: value.headers,
        });
      } finally {
        init.signal?.removeEventListener("abort", onAbort);
      }
    }
    const response = await this.context.request.fetch(url, {
      ...(init.method ? { method: init.method } : {}),
      headers: Object.fromEntries(new Headers(init.headers)),
      maxRedirects: init.redirect === "manual" ? 0 : 5,
      timeout: 30_000,
    });
    try {
      init.signal?.throwIfAborted();
      return new Response(await response.body(), {
        status: response.status(),
        // Playwright's header map folds multiple Set-Cookie values with newlines,
        // which Fetch Headers rejects and can echo into an exception. The shared
        // browser cookie jar already applied these values; callers do not need them.
        headers: response
          .headersArray()
          .filter(({ name }) => name.toLowerCase() !== "set-cookie")
          .map(({ name, value }) => [name, value] as [string, string]),
      });
    } finally {
      await response.dispose();
    }
  }
}
