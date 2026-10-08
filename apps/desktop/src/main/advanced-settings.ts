export interface AdvancedSettings {
  readonly freshConversationPerTurn?: boolean;
  readonly autoApproveToolCalls?: boolean;
  readonly silenceTimeoutSeconds?: number;
  readonly startAtLogin?: boolean;
  readonly interactionMode?: "automatic" | "manual";
  readonly manualPro?: boolean;
}

export function parseAdvancedSettings(
  value: unknown,
): Required<AdvancedSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Advanced settings must be an object.");
  const row = value as Record<string, unknown>;
  for (const key of [
    "freshConversationPerTurn",
    "autoApproveToolCalls",
    "startAtLogin",
    "manualPro",
  ])
    if (row[key] !== undefined && typeof row[key] !== "boolean")
      throw new Error(`${key} must be a boolean.`);
  const seconds = row.silenceTimeoutSeconds ?? 0;
  if (
    !Number.isInteger(seconds) ||
    Number(seconds) < 0 ||
    Number(seconds) > 14400
  )
    throw new Error("Silence timeout must be 0–14400 seconds (0 disables it).");
  if (
    row.interactionMode !== undefined &&
    row.interactionMode !== "manual" &&
    row.interactionMode !== "automatic"
  )
    throw new Error("Interaction mode must be automatic or manual.");
  return {
    freshConversationPerTurn: row.freshConversationPerTurn === true,
    autoApproveToolCalls: row.autoApproveToolCalls === true,
    startAtLogin: row.startAtLogin === true,
    silenceTimeoutSeconds: Number(seconds),
    interactionMode: row.interactionMode === "manual" ? "manual" : "automatic",
    manualPro: row.manualPro === true,
  };
}

/** Repeated polls and heartbeats do not count as progress. */
export class SilenceWatchdog {
  #last = "";
  #changedAt: number;
  constructor(
    readonly seconds: number,
    now = Date.now(),
  ) {
    this.#changedAt = now;
  }
  observe(value: string, now = Date.now()): void {
    if (value !== this.#last) {
      this.#last = value;
      this.#changedAt = now;
    }
    if (this.seconds > 0 && now - this.#changedAt >= this.seconds * 1000)
      throw new Error(
        `ChatGPT made no observable progress for ${this.seconds} seconds. The turn was stopped.`,
      );
  }
}
