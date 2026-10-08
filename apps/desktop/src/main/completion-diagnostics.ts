import { readFile, stat } from "node:fs/promises";
import { writeDurableJson } from "./durable-json.js";
import type { ChatGptBusySource } from "./chatgpt-observation.js";
import {
  classifyOperationFailure,
  type PreparationFailureCode,
} from "./operation-failure.js";

export class PreparationError extends Error {
  readonly code: string = "chatgpt_web_preparation_failed";
  constructor(
    message: string,
    readonly diagnosticCode:
      | PreparationFailureCode
      | "cancelled"
      | "timeout"
      | "error"
      | "web-rate-limited",
  ) {
    super(message);
  }
}

interface PreparationStep {
  stage: string;
  startedMs: number;
  elapsedMs: number;
  outcome: "completed" | "failed";
}

export interface CompletionDiagnostic {
  readonly version: 1;
  readonly operationId: string;
  readonly startedAt: string;
  readonly outcome: string;
  readonly elapsedMs: number;
  readonly milestones: Readonly<Record<string, number>>;
  readonly events?: readonly { stage: string; elapsedMs: number }[];
  readonly eventCounts?: Readonly<Record<string, number>>;
  readonly preparationSteps?: readonly PreparationStep[];
  readonly failure?: { readonly stage: string; readonly code: string };
  readonly observations: readonly {
    elapsedMs: number;
    reason: string;
    messageId: string;
    generationState: string;
    terminalConfirmed: boolean;
    busySources: readonly ChatGptBusySource[];
  }[];
}

/** No prompts, bodies, arbitrary DOM labels, cookies, URLs or bearer tokens. */
export class CompletionTrace {
  readonly started = Date.now();
  readonly milestones: Record<string, number> = {};
  readonly events: { stage: string; elapsedMs: number }[] = [];
  readonly eventCounts: Record<string, number> = {};
  readonly observations: CompletionDiagnostic["observations"][number][] = [];
  #text = "";
  #lastSignature = "";
  #lastObservation = 0;
  readonly #preparationSteps: PreparationStep[] = [];
  #failure: CompletionDiagnostic["failure"];
  #failureCause: unknown;
  constructor(private readonly operationId: string) {}
  fail(error: unknown, stage: string): void {
    if (error instanceof Error && "rateLimitSource" in error) {
      if (error.rateLimitSource === "application-notice")
        this.event("rate-limit-application-notice");
      if (error.rateLimitSource === "shared-cooldown")
        this.event("rate-limit-shared-cooldown");
    }
    this.#failure ??= {
      stage: /^[a-z][a-z0-9_-]{0,63}$/.test(stage) ? stage : "browser-step",
      code: classifyOperationFailure(error),
    };
  }
  async measure<T>(stage: string, work: () => Promise<T>): Promise<T> {
    // Callers pass fixed stage names, never DOM labels, errors, prompts or URLs.
    const safeStage = /^[a-z][a-z0-9-]{0,63}$/.test(stage)
      ? stage
      : "browser-step";
    const started = Date.now();
    let outcome: PreparationStep["outcome"] = "completed";
    try {
      return await work();
    } catch (error) {
      outcome = "failed";
      // Preserve the deepest failing step while the same error crosses wrappers.
      if (!this.#failure || error !== this.#failureCause) {
        this.#failureCause = error;
        this.#failure = {
          stage: safeStage,
          code:
            error instanceof PreparationError
              ? error.diagnosticCode
              : error instanceof Error && error.name === "AbortError"
                ? "cancelled"
                : error instanceof Error && error.name === "TimeoutError"
                  ? "timeout"
                  : "error",
        };
      }
      throw error;
    } finally {
      this.#preparationSteps.push({
        stage: safeStage,
        startedMs: started - this.started,
        elapsedMs: Date.now() - started,
        outcome,
      });
      if (this.#preparationSteps.length > 256)
        this.#preparationSteps.splice(0, 1);
    }
  }
  mark(stage: string, now = Date.now()): void {
    this.milestones[stage] ??= now - this.started;
  }
  event(stage: string, now = Date.now()): void {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(stage)) return;
    this.eventCounts[stage] = (this.eventCounts[stage] ?? 0) + 1;
    this.events.push({ stage, elapsedMs: now - this.started });
    if (this.events.length > 128) this.events.shift();
  }
  observe(
    value: {
      text: string;
      assistantMessageId: string;
      generationState: string;
      terminalConfirmed: boolean;
      busySources: readonly ChatGptBusySource[];
    },
    reason: string,
    now = Date.now(),
  ): void {
    if (value.text) this.mark("first-content", now);
    if (value.text !== this.#text) {
      this.milestones["last-content-change"] = now - this.started;
      this.#text = value.text;
    }
    if (value.terminalConfirmed) this.mark("terminal-confirmed", now);
    const safeId = (value: string): string =>
      /^[\w:-]{1,128}$/.test(value) ? value : "unavailable";
    const row = {
      reason,
      messageId: safeId(value.assistantMessageId),
      generationState: value.generationState,
      terminalConfirmed: value.terminalConfirmed,
      busySources: value.busySources.map((source) => ({
        ...source,
        owner: safeId(source.owner),
      })),
    };
    const signature = JSON.stringify(row);
    if (
      signature === this.#lastSignature &&
      now - this.#lastObservation < 10_000
    )
      return;
    this.#lastSignature = signature;
    this.#lastObservation = now;
    this.observations.push({ elapsedMs: now - this.started, ...row });
    if (this.observations.length > 128) this.observations.splice(1, 1);
  }
  finish(outcome: string): CompletionDiagnostic {
    this.#text = "";
    return {
      version: 1,
      operationId: this.operationId,
      startedAt: new Date(this.started).toISOString(),
      outcome,
      elapsedMs: Date.now() - this.started,
      milestones: this.milestones,
      events: this.events,
      eventCounts: this.eventCounts,
      preparationSteps: this.#preparationSteps,
      ...(["failed", "cancelled"].includes(outcome) && this.#failure
        ? { failure: this.#failure }
        : {}),
      observations: this.observations,
    };
  }
}

export class CompletionDiagnosticStore {
  #tail: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}
  record(row: CompletionDiagnostic): Promise<void> {
    const pending = this.#tail
      .catch(() => undefined)
      .then(async () => {
        let rows: CompletionDiagnostic[] = [];
        try {
          if ((await stat(this.file)).size > 4_000_000)
            throw new Error("Completion diagnostics exceeded the size limit.");
          const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
          if (!Array.isArray(parsed))
            throw new Error("Invalid completion diagnostics.");
          rows = parsed.filter((entry) => entry?.version === 1);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        rows.push(row);
        rows = rows.slice(-100);
        let text = JSON.stringify(rows);
        while (text.length > 2_000_000 && rows.length > 1) {
          rows.shift();
          text = JSON.stringify(rows);
        }
        await writeDurableJson(this.file, text + "\n");
      });
    this.#tail = pending;
    return pending;
  }
}
