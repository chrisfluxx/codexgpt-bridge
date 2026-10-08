import { PreparationError } from "./completion-diagnostics.js";
import { delay } from "./browser-delay.js";

/** One parent plus four concurrent child tasks, matching the proven Web harness limit. */
export const BRIDGE_WEB_TASK_CONCURRENCY = 5;

export interface TurnPoolStatus {
  readonly active: number;
  readonly queued: number;
  readonly capacity: number;
  readonly cooldownSeconds: number;
}

export class ChatGptRateLimitError extends PreparationError {
  override readonly code = "chatgpt_web_rate_limited";
  constructor(
    readonly retryAfterSeconds: number,
    readonly afterSubmission = false,
    readonly rateLimitSource:
      "application-notice" | "shared-cooldown" = "shared-cooldown",
  ) {
    super(
      `ChatGPT Web is temporarily rate limited. Bridge has paused new browser submissions for ${retryAfterSeconds} seconds; queued tasks will resume automatically after the cooldown.`,
      "web-rate-limited",
    );
    this.name = "ChatGptRateLimitError";
  }
}

/** Fair, cancellation-aware limit with one cooldown shared by all Web tasks. */
export class TurnPool {
  #active = 0;
  #cooldownUntil = 0;
  #strikes = 0;
  readonly #queue: Array<{
    start: () => void;
    notify?: (ahead: number) => void;
  }> = [];
  #notify(): void {
    this.#queue.forEach((entry, index) => entry.notify?.(this.#active + index));
  }
  constructor(
    private readonly maximum = 3,
    private readonly now: () => number = Date.now,
    private readonly cooldownBaseMs = 120_000,
    private readonly maximumCooldownMs = 900_000,
  ) {}

  status(): TurnPoolStatus {
    return {
      active: this.#active,
      queued: this.#queue.length,
      capacity: this.maximum,
      cooldownSeconds: Math.max(
        0,
        Math.ceil((this.#cooldownUntil - this.now()) / 1_000),
      ),
    };
  }

  assertAvailable(): void {
    const remaining = this.#cooldownUntil - this.now();
    if (remaining > 0)
      throw new ChatGptRateLimitError(Math.ceil(remaining / 1_000));
  }

  rateLimited(): ChatGptRateLimitError {
    const now = this.now();
    // Reconnects and already-running pages must not extend the same cooldown.
    if (this.#cooldownUntil <= now) {
      this.#strikes = Math.min(this.#strikes + 1, 4);
      this.#cooldownUntil =
        now +
        Math.min(
          this.cooldownBaseMs * 2 ** (this.#strikes - 1),
          this.maximumCooldownMs,
        );
    }
    return new ChatGptRateLimitError(
      Math.ceil((this.#cooldownUntil - now) / 1_000),
      false,
      "application-notice",
    );
  }

  async run<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
    onQueue?: (ahead: number) => void,
    onCooldown?: (seconds: number) => void,
  ): Promise<T> {
    signal.throwIfAborted();
    // Register before waiting through a shared cooldown. Letting every caller
    // wait first makes them race when the timer expires and breaks FIFO order.
    const initialRemaining = this.#cooldownUntil - this.now();
    if (initialRemaining > 0) onCooldown?.(Math.ceil(initialRemaining / 1_000));
    await new Promise<void>((resolve, reject) => {
      let acquired = false;
      const start = (): void => {
        if (signal.aborted) {
          cancel();
          return;
        }
        acquired = true;
        signal.removeEventListener("abort", cancel);
        this.#active++;
        onQueue?.(0);
        resolve();
      };
      const cancel = (): void => {
        if (acquired) return;
        const index = this.#queue.findIndex((entry) => entry.start === start);
        if (index >= 0) this.#queue.splice(index, 1);
        this.#notify();
        signal.removeEventListener("abort", cancel);
        reject(new DOMException("Queued Web task cancelled.", "AbortError"));
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      else if (this.#active < this.maximum) start();
      else {
        this.#queue.push({ start, ...(onQueue ? { notify: onQueue } : {}) });
        this.#notify();
      }
    });
    try {
      signal.throwIfAborted();
      // A task may have waited in the capacity queue while another task began
      // the shared cooldown. Hold it here instead of turning a temporary Web
      // limit into a terminal Codex task failure.
      await this.waitUntilAvailable(signal, onCooldown);
      const result = await operation();
      if (this.#cooldownUntil <= this.now()) this.#strikes = 0;
      return result;
    } finally {
      this.#active--;
      this.#queue.shift()?.start();
      this.#notify();
    }
  }

  async waitUntilAvailable(
    signal: AbortSignal,
    onCooldown?: (seconds: number) => void,
  ): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const remaining = this.#cooldownUntil - this.now();
      if (remaining <= 0) return;
      onCooldown?.(Math.ceil(remaining / 1_000));
      await delay(remaining, signal);
    }
  }
}
