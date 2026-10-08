import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { it } from "node:test";
import { delay } from "./browser-delay.js";

it("releases abort listeners between polls in a long browser turn", async () => {
  const controller = new AbortController();
  for (let index = 0; index < 25; index++) {
    await delay(0, controller.signal);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

it("cancels an active wait immediately and releases its listener", async () => {
  const controller = new AbortController();
  const waiting = delay(60_000, controller.signal);
  const rejected = assert.rejects(waiting, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

it("does not start a wait for an already cancelled turn", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(delay(60_000, controller.signal), {
    name: "AbortError",
  });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
