import { posix, win32 } from "node:path";

import type { ChatGptProjectSettings } from "./chatgpt-project-types.js";

export function normalizeProjectPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("請輸入 Codex 專案的完整資料夾路徑。");
  let path = value.trim();
  // Codex persists Windows extended-length paths; compare their ordinary
  // drive/UNC identity with the paths shown by the desktop sidebar.
  if (path.startsWith("\\\\?\\")) {
    const rest = path.slice(4);
    if (/^unc\\/i.test(rest)) path = "\\\\" + rest.slice(4);
    else if (/^[a-z]:[\\/]/i.test(rest)) path = rest;
  }
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(path);
  const api = windows ? win32 : posix;
  if (!api.isAbsolute(path)) throw new Error("Codex 專案路徑必須是絕對路徑。");
  const normalized = api.normalize(path);
  const root = api.parse(normalized).root;
  const result = normalized === root ? root : normalized.replace(/[\\/]+$/, "");
  return windows ? result.toLowerCase() : result;
}

/** The optional origin is supplied only by the owned browser fixture configuration. */
export function normalizeChatGptProjectUrl(
  value: unknown,
  baseUrl = "https://chatgpt.com/",
): string {
  if (typeof value !== "string")
    throw new Error("請貼上 ChatGPT Project 網址。");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("ChatGPT Project 網址無效。");
  }
  const base = new URL(baseUrl);
  if (
    !/^https?:$/.test(base.protocol) ||
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    !/^\/g\/g-p-[A-Za-z0-9-]+\/project\/?$/.test(url.pathname)
  )
    throw new Error(
      "請使用 ChatGPT Project 首頁網址（/g/g-p-…/project），不是對話或分享連結。",
    );
  return url.origin + url.pathname.replace(/\/$/, "");
}

export function parseChatGptProjectSettings(
  value: unknown,
): ChatGptProjectSettings {
  if (value === undefined) return { enabled: false };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("ChatGPT Project 設定無效。");
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== "boolean")
    throw new Error("ChatGPT Project 設定無效。");
  // Legacy manual folder/URL mappings are deliberately ignored. Automatic
  // routing uses the read-only Codex sidebar project identity instead.
  return { enabled: input.enabled };
}

export function projectUrlFromConversation(
  value: string,
  baseUrl: string,
): string | undefined {
  const url = new URL(value);
  const match = /^(\/g\/g-p-[A-Za-z0-9-]+)\/c\/[A-Za-z0-9-]+\/?$/.exec(
    url.pathname,
  );
  return match
    ? normalizeChatGptProjectUrl(url.origin + match[1] + "/project", baseUrl)
    : undefined;
}

export function assertProjectDestination(
  current: string,
  projectUrl: string | undefined,
  savedUrl?: string,
): void {
  if (!projectUrl) return;
  const project = new URL(projectUrl);
  const url = new URL(current);
  const prefix = project.pathname.replace(/\/project$/, "");
  const pathname = url.pathname.replace(/\/$/, "");
  if (
    url.origin === project.origin &&
    !url.username &&
    !url.password &&
    (pathname === project.pathname ||
      (pathname.startsWith(prefix + "/c/") &&
        /^[A-Za-z0-9-]+$/.test(pathname.slice(prefix.length + 3))) ||
      (savedUrl !== undefined && url.origin + url.pathname === savedUrl))
  )
    return;
  throw new Error(
    "無法確認 ChatGPT Project。請檢查登入帳號及 Project 存取權；尚未送出訊息。",
  );
}
