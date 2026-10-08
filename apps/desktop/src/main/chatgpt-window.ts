import type {
  BrowserWindowConstructorOptions,
  Menu,
  WebContents,
  WindowOpenHandlerResponse,
} from "electron";
export type ChatGptInputEvent = Parameters<WebContents["sendInputEvent"]>[0];
export type ChatGptWindowOpenDetails = Parameters<
  Parameters<WebContents["setWindowOpenHandler"]>[0]
>[0];

export interface ChatGptWindow {
  readonly requiresManualVerification?: boolean;
  readonly webContents: {
    executeJavaScript<T = unknown>(
      code: string,
      userGesture?: boolean,
    ): Promise<T>;
    getURL(): string;
    insertText(text: string): Promise<void>;
    sendInputEvent(event: ChatGptInputEvent): void;
    getZoomFactor(): number;
    setZoomFactor(factor: number): void;
    reload(): void;
    setWindowOpenHandler(
      handler: (details: ChatGptWindowOpenDetails) => WindowOpenHandlerResponse,
    ): void;
    on<Args extends unknown[]>(
      event: string,
      listener: (...args: Args) => void,
    ): unknown;
    readonly navigationHistory: {
      canGoBack(): boolean;
      canGoForward(): boolean;
      goBack(): void;
      goForward(): void;
    };
    readonly session: {
      fetch(url: string, init?: RequestInit): Promise<Response>;
      clearStorageData(): Promise<void>;
      flushStorageData(): void;
      readonly cookies: {
        set(
          cookie: Parameters<WebContents["session"]["cookies"]["set"]>[0],
        ): Promise<void>;
        flushStore(): Promise<void>;
      };
    };
  };
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  destroy(): void;
  loadURL(url: string): Promise<unknown>;
  setMenu(menu: Menu | null): void;
  setMenuBarVisibility(visible: boolean): void;
  on<Args extends unknown[]>(
    event: string,
    listener: (...args: Args) => void,
  ): unknown;
}

export type CreateChatGptWindow = (
  options: BrowserWindowConstructorOptions,
  purpose?: "login" | "turn",
) => Promise<ChatGptWindow>;
