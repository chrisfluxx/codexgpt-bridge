import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ProviderDrainingError,
  ProviderLifecycleConflictError,
  ProviderLifecycleController,
  TurnOwnershipRegistry,
} from "./provider-lifecycle.js";

describe("provider lifecycle", () => {
  it("atomically closes admission, drains every lease and resumes only its owner", () => {
    const lifecycle = new ProviderLifecycleController();
    const http = lifecycle.acquireHttpTurn();
    const browser = lifecycle.acquireBrowserTurn();
    const draining = lifecycle.drain();

    assert.equal(draining.state, "draining");
    assert.equal(draining.activeHttpTurns, 1);
    assert.equal(draining.activeBrowserTurns, 1);
    assert.throws(() => lifecycle.acquireHttpTurn(), ProviderDrainingError);
    assert.throws(
      () => lifecycle.resume("drain_not_owner"),
      ProviderLifecycleConflictError,
    );

    http.release();
    http.release();
    assert.equal(lifecycle.status().state, "draining");
    browser.release();
    assert.equal(lifecycle.status().state, "drained");
    assert.equal(lifecycle.status().activeHttpTurns, 0);
    assert.equal(lifecycle.status().activeBrowserTurns, 0);
    assert.equal(lifecycle.resume(draining.drainId!).state, "accepting");
  });

  it("requires a verified idle drain before shutdown", () => {
    const lifecycle = new ProviderLifecycleController();
    const active = lifecycle.acquireHttpTurn();
    const drain = lifecycle.drain();
    assert.throws(
      () => lifecycle.beginShutdown(drain.drainId!),
      /drained and idle/u,
    );
    active.release();
    assert.equal(
      lifecycle.beginShutdown(drain.drainId!).state,
      "shutting-down",
    );
  });
});

describe("exact turn ownership", () => {
  it("interrupts only the exact turn and keeps duplicate interrupts idempotent", () => {
    const registry = new TurnOwnershipRegistry();
    const first = new AbortController();
    const newer = new AbortController();
    registry.register(
      { threadId: "thread_exact", turnId: "turn_first" },
      first,
    );
    registry.register(
      { threadId: "thread_exact", turnId: "turn_newer" },
      newer,
    );

    const interrupted = registry.interrupt({
      threadId: "thread_exact",
      turnId: "turn_first",
    });
    assert.equal(interrupted.matched, 1);
    assert.equal(interrupted.alreadyInterrupted, false);
    assert.equal(first.signal.aborted, true);
    assert.equal(newer.signal.aborted, false);
    assert.equal(
      registry.interrupt({
        threadId: "thread_exact",
        turnId: "turn_first",
      }).alreadyInterrupted,
      true,
    );
  });

  it("remembers an interrupt that arrives before turn registration", () => {
    const registry = new TurnOwnershipRegistry();
    const identity = {
      threadId: "thread_early",
      turnId: "turn_early",
    } as const;
    assert.equal(registry.interrupt(identity).matched, 0);
    const controller = new AbortController();
    registry.register(identity, controller);
    assert.equal(controller.signal.aborted, true);
    assert.equal((controller.signal.reason as Error).name, "AbortError");
  });
});
