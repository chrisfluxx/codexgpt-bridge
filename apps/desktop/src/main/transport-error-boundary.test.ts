import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isExpectedPeerDisconnect } from "./transport-error-boundary.js";

describe("desktop transport error boundary", () => {
  it("recognizes direct and wrapped peer disconnects", () => {
    const reset = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    assert.equal(isExpectedPeerDisconnect(reset), true);
    assert.equal(
      isExpectedPeerDisconnect(new Error("fetch failed", { cause: reset })),
      true,
    );
  });

  it("does not classify application failures as transport disconnects", () => {
    assert.equal(isExpectedPeerDisconnect(new Error("logic failure")), false);
    assert.equal(
      isExpectedPeerDisconnect(
        Object.assign(new Error("denied"), { code: "EACCES" }),
      ),
      false,
    );
  });
});
