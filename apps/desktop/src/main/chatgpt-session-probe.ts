import { createHash, randomUUID } from "node:crypto";

const SESSION_PATH = "/api/auth/session";
const MAX_SESSION_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_SESSION_PROBE_TIMEOUT_MS = 10_000;

export type ChatGptSessionErrorCode =
  "chatgpt_web_session_expired" | "chatgpt_web_session_unavailable";

export class ChatGptSessionError extends Error {
  constructor(
    message: string,
    readonly code: ChatGptSessionErrorCode,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ChatGptSessionError";
  }
}

export class ChatGptSessionChallengeError extends ChatGptSessionError {
  constructor() {
    super(
      "Cloudflare challenged ChatGPT's session check. Complete verification in the existing browser page, then retry. The login session has not been declared expired.",
      "chatgpt_web_session_unavailable",
      true,
    );
    this.name = "ChatGptSessionChallengeError";
  }
}

export interface ChatGptSessionProbeResult {
  readonly verified: boolean;
  readonly reason?: "non-network-fixture";
  readonly usageAccount?: ChatGptUsageAccount;
}

export type ChatGptLimitsPlan =
  | "pro_100"
  | "pro_200"
  | "business_standard"
  | "business_premium"
  | "unsupported";

/** Safe subset of account state. Raw identity and session credentials never leave this module. */
export interface ChatGptUsageAccount {
  readonly accountKey: string;
  readonly plan: ChatGptLimitsPlan;
  readonly personal: boolean;
  readonly needsAttention: boolean;
}

export type ChatGptSessionFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(
        signal.reason ??
          new DOMException("The operation was aborted.", "AbortError"),
      );
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function expired(message: string): ChatGptSessionError {
  return new ChatGptSessionError(message, "chatgpt_web_session_expired", false);
}

function unavailable(message: string, cause?: unknown): ChatGptSessionError {
  return new ChatGptSessionError(
    message,
    "chatgpt_web_session_unavailable",
    true,
    cause === undefined ? undefined : { cause },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAuthenticatedIdentity(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const user = value.user;
  if (
    isRecord(user) &&
    Object.values(user).some(
      (item) =>
        (typeof item === "string" && item.trim().length > 0) ||
        typeof item === "number",
    )
  ) {
    return true;
  }
  return typeof value.accessToken === "string" && value.accessToken.length > 0;
}

function boundedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    ? value
    : undefined;
}

function usagePlan(planType: string): ChatGptLimitsPlan {
  const normalized = planType
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, "_");
  if (normalized === "pro") return "pro_200";
  if (normalized === "prolite" || normalized === "pro_lite") return "pro_100";
  if (
    normalized === "business" ||
    normalized === "business_standard" ||
    normalized === "team"
  )
    return "business_standard";
  if (normalized === "business_premium") return "business_premium";
  return "unsupported";
}

function safeUsageAccount(payload: unknown): ChatGptUsageAccount | undefined {
  if (
    !isRecord(payload) ||
    !isRecord(payload.user) ||
    !isRecord(payload.account)
  )
    return undefined;
  const userId = boundedString(payload.user.id);
  const accountId = boundedString(payload.account.id);
  const planType = boundedString(payload.account.planType);
  const structure = boundedString(payload.account.structure);
  if (!userId || !accountId || !planType || !structure) return undefined;
  return {
    accountKey: createHash("sha256")
      .update(`${userId}\0${accountId}`)
      .digest("hex"),
    plan: usagePlan(planType),
    personal: structure.toLowerCase() === "personal",
    needsAttention: payload.account.isDelinquent === true,
  };
}

async function readBoundedText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SESSION_RESPONSE_BYTES) {
    throw unavailable(
      "ChatGPT's server-session response exceeded the safety limit.",
    );
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_SESSION_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw unavailable(
          "ChatGPT's server-session response exceeded the safety limit.",
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    if (signal.aborted)
      await reader.cancel(signal.reason).catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Probes ChatGPT's same-origin Web session with the Electron partition's cookie jar.
 * The endpoint is an undocumented Web implementation detail, so all parsing and
 * failure policy stay isolated here. The response body is never returned or stored.
 */
export async function probeChatGptServerSession(
  baseUrl: string,
  fetchSession: ChatGptSessionFetch,
  signal: AbortSignal,
  options: { readonly timeoutMs?: number } = {},
): Promise<ChatGptSessionProbeResult> {
  const base = new URL(baseUrl);
  // Electron DOM fixtures use data: URLs. Production ChatGPT surfaces are
  // always network origins and must pass the probe.
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    return { verified: false, reason: "non-network-fixture" };
  }

  const endpoint = new URL(SESSION_PATH, base.origin).toString();
  const timeoutSignal = AbortSignal.timeout(
    options.timeoutMs ?? DEFAULT_SESSION_PROBE_TIMEOUT_MS,
  );
  const requestSignal = AbortSignal.any([signal, timeoutSignal]);
  let response: Response;
  try {
    requestSignal.throwIfAborted();
    response = await abortable(
      fetchSession(endpoint, {
        method: "GET",
        headers: {
          accept: "application/json",
          "cache-control": "no-cache",
        },
        credentials: "include",
        redirect: "manual",
        signal: requestSignal,
      }),
      requestSignal,
    );
  } catch (error) {
    signal.throwIfAborted();
    throw unavailable(
      timeoutSignal.aborted
        ? "ChatGPT's server session check timed out. Retry before submitting a prompt."
        : "ChatGPT's server session could not be reached. Retry before submitting a prompt.",
      error,
    );
  }

  if (response.headers.get("cf-mitigated") === "challenge") {
    throw new ChatGptSessionChallengeError();
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (location) {
      const redirected = new URL(location, endpoint);
      if (
        redirected.origin === base.origin &&
        /(?:^|\/)(?:auth|login|signin)(?:\/|$)/iu.test(redirected.pathname)
      ) {
        throw expired(
          "ChatGPT's server session has expired. Sign in again in CodexGPT Bridge.",
        );
      }
    }
    throw unavailable(
      "ChatGPT's server session check returned an unexpected redirect. Retry before submitting a prompt.",
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw expired(
      "ChatGPT's server session is not authenticated. Sign in again in CodexGPT Bridge.",
    );
  }
  if (response.status !== 200) {
    throw unavailable(
      `ChatGPT's server session check returned HTTP ${response.status}. Retry before submitting a prompt.`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!/(?:application|text)\/(?:[\w.+-]*\+)?json\b/iu.test(contentType)) {
    throw unavailable(
      "ChatGPT's server session check returned an unexpected response. Retry before submitting a prompt.",
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readBoundedText(response, requestSignal));
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ChatGptSessionError) throw error;
    if (timeoutSignal.aborted) {
      throw unavailable(
        "ChatGPT's server session check timed out. Retry before submitting a prompt.",
        error,
      );
    }
    throw unavailable(
      "ChatGPT's server session check returned invalid data. Retry before submitting a prompt.",
      error,
    );
  }
  if (!hasAuthenticatedIdentity(payload)) {
    throw expired(
      "ChatGPT's server session has expired. Sign in again in CodexGPT Bridge.",
    );
  }
  const usageAccount = safeUsageAccount(payload);
  return {
    verified: true,
    ...(usageAccount ? { usageAccount } : {}),
  };
}

interface PageSessionResponse {
  readonly status: number;
  readonly headers: [string, string][];
  readonly body: string;
}

interface PageSessionContents {
  getURL(): string;
  executeJavaScript<T = unknown>(code: string): Promise<T>;
}

/** Serialized into the loaded document; credentials stay in its browser context. */
async function readSessionInPage(
  endpoint: string,
  abortKey: string,
  timeoutMs: number,
  maxBytes: number,
  authenticatedIdentity: (value: unknown) => boolean,
  readString: (value: unknown) => string | undefined,
): Promise<PageSessionResponse> {
  if (location.origin !== new URL(endpoint).origin) {
    throw new Error(
      "ChatGPT session verification reached an unexpected origin.",
    );
  }
  const controller = new AbortController();
  const pending = globalThis as unknown as Record<string, AbortController>;
  pending[abortKey] = controller;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "include",
      redirect: "error",
      signal: controller.signal,
    });
    const headers: [string, string][] = [];
    for (const name of ["content-type", "cf-mitigated"]) {
      const value = response.headers.get(name);
      if (value !== null) headers.push([name, value]);
    }
    if (
      response.status !== 200 ||
      !/(?:application|text)\/(?:[\w.+-]*\+)?json\b/iu.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      await response.body?.cancel();
      return { status: response.status, headers, body: "" };
    }
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw new Error("ChatGPT session response exceeded the safety limit.");
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      if (reader) {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw new Error(
              "ChatGPT session response exceeded the safety limit.",
            );
          }
          chunks.push(chunk.value);
        }
      }
    } finally {
      reader?.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const identity = authenticatedIdentity(payload);
    const record = payload as {
      user?: { id?: unknown };
      account?: {
        id?: unknown;
        planType?: unknown;
        structure?: unknown;
        isDelinquent?: unknown;
      };
    } | null;
    // Send only fields needed by the existing validator. In particular, the
    // page's accessToken and identifying profile fields never cross the IPC.
    const userId = readString(record?.user?.id);
    const body = JSON.stringify({
      user: identity ? { id: userId ?? "verified-page-session" } : {},
      account:
        identity && userId
          ? {
              id: readString(record?.account?.id),
              planType: readString(record?.account?.planType),
              structure: readString(record?.account?.structure),
              isDelinquent: record?.account?.isDelinquent === true,
            }
          : {},
    });
    return { status: response.status, headers, body };
  } finally {
    clearTimeout(timer);
    delete pending[abortKey];
  }
}

/** Verify through the same loaded page, never a second native HTTP client. */
export async function probeChatGptPageSession(
  baseUrl: string,
  contents: PageSessionContents,
  signal: AbortSignal,
  options: { readonly timeoutMs?: number } = {},
): Promise<ChatGptSessionProbeResult> {
  return probeChatGptServerSession(
    baseUrl,
    async (endpoint, init) => {
      init.signal?.throwIfAborted();
      if (new URL(contents.getURL()).origin !== new URL(endpoint).origin) {
        throw unavailable(
          "ChatGPT session verification requires its loaded browser page.",
        );
      }
      const abortKey = `bridge-session-${randomUUID()}`;
      const abort = (): void => {
        void contents
          .executeJavaScript(`globalThis[${JSON.stringify(abortKey)}]?.abort()`)
          .catch(() => undefined);
      };
      init.signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await contents.executeJavaScript<PageSessionResponse>(
          `(() => {
            const isRecord = (${isRecord.toString()});
            return (${readSessionInPage.toString()})(
              ${JSON.stringify(endpoint)}, ${JSON.stringify(abortKey)},
              ${options.timeoutMs ?? DEFAULT_SESSION_PROBE_TIMEOUT_MS},
              ${MAX_SESSION_RESPONSE_BYTES},
              (${hasAuthenticatedIdentity.toString()}),
              (${boundedString.toString()})
            );
          })()`,
        );
        init.signal?.throwIfAborted();
        return new Response(result.body || null, {
          status: result.status,
          headers: result.headers,
        });
      } finally {
        init.signal?.removeEventListener("abort", abort);
      }
    },
    signal,
    options,
  );
}
