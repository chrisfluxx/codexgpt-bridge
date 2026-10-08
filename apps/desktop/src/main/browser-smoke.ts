import type { BridgeWebMode } from "@codexgpt-bridge/responses-gateway";

export const BROWSER_SMOKE_PROMPT = "Reply with exactly: CODEX WEB GPT READY";
export const BROWSER_SMOKE_EXPECTED = "CODEX WEB GPT READY";

export interface BrowserSmokeCheck {
  readonly id:
    | "private-session"
    | "composer"
    | "model-surface"
    | "temporary-chat"
    | "round-trip";
  readonly label: string;
  readonly passed: true;
}

export interface BrowserSmokeResult {
  readonly ok: true;
  readonly mode: BridgeWebMode;
  readonly response: typeof BROWSER_SMOKE_EXPECTED;
  readonly checks: readonly BrowserSmokeCheck[];
}

export function selectBrowserSmokeMode(
  availableModes: readonly BridgeWebMode[],
): BridgeWebMode {
  if (availableModes.includes("high")) return "high";
  if (availableModes.includes("luna")) return "luna";
  const fallback = availableModes[0];
  if (!fallback) {
    throw new Error(
      "ChatGPT did not expose a supported model for the browser smoke test.",
    );
  }
  return fallback;
}

export function completeBrowserSmoke(
  mode: BridgeWebMode,
  response: unknown,
): BrowserSmokeResult {
  if (typeof response !== "string") {
    throw new Error("Browser smoke test returned non-text output.");
  }
  const normalized = response.trim();
  if (normalized !== BROWSER_SMOKE_EXPECTED) {
    throw new Error(
      `Browser smoke test returned an unexpected answer (${JSON.stringify(normalized.slice(0, 200))}).`,
    );
  }
  return {
    ok: true,
    mode,
    response: BROWSER_SMOKE_EXPECTED,
    checks: [
      {
        id: "private-session",
        label: "Private ChatGPT server session verified",
        passed: true,
      },
      { id: "composer", label: "Composer ready", passed: true },
      {
        id: "model-surface",
        label: `Model surface resolved (${mode})`,
        passed: true,
      },
      {
        id: "temporary-chat",
        label: "Temporary Chat verified",
        passed: true,
      },
      {
        id: "round-trip",
        label: "Exact browser response completed",
        passed: true,
      },
    ],
  };
}
