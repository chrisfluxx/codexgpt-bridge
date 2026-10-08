import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SharedSerialRunner } from "./shared-serial-runner.js";
import { OperationJournal } from "./operation-journal.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    promise,
    resolve(value: T): void {
      resolve?.(value);
    },
  };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

describe("SharedSerialRunner", () => {
  it("replays the original accepted-turn failure without beginning its journal or sending twice", async () => {
    const failure = new Error(
      "ChatGPT exposed duplicate logical message identities; response binding is ambiguous.",
    );
    const journal = new OperationJournal();
    const submittedFailures = new WeakSet<object>();
    const runner = new SharedSerialRunner<string>(
      1_000,
      100,
      100,
      (error) =>
        typeof error === "object" &&
        error !== null &&
        submittedFailures.has(error),
    );
    const key = "1".repeat(64);
    let sends = 0;
    const work = async (): Promise<string> => {
      await journal.begin(key);
      await journal.mark(key, "submitting");
      sends++;
      await journal.mark(key, "accepted");
      submittedFailures.add(failure);
      await journal.mark(key, "failed");
      throw failure;
    };
    for (let reconnect = 0; reconnect < 4; reconnect++) {
      await assert.rejects(
        runner.run(key, new AbortController().signal, work),
        (error) => error === failure,
      );
    }
    assert.equal(sends, 1);
    assert.equal(
      await runner.run(
        "different-request",
        new AbortController().signal,
        async () => "done",
      ),
      "done",
    );
  });
  it("replays deterministic preparation failures without rerunning browser work", async () => {
    const failure = new Error("model selection missing");
    const runner = new SharedSerialRunner<string>(
      1_000,
      100,
      100,
      (error) => error === failure,
    );
    const signal = new AbortController().signal;
    let calls = 0;
    for (let index = 0; index < 5; index++) {
      await assert.rejects(
        runner.run("same-turn", signal, async () => {
          calls++;
          throw failure;
        }),
        (error) => error === failure,
      );
    }
    assert.equal(calls, 1);
    assert.equal(
      await runner.run("new-turn", signal, async () => "ready"),
      "ready",
    );
  });

  it("expires a retained preparation failure so a later retry can recover", async () => {
    const failure = new Error("model selection missing");
    const runner = new SharedSerialRunner<string>(
      1_000,
      100,
      10,
      (error) => error === failure,
    );
    const signal = new AbortController().signal;
    await assert.rejects(
      runner.run("same-turn", signal, async () => {
        throw failure;
      }),
    );
    await delay(30);
    assert.equal(
      await runner.run("same-turn", signal, async () => "recovered"),
      "recovered",
    );
  });

  it("does not cache a queue timeout as the permanent result of a retry", async () => {
    const keepAlive = setInterval(() => undefined, 1_000);
    const runner = new SharedSerialRunner<string>(20);
    const gate = deferred<string>();
    const signal = new AbortController().signal;
    const first = runner.run("busy", signal, () => gate.promise);
    try {
      await assert.rejects(
        runner.run("queued-retry", signal, async () => "must not run"),
        /queue was busy/,
      );
      gate.resolve("done");
      await first;
      assert.equal(
        await runner.run("queued-retry", signal, async () => "retried"),
        "retried",
      );
    } finally {
      gate.resolve("done");
      clearInterval(keepAlive);
    }
  });
  it("allows the same logical request to retry after a failed transfer", async () => {
    const runner = new SharedSerialRunner<string>(1_000);
    const signal = new AbortController().signal;
    await assert.rejects(
      runner.run("retry", signal, async () => {
        throw new Error("download failed");
      }),
      /download failed/,
    );
    assert.equal(
      await runner.run("retry", signal, async () => "retried"),
      "retried",
    );
  });

  it("waits for cancelled turn cleanup before starting a same-key retry", async () => {
    const runner = new SharedSerialRunner<string>(1_000);
    const controller = new AbortController();
    const cleanup = deferred<void>();
    let retryStarted = false;
    const first = runner.run(
      "cancel-retry",
      controller.signal,
      async (signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        await cleanup.promise;
        throw new DOMException("cancelled", "AbortError");
      },
    );
    await nextTurn();
    controller.abort();
    await assert.rejects(first, { name: "AbortError" });
    const retry = runner.run(
      "cancel-retry",
      new AbortController().signal,
      async () => {
        retryStarted = true;
        return "ok";
      },
    );
    await nextTurn();
    assert.equal(retryStarted, false);
    cleanup.resolve();
    assert.equal(await retry, "ok");
  });
  it("shares one operation across reconnects for the same turn", async () => {
    const runner = new SharedSerialRunner<string>(1_000);
    const result = deferred<string>();
    let calls = 0;
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();
    const operation = async (): Promise<string> => {
      calls += 1;
      return result.promise;
    };

    const first = runner.run("same", firstSignal.signal, operation);
    const second = runner.run("same", secondSignal.signal, operation);
    await nextTurn();
    assert.equal(calls, 1);
    result.resolve("done");
    assert.deepEqual(await Promise.all([first, second]), ["done", "done"]);
  });

  it("does not abort a shared operation while another subscriber remains", async () => {
    const runner = new SharedSerialRunner<string>(1_000);
    const result = deferred<string>();
    let sharedSignal: AbortSignal | undefined;
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();
    const operation = async (signal: AbortSignal): Promise<string> => {
      sharedSignal = signal;
      return result.promise;
    };

    const first = runner.run("same", firstSignal.signal, operation);
    const second = runner.run("same", secondSignal.signal, operation);
    firstSignal.abort();
    await assert.rejects(first, { name: "AbortError" });
    assert.equal(sharedSignal?.aborted, false);
    result.resolve("survived");
    assert.equal(await second, "survived");
  });

  it("shares an active operation across a disconnect-then-reconnect gap", async () => {
    const runner = new SharedSerialRunner<string>(1_000, 100, 100);
    const result = deferred<string>();
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();
    let sharedSignal: AbortSignal | undefined;
    let calls = 0;
    const operation = async (signal: AbortSignal): Promise<string> => {
      calls += 1;
      sharedSignal = signal;
      return result.promise;
    };

    const first = runner.run("same", firstSignal.signal, operation);
    await nextTurn();
    firstSignal.abort(transportDisconnectForTest());
    await assert.rejects(first, { name: "AbortError" });
    assert.equal(sharedSignal?.aborted, false);

    const reconnected = runner.run("same", secondSignal.signal, operation);
    result.resolve("reconnected");
    assert.equal(await reconnected, "reconnected");
    assert.equal(calls, 1);
  });

  it("replays a result that settled while the transport was disconnected", async () => {
    const runner = new SharedSerialRunner<string>(1_000, 100, 100);
    const result = deferred<string>();
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();
    let calls = 0;
    const operation = async (): Promise<string> => {
      calls += 1;
      return result.promise;
    };

    const first = runner.run("same", firstSignal.signal, operation);
    await nextTurn();
    firstSignal.abort(transportDisconnectForTest());
    await assert.rejects(first, { name: "AbortError" });
    result.resolve("settled while offline");
    await nextTurn();

    assert.equal(
      await runner.run("same", secondSignal.signal, operation),
      "settled while offline",
    );
    assert.equal(calls, 1);
  });

  it("aborts an orphaned active operation after the reconnect grace", async () => {
    const runner = new SharedSerialRunner<string>(1_000, 10, 100);
    const firstSignal = new AbortController();
    let sharedSignal: AbortSignal | undefined;
    const operation = (signal: AbortSignal): Promise<string> => {
      sharedSignal = signal;
      return new Promise<string>((_resolvePromise, rejectPromise) => {
        signal.addEventListener(
          "abort",
          () => rejectPromise(abortErrorForTest()),
          { once: true },
        );
      });
    };

    const first = runner.run("same", firstSignal.signal, operation);
    await nextTurn();
    firstSignal.abort(transportDisconnectForTest());
    await assert.rejects(first, { name: "AbortError" });
    await delay(30);
    assert.equal(sharedSignal?.aborted, true);
  });

  it("aborts an active operation immediately for an explicit cancellation", async () => {
    const runner = new SharedSerialRunner<string>(1_000, 1_000, 100);
    const firstSignal = new AbortController();
    let sharedSignal: AbortSignal | undefined;
    const operation = (signal: AbortSignal): Promise<string> => {
      sharedSignal = signal;
      return new Promise<string>((_resolvePromise, rejectPromise) => {
        signal.addEventListener(
          "abort",
          () => rejectPromise(abortErrorForTest()),
          { once: true },
        );
      });
    };

    const first = runner.run("same", firstSignal.signal, operation);
    await nextTurn();
    firstSignal.abort();
    await assert.rejects(first, { name: "AbortError" });
    assert.equal(sharedSignal?.aborted, true);
  });

  it("drops a cancelled queued turn without blocking the next turn", async () => {
    const runner = new SharedSerialRunner<string>(1_000);
    const firstResult = deferred<string>();
    const firstSignal = new AbortController();
    const cancelledSignal = new AbortController();
    const lastSignal = new AbortController();
    let cancelledRan = false;
    let lastRan = false;

    const first = runner.run(
      "first",
      firstSignal.signal,
      () => firstResult.promise,
    );
    const cancelled = runner.run(
      "cancelled",
      cancelledSignal.signal,
      async () => {
        cancelledRan = true;
        return "unexpected";
      },
    );
    const last = runner.run("last", lastSignal.signal, async () => {
      lastRan = true;
      return "last";
    });
    cancelledSignal.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    firstResult.resolve("first");
    assert.equal(await first, "first");
    assert.equal(await last, "last");
    assert.equal(cancelledRan, false);
    assert.equal(lastRan, true);
  });
});

function abortErrorForTest(): DOMException {
  return new DOMException("Provider turn was cancelled.", "AbortError");
}

function transportDisconnectForTest(): DOMException {
  return new DOMException("Responses transport disconnected.", "NetworkError");
}
