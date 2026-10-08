import type { OnCompletedListenerDetails, WebRequest } from "electron";

export type ChatGptBackendResponse = Pick<
  OnCompletedListenerDetails,
  "url" | "statusCode" | "responseHeaders" | "webContentsId"
>;

/** Track only the owned page's backend, never an unrelated 403 or login. */
export class ChatGptBackendAccess {
  readonly #origin: string;
  readonly #challenged = new Set<string>();
  #reloadAttempted = false;

  constructor(
    baseUrl: string,
    readonly webContentsId: number,
  ) {
    this.#origin = new URL(baseUrl).origin;
  }

  get blocked(): boolean {
    return this.#challenged.size > 0;
  }

  observe(details: ChatGptBackendResponse): boolean {
    if (details.webContentsId !== this.webContentsId) return false;
    let url: URL;
    try {
      url = new URL(details.url);
    } catch {
      return false;
    }
    if (
      url.origin !== this.#origin ||
      (!url.pathname.startsWith("/backend-api/") &&
        url.pathname !== "/api/auth/session")
    )
      return false;
    const challenge = Object.entries(details.responseHeaders ?? {}).some(
      ([name, values]) =>
        name.toLowerCase() === "cf-mitigated" &&
        values.some((value) =>
          value
            .split(",")
            .some((part) => part.trim().toLowerCase() === "challenge"),
        ),
    );
    if (details.statusCode === 403 && challenge) {
      this.markChallenge(url.href);
      return true;
    }
    if (details.statusCode >= 200 && details.statusCode < 300) {
      this.#challenged.delete(url.pathname);
      if (!this.blocked) this.#reloadAttempted = false;
    }
    return false;
  }

  markChallenge(url: string): void {
    this.#challenged.add(new URL(url).pathname);
  }

  takeReload(): boolean {
    if (!this.blocked || this.#reloadAttempted) return false;
    this.#reloadAttempted = true;
    return true;
  }
}

// Electron accepts one onCompleted listener per session. Login and task pages
// share a persistent session, so dispatch by webContentsId instead of replacing
// each other's listener. Closing one window leaves the other observers intact.
const subscriptions = new WeakMap<
  WebRequest,
  Map<number, Set<(details: ChatGptBackendResponse) => void>>
>();

export function subscribeChatGptBackendResponses(
  webRequest: WebRequest,
  webContentsId: number,
  observe: (details: ChatGptBackendResponse) => void,
): () => void {
  let owners = subscriptions.get(webRequest);
  if (!owners) {
    owners = new Map();
    subscriptions.set(webRequest, owners);
    const dispatch = owners;
    webRequest.onCompleted(
      { urls: ["*://*/backend-api/*", "*://*/api/auth/session"] },
      (details) => {
        if (details.webContentsId === undefined) return;
        for (const listener of dispatch.get(details.webContentsId) ?? [])
          listener(details);
      },
    );
  }
  const listeners = owners.get(webContentsId) ?? new Set();
  listeners.add(observe);
  owners.set(webContentsId, listeners);
  return () => {
    listeners.delete(observe);
    if (!listeners.size) owners.delete(webContentsId);
  };
}
