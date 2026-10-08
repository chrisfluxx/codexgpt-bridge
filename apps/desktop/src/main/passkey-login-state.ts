import type { CookiesSetDetails } from "electron";

const CHATGPT_ORIGIN = "https://chatgpt.com";
const MAX_COOKIES = 4_096;
const MAX_ORIGINS = 128;
const MAX_LOCAL_STORAGE_ENTRIES = 4_096;
const MAX_STRING_CHARS = 2 * 1024 * 1024;

export interface PasskeyLoginState {
  readonly cookies: readonly CookiesSetDetails[];
  readonly localStorage: readonly {
    readonly name: string;
    readonly value: string;
  }[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Passkey login returned an invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function boundedString(
  value: unknown,
  label: string,
  allowEmpty = true,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`Passkey login state has an invalid ${label}.`);
  }
  if (value.length > MAX_STRING_CHARS) {
    throw new Error(`Passkey login state ${label} is too large.`);
  }
  return value;
}

function allowedCookieDomain(
  domain: string,
): { hostname: string; includeDomain: boolean } | undefined {
  const includeDomain = domain.startsWith(".");
  const candidate = includeDomain ? domain.slice(1) : domain;
  if (!candidate || candidate.startsWith(".")) return undefined;
  const hostname = candidate.toLowerCase();
  let parsed: URL;
  try {
    parsed = new URL(`https://${hostname}/`);
  } catch {
    return undefined;
  }
  if (
    parsed.hostname !== hostname ||
    parsed.host !== hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    return undefined;
  }
  if (
    hostname !== "chatgpt.com" &&
    !hostname.endsWith(".chatgpt.com") &&
    hostname !== "openai.com" &&
    !hostname.endsWith(".openai.com")
  ) {
    return undefined;
  }
  return { hostname, includeDomain };
}

export function validatePasskeyLoginState(value: unknown): PasskeyLoginState {
  const state = record(value, "storage-state object");
  if (!Array.isArray(state.cookies) || state.cookies.length > MAX_COOKIES) {
    throw new Error("Passkey login returned an invalid cookie collection.");
  }
  if (!Array.isArray(state.origins) || state.origins.length > MAX_ORIGINS) {
    throw new Error("Passkey login returned an invalid origin collection.");
  }

  const sameSiteValues = new Map<string, CookiesSetDetails["sameSite"]>([
    ["Strict", "strict"],
    ["Lax", "lax"],
    ["None", "no_restriction"],
  ]);
  const cookies: CookiesSetDetails[] = [];
  for (const candidate of state.cookies) {
    const raw = record(candidate, "cookie");
    if (raw.partitionKey !== undefined) continue;
    const domain = boundedString(raw.domain, "cookie domain", false);
    const allowedDomain = allowedCookieDomain(domain);
    if (!allowedDomain) continue;
    const name = boundedString(raw.name, "cookie name", false);
    const cookieValue = boundedString(raw.value, "cookie value");
    const cookiePath = boundedString(raw.path, "cookie path", false);
    const unsafePathCharacter = [...cookiePath].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 || "?#".includes(character);
    });
    if (!cookiePath.startsWith("/") || unsafePathCharacter) {
      throw new Error("Passkey login state has an invalid cookie path.");
    }
    if (typeof raw.secure !== "boolean" || typeof raw.httpOnly !== "boolean") {
      throw new Error(
        "Passkey login state has invalid cookie security attributes.",
      );
    }
    const sameSite =
      typeof raw.sameSite === "string"
        ? sameSiteValues.get(raw.sameSite)
        : undefined;
    if (!sameSite) {
      throw new Error(
        "Passkey login state has an invalid cookie SameSite value.",
      );
    }
    if (typeof raw.expires !== "number" || !Number.isFinite(raw.expires)) {
      throw new Error("Passkey login state has an invalid cookie expiry.");
    }
    const { hostname, includeDomain } = allowedDomain;
    cookies.push({
      url: new URL(`https://${hostname}${cookiePath}`).toString(),
      name,
      value: cookieValue,
      ...(includeDomain ? { domain: `.${hostname}` } : {}),
      path: cookiePath,
      secure: raw.secure,
      httpOnly: raw.httpOnly,
      sameSite,
      ...(raw.expires > 0 ? { expirationDate: raw.expires } : {}),
    });
  }
  if (cookies.length === 0) {
    throw new Error("Passkey login state contains no ChatGPT/OpenAI cookies.");
  }

  const localStorage: { name: string; value: string }[] = [];
  for (const candidate of state.origins) {
    const raw = record(candidate, "origin state");
    if (typeof raw.origin !== "string") {
      throw new Error("Passkey login returned an invalid origin state.");
    }
    if (raw.origin !== CHATGPT_ORIGIN) continue;
    if (
      !Array.isArray(raw.localStorage) ||
      raw.localStorage.length > MAX_LOCAL_STORAGE_ENTRIES
    ) {
      throw new Error("Passkey login returned invalid ChatGPT local storage.");
    }
    for (const candidateEntry of raw.localStorage) {
      const entry = record(candidateEntry, "ChatGPT local-storage entry");
      localStorage.push({
        name: boundedString(entry.name, "local-storage name"),
        value: boundedString(entry.value, "local-storage value"),
      });
    }
  }
  if (localStorage.length > MAX_LOCAL_STORAGE_ENTRIES) {
    throw new Error("Passkey login returned too many local-storage entries.");
  }
  return { cookies, localStorage };
}
