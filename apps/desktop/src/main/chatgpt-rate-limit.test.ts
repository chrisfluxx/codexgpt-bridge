import assert from "node:assert/strict";
import { it } from "node:test";
import {
  BRIDGE_WEB_TASK_CONCURRENCY,
  TurnPool,
  ChatGptRateLimitError,
} from "./turn-pool.js";

it("reports bounded active, queued, capacity and cooldown state", async () => {
  let now = 1_000;
  const pool = new TurnPool(1, () => now, 5_000, 5_000);
  assert.deepEqual(pool.status(), {
    active: 0,
    queued: 0,
    capacity: 1,
    cooldownSeconds: 0,
  });

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = pool.run(new AbortController().signal, async () => {
    await gate;
    return "first";
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = pool.run(new AbortController().signal, async () => "second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pool.status(), {
    active: 1,
    queued: 1,
    capacity: 1,
    cooldownSeconds: 0,
  });

  release();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  pool.rateLimited();
  assert.equal(pool.status().cooldownSeconds, 5);
  now += 5_000;
  assert.equal(pool.status().cooldownSeconds, 0);
});

it("starts a Bridge child task while its parent Web turn is still active", async () => {
  const pool = new TurnPool(BRIDGE_WEB_TASK_CONCURRENCY);
  const controller = new AbortController();
  let releaseParent!: () => void;
  const parentGate = new Promise<void>((resolve) => {
    releaseParent = resolve;
  });
  let parentStarted = false;
  let childStarted = false;
  const parent = pool.run(controller.signal, async () => {
    parentStarted = true;
    await parentGate;
    return "PARENT_OK";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(parentStarted, true);
  const child = pool.run(controller.signal, async () => {
    childStarted = true;
    return "CHILD_OK";
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(childStarted, true);
    assert.equal(await child, "CHILD_OK");
  } finally {
    releaseParent();
    await Promise.allSettled([parent, child]);
  }
  assert.equal(await parent, "PARENT_OK");
});

it("holds every new task during cooldown and resumes it automatically", async () => {
  const pool = new TurnPool(1, Date.now, 20, 20);
  assert.equal(pool.rateLimited().retryAfterSeconds, 1);
  let calls = 0;
  const pending = Array.from({ length: 5 }, () =>
    pool.run(new AbortController().signal, async () => ++calls),
  );
  assert.equal(calls, 0);
  assert.deepEqual(await Promise.all(pending), [1, 2, 3, 4, 5]);
  assert.equal(calls, 5);
});

it("holds a queued task when the active task starts cooldown", async () => {
  const pool = new TurnPool(1, Date.now, 20, 20);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = pool.run(new AbortController().signal, async () => {
    await gate;
    throw pool.rateLimited();
  });
  let calls = 0;
  const queued = pool.run(new AbortController().signal, async () => ++calls);
  release();
  await assert.rejects(first, ChatGptRateLimitError);
  assert.equal(await queued, 1);
  assert.equal(calls, 1);
});

it("keeps an acquired parent task alive when a child starts cooldown", async () => {
  const pool = new TurnPool(2, Date.now, 20, 20);
  let childFinished!: () => void;
  const childGate = new Promise<void>((resolve) => {
    childFinished = resolve;
  });
  const parent = pool.run(new AbortController().signal, async () => {
    await childGate;
    return "PARENT_OK";
  });
  const child = pool.run(new AbortController().signal, async () => {
    try {
      throw pool.rateLimited();
    } finally {
      childFinished();
    }
  });
  await assert.rejects(child, ChatGptRateLimitError);
  assert.equal(await parent, "PARENT_OK");
});

it("backs off repeated live rate limits and resets after a successful turn", async () => {
  let now = 1_000;
  const pool = new TurnPool(1, () => now);
  for (const seconds of [120, 240, 480, 900, 900]) {
    assert.equal(pool.rateLimited().retryAfterSeconds, seconds);
    now += seconds * 1_000;
    pool.assertAvailable();
  }
  assert.equal(
    await pool.run(new AbortController().signal, async () => "OK"),
    "OK",
  );
  assert.equal(pool.rateLimited().retryAfterSeconds, 120);
});

it("cancellation while waiting through cooldown never invokes the operation", async () => {
  const pool = new TurnPool(1, Date.now, 100, 100);
  pool.rateLimited();
  const controller = new AbortController();
  const pending = pool.run(controller.signal, async () =>
    assert.fail("Must not run"),
  );
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

it("reports cooldown before submission and allows cancellation without sending", async () => {
  const pool = new TurnPool(1, Date.now, 60_000, 60_000);
  pool.rateLimited();
  const controller = new AbortController();
  const notices: number[] = [];
  const pending = pool.run(
    controller.signal,
    async () => assert.fail("No submission during cooldown"),
    undefined,
    (seconds) => notices.push(seconds),
  );
  assert.deepEqual(notices, [60]);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
