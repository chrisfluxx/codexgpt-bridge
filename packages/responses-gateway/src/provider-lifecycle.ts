import { randomUUID } from "node:crypto";

export type ProviderLifecycleState =
  "accepting" | "draining" | "drained" | "shutting-down";

export interface ProviderLifecycleStatus {
  readonly state: ProviderLifecycleState;
  readonly acceptingTurns: boolean;
  readonly activeHttpTurns: number;
  readonly activeBrowserTurns: number;
  readonly activeToolTurns: number;
  readonly drainId?: string;
  readonly drainingSince?: string;
}

export interface LifecycleLease {
  release(): void;
}

export class ProviderDrainingError extends Error {
  readonly code = "provider_draining";
  constructor() {
    super("CodexGPT Bridge is draining for a requested service operation.");
  }
}

export class ProviderLifecycleConflictError extends Error {
  readonly code = "provider_lifecycle_conflict";
}

type Counter = "http" | "browser" | "tool";

/** One synchronous admission gate owns all provider lifecycle counters. */
export class ProviderLifecycleController {
  #state: ProviderLifecycleState = "accepting";
  #drainId: string | undefined;
  #drainingSince: string | undefined;
  readonly #counts: Record<Counter, number> = {
    http: 0,
    browser: 0,
    tool: 0,
  };

  status(): ProviderLifecycleStatus {
    return {
      state: this.#state,
      acceptingTurns: this.#state === "accepting",
      activeHttpTurns: this.#counts.http,
      activeBrowserTurns: this.#counts.browser,
      activeToolTurns: this.#counts.tool,
      ...(this.#drainId ? { drainId: this.#drainId } : {}),
      ...(this.#drainingSince ? { drainingSince: this.#drainingSince } : {}),
    };
  }

  acquireHttpTurn(): LifecycleLease {
    if (this.#state !== "accepting") throw new ProviderDrainingError();
    return this.#acquire("http");
  }

  acquireBrowserTurn(): LifecycleLease {
    return this.#acquire("browser");
  }

  acquireToolTurn(): LifecycleLease {
    return this.#acquire("tool");
  }

  drain(): ProviderLifecycleStatus {
    if (this.#state === "shutting-down") {
      throw new ProviderLifecycleConflictError(
        "The provider is already shutting down.",
      );
    }
    if (this.#state === "accepting") {
      this.#state = "draining";
      this.#drainId = `drain_${randomUUID()}`;
      this.#drainingSince = new Date().toISOString();
      this.#settleDrain();
    }
    return this.status();
  }

  resume(drainId: string): ProviderLifecycleStatus {
    this.#assertDrainOwner(drainId);
    if (this.#state === "shutting-down") {
      throw new ProviderLifecycleConflictError(
        "A shutting-down provider cannot be resumed.",
      );
    }
    this.#state = "accepting";
    this.#drainId = undefined;
    this.#drainingSince = undefined;
    return this.status();
  }

  beginShutdown(drainId: string): ProviderLifecycleStatus {
    this.#assertDrainOwner(drainId);
    this.#settleDrain();
    if (
      this.#state !== "drained" ||
      this.#counts.http !== 0 ||
      this.#counts.browser !== 0 ||
      this.#counts.tool !== 0
    ) {
      throw new ProviderLifecycleConflictError(
        "The provider must be drained and idle before shutdown.",
      );
    }
    this.#state = "shutting-down";
    return this.status();
  }

  #assertDrainOwner(drainId: string): void {
    if (!drainId || this.#drainId !== drainId) {
      throw new ProviderLifecycleConflictError(
        "The drain transaction does not own the provider lifecycle.",
      );
    }
  }

  #acquire(counter: Counter): LifecycleLease {
    this.#counts[counter] += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#counts[counter] = Math.max(0, this.#counts[counter] - 1);
        this.#settleDrain();
      },
    };
  }

  #settleDrain(): void {
    if (
      this.#state === "draining" &&
      this.#counts.http === 0 &&
      this.#counts.browser === 0 &&
      this.#counts.tool === 0
    ) {
      this.#state = "drained";
    }
  }
}

export interface NativeTurnIdentity {
  readonly threadId: string;
  readonly turnId: string;
}

export interface TurnInterruptResult {
  readonly matched: number;
  readonly alreadyInterrupted: boolean;
}

interface InterruptedTurn {
  readonly reason: Error;
  interruptedAt: number;
}

const INTERRUPT_TTL_MS = 5 * 60_000;
const MAX_INTERRUPTED_TURNS = 10_000;

function turnKey(identity: NativeTurnIdentity): string {
  return `${identity.threadId}\0${identity.turnId}`;
}

/** Exact native turn cancellation, including interrupts that arrive before registration. */
export class TurnOwnershipRegistry {
  readonly #active = new Map<string, Set<AbortController>>();
  readonly #interrupted = new Map<string, InterruptedTurn>();

  register(
    identity: NativeTurnIdentity,
    controller: AbortController,
  ): LifecycleLease {
    this.#prune();
    const key = turnKey(identity);
    const interrupted = this.#interrupted.get(key);
    if (interrupted) controller.abort(interrupted.reason);
    let owners = this.#active.get(key);
    if (!owners) {
      owners = new Set();
      this.#active.set(key, owners);
    }
    owners.add(controller);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        owners!.delete(controller);
        if (owners!.size === 0) this.#active.delete(key);
      },
    };
  }

  interrupt(
    identity: NativeTurnIdentity,
    reason = new DOMException("Codex turn interrupted.", "AbortError"),
  ): TurnInterruptResult {
    this.#prune();
    const key = turnKey(identity);
    const previous = this.#interrupted.get(key);
    if (previous) previous.interruptedAt = Date.now();
    else
      this.#interrupted.set(key, {
        reason: reason instanceof Error ? reason : new Error(String(reason)),
        interruptedAt: Date.now(),
      });
    const owners = this.#active.get(key);
    for (const controller of owners ?? []) {
      controller.abort(previous?.reason ?? reason);
    }
    this.#boundInterruptedTurns();
    return {
      matched: owners?.size ?? 0,
      alreadyInterrupted: previous !== undefined,
    };
  }

  #prune(now = Date.now()): void {
    for (const [key, value] of this.#interrupted) {
      if (value.interruptedAt + INTERRUPT_TTL_MS <= now)
        this.#interrupted.delete(key);
    }
    this.#boundInterruptedTurns();
  }

  #boundInterruptedTurns(): void {
    while (this.#interrupted.size > MAX_INTERRUPTED_TURNS) {
      const oldest = this.#interrupted.keys().next().value;
      if (oldest === undefined) break;
      this.#interrupted.delete(oldest);
    }
  }
}
