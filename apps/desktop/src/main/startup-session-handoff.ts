import type { Session } from "electron";
import { validatePasskeyLoginState } from "./passkey-login-state.js";

/** An explicitly supplied, one-use local handoff preserves session-only cookies. */
export async function importStartupChatGptSession(
  browserSession: () => Session,
  portValue: string | undefined,
  token: string | undefined,
): Promise<void> {
  if (portValue === undefined && token === undefined) return;
  const port = Number(portValue);
  if (
    !portValue ||
    !/^\d+$/u.test(portValue) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !token ||
    !/^[a-f0-9]{64}$/u.test(token)
  )
    throw new Error("The startup ChatGPT session handoff is invalid.");
  try {
    const response = await fetch(`http://127.0.0.1:${port}/session`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Session handoff was not accepted.");
    const input = await response.text();
    if (input.length > 8 * 1024 * 1024)
      throw new Error("Session handoff exceeded its input limit.");
    const state = validatePasskeyLoginState(JSON.parse(input));
    const owned = browserSession();
    for (const cookie of state.cookies) await owned.cookies.set(cookie);
    await owned.cookies.flushStore();
    const accepted = await fetch(`http://127.0.0.1:${port}/ready`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!accepted.ok) throw new Error("Session handoff was not acknowledged.");
  } catch {
    // Never include response content, cookie values or the handoff nonce.
    throw new Error("The startup ChatGPT session handoff failed.");
  }
}
