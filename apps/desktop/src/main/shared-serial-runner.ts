function abortError(): DOMException {
  return new DOMException("Provider turn was cancelled.", "AbortError");
}

function isReconnectableAbort(signal: AbortSignal): boolean {
  return (
    signal.reason instanceof DOMException &&
    signal.reason.name === "NetworkError"
  );
}

function waitForQueue(
  previous: Promise<void>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error === undefined) resolvePromise();
      else rejectPromise(error);
    };
    const onAbort = (): void => finish(abortError());
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `ChatGPT Web turn queue was busy for more than ${Math.ceil(timeoutMs / 1_000)} seconds.`,
          ),
        ),
      timeoutMs,
    );
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void previous.then(
      () => finish(),
      (error: unknown) => finish(error),
    );
  });
}

interface SharedEntry<T> {
  readonly controller: AbortController;
  promise: Promise<T>;
  subscribers: number;
  started: boolean;
  settled: boolean;
  orphanTimer?: NodeJS.Timeout;
  retentionTimer?: NodeJS.Timeout;
}

/**
 * Serializes browser mutations while allowing reconnects for the same logical
 * turn to share one in-flight result. Cancelled waiters are removed before
 * they can consume the browser lock.
 */
export class SharedSerialRunner<T> {
  readonly #entries = new Map<string, SharedEntry<T>>();
  #tail: Promise<void> = Promise.resolve();
  hasReplay(key: string): boolean {
    const entry = this.#entries.get(key);
    return entry !== undefined && !entry.controller.signal.aborted;
  }

  constructor(
    private readonly queueWaitMs = 2 * 60_000,
    private readonly reconnectGraceMs = 15_000,
    private readonly settledRetentionMs = 5 * 60_000,
    private readonly retainFailure: (error: unknown) => boolean = () => false,
  ) {
    if (!Number.isFinite(queueWaitMs) || queueWaitMs <= 0) {
      throw new Error("Queue wait time must be a positive finite number.");
    }
    if (!Number.isFinite(reconnectGraceMs) || reconnectGraceMs < 0) {
      throw new Error(
        "Reconnect grace time must be a non-negative finite number.",
      );
    }
    if (!Number.isFinite(settledRetentionMs) || settledRetentionMs < 0) {
      throw new Error(
        "Settled retention time must be a non-negative finite number.",
      );
    }
  }

  run(
    key: string,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let entry = this.#entries.get(key);
    if (entry?.controller.signal.aborted && entry.subscribers === 0) {
      // A retry must wait behind cleanup, but must not subscribe to an already-aborted result.
      if (entry.retentionTimer !== undefined)
        clearTimeout(entry.retentionTimer);
      this.#entries.delete(key);
      entry = undefined;
    }
    if (entry === undefined) {
      const controller = new AbortController();
      const created: SharedEntry<T> = {
        controller,
        promise: Promise.resolve(undefined as T),
        subscribers: 0,
        started: false,
        settled: false,
      };
      created.promise = this.#enqueue(controller.signal, async (runSignal) => {
        created.started = true;
        return operation(runSignal);
      })
        .catch((error: unknown) => {
          // Deterministic pre-submit failures may be replayed to transport reconnects.
          // Transfer/tool failures and queue timeouts remain immediately retryable.
          if (!this.retainFailure(error) && this.#entries.get(key) === created)
            this.#entries.delete(key);
          throw error;
        })
        .finally(() => {
          created.settled = true;
          if (created.subscribers === 0) this.#retainThenDelete(key, created);
        });
      entry = created;
      this.#entries.set(key, entry);
    }
    return this.#subscribe(entry, signal);
  }

  async #enqueue(
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const previous = this.#tail;
    let releaseQueue: (() => void) | undefined;
    const gate = new Promise<void>((resolvePromise) => {
      releaseQueue = resolvePromise;
    });
    this.#tail = previous.catch(() => undefined).then(() => gate);
    let acquired = false;
    try {
      await waitForQueue(previous, signal, this.queueWaitMs);
      acquired = true;
      if (signal.aborted) throw abortError();
      return await operation(signal);
    } finally {
      if (acquired) releaseQueue?.();
      else {
        void previous.then(
          () => releaseQueue?.(),
          () => releaseQueue?.(),
        );
      }
    }
  }

  #subscribe(entry: SharedEntry<T>, signal: AbortSignal): Promise<T> {
    if (entry.orphanTimer !== undefined) {
      clearTimeout(entry.orphanTimer);
      delete entry.orphanTimer;
    }
    if (entry.retentionTimer !== undefined) {
      clearTimeout(entry.retentionTimer);
      delete entry.retentionTimer;
    }
    if (signal.aborted) {
      if (entry.subscribers === 0) {
        this.#orphan(entry, isReconnectableAbort(signal));
      }
      return Promise.reject(abortError());
    }
    entry.subscribers += 1;
    return new Promise<T>((resolvePromise, rejectPromise) => {
      let active = true;
      const cleanup = (reconnectable: boolean): boolean => {
        if (!active) return false;
        active = false;
        signal.removeEventListener("abort", onAbort);
        entry.subscribers -= 1;
        if (entry.subscribers === 0) this.#orphan(entry, reconnectable);
        return true;
      };
      const onAbort = (): void => {
        if (cleanup(isReconnectableAbort(signal))) rejectPromise(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void entry.promise.then(
        (value) => {
          if (cleanup(true)) resolvePromise(value);
        },
        (error: unknown) => {
          if (cleanup(true)) rejectPromise(error);
        },
      );
    });
  }

  #orphan(entry: SharedEntry<T>, reconnectable: boolean): void {
    if (entry.settled) {
      const pair = [...this.#entries].find(
        ([, candidate]) => candidate === entry,
      );
      if (pair !== undefined) this.#retainThenDelete(pair[0], entry);
      return;
    }
    if (!reconnectable) {
      entry.controller.abort();
      return;
    }
    // A queued operation has not mutated the browser and can be cancelled immediately. Once the
    // browser operation starts, preserve it briefly so the normal disconnect-then-reconnect gap
    // does not turn one native Codex turn into two ChatGPT submissions.
    if (!entry.started || this.reconnectGraceMs === 0) {
      entry.controller.abort();
      return;
    }
    if (entry.orphanTimer !== undefined) return;
    entry.orphanTimer = setTimeout(() => {
      delete entry.orphanTimer;
      if (entry.subscribers === 0 && !entry.settled) entry.controller.abort();
    }, this.reconnectGraceMs);
    entry.orphanTimer.unref();
  }

  #retainThenDelete(key: string, entry: SharedEntry<T>): void {
    if (entry.retentionTimer !== undefined) return;
    const remove = (): void => {
      delete entry.retentionTimer;
      if (entry.subscribers === 0 && this.#entries.get(key) === entry) {
        this.#entries.delete(key);
      }
    };
    if (this.settledRetentionMs === 0) {
      remove();
      return;
    }
    entry.retentionTimer = setTimeout(remove, this.settledRetentionMs);
    entry.retentionTimer.unref();
  }
}
