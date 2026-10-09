import assert from "node:assert/strict";
import { it } from "node:test";
import { once } from "node:events";
import WebSocket from "ws";
import { ResponsesGateway } from "./responses-server.js";
import { FullTurnBroker } from "./full-turn-broker.js";

async function nextEvent(socket: WebSocket): Promise<Record<string, unknown>> {
  const [data] = await once(socket, "message", {
    signal: AbortSignal.timeout(2_000),
  });
  return JSON.parse(String(data)) as Record<string, unknown>;
}

async function connect(gateway: ResponsesGateway): Promise<WebSocket> {
  const address = await gateway.start();
  const socket = new WebSocket(
    `${address.baseUrl.replace(/^http/, "ws")}/responses`,
    { headers: { authorization: "Bearer test" } },
  );
  await once(socket, "open", { signal: AbortSignal.timeout(2_000) });
  return socket;
}

it("returns a terminal Codex WebSocket error for stale low effort and accepts a corrected turn", async () => {
  let browserCalls = 0;
  const gateway = new ResponsesGateway({
    port: 0,
    availableWebModes: () => ["instant", "medium", "high", "extra-high", "pro"],
    accountContextProfile: () => "pro",
    nativeModelFamilies: () => ["6"],
    fullMcp: {
      broker: new FullTurnBroker(),
      enabled: () => true,
      connectorName: () => "Bridge",
    },
    runWebTurn: async (input) => {
      browserCalls++;
      assert.equal(input.mode, "medium");
      assert.equal(input.execution?.toolTransport, "full");
      return "corrected-turn-ok";
    },
  });
  const socket = await connect(gateway);
  try {
    let event = nextEvent(socket);
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: "codexgpt-bridge/gpt-6-sol",
        reasoning: { effort: "low" },
        input: "test",
      }),
    );
    assert.deepEqual(await event, {
      type: "error",
      status: 400,
      error: {
        type: "invalid_request_error",
        code: "bridge_reasoning_effort_unavailable",
        message:
          'Unsupported reasoning effort "low" for codexgpt-bridge/gpt-6-sol; choose medium, high, xhigh. No prompt was submitted.',
        param: null,
      },
      sequence_number: 0,
    });
    assert.equal(browserCalls, 0);
    const completed = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const result = JSON.parse(String(data)) as Record<string, unknown>;
        if (result.type === "response.completed") resolve(result);
      });
    });
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: "codexgpt-bridge/gpt-6-sol",
        reasoning: { effort: "medium" },
        input: "test",
        metadata: { thread_id: "corrected-thread", turn_id: "corrected-turn" },
      }),
    );
    event = Promise.race([
      completed,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Corrected turn stalled.")),
          2_000,
        );
        timer.unref();
        void completed.then(() => clearTimeout(timer));
      }),
    ]);
    assert.equal((await event).type, "response.completed");
    assert.equal(browserCalls, 1);
    assert.equal(gateway.lifecycleStatus().activeHttpTurns, 0);
  } finally {
    socket.terminate();
    await gateway.close();
  }
});

it("wraps malformed events and unavailable models as HTTP 400 WebSocket errors", async () => {
  const gateway = new ResponsesGateway({
    port: 0,
    runWebTurn: async () =>
      assert.fail("Invalid requests must not reach the browser."),
  });
  const socket = await connect(gateway);
  try {
    for (const [request, code] of [
      ["{", "invalid_json"],
      [JSON.stringify({ type: "unknown" }), "unsupported_event"],
      [
        JSON.stringify({ type: "response.create", model: "unknown" }),
        "unsupported_bridge_web_model",
      ],
    ]) {
      const event = nextEvent(socket);
      socket.send(request!);
      const result = await event;
      assert.equal(result.status, 400);
      assert.equal((result.error as Record<string, unknown>).code, code);
    }
  } finally {
    socket.terminate();
    await gateway.close();
  }
});

it("preserves server failures and draining status in the Codex WebSocket envelope", async () => {
  const gateway = new ResponsesGateway({
    port: 0,
    admin: { token: "test-admin-capability" },
    availableWebModes: () => {
      throw new Error("Capability snapshot unavailable.");
    },
    runWebTurn: async () =>
      assert.fail("Preflight failures must not reach the browser."),
  });
  const socket = await connect(gateway);
  try {
    let event = nextEvent(socket);
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: "codexgpt-bridge/high",
      }),
    );
    assert.deepEqual(await event, {
      type: "error",
      status: 500,
      error: {
        type: "server_error",
        code: "codexgpt_bridge_provider_error",
        message: "Capability snapshot unavailable.",
        param: null,
      },
      sequence_number: 0,
    });
    const drainUrl = new URL(socket.url);
    drainUrl.protocol = "http:";
    drainUrl.pathname = "/admin/drain";
    await fetch(drainUrl, {
      method: "POST",
      headers: { authorization: "Bearer test-admin-capability" },
    });
    event = nextEvent(socket);
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: "codexgpt-bridge/high",
      }),
    );
    const result = await event;
    assert.equal(result.status, 503);
    assert.equal(
      (result.error as Record<string, unknown>).code,
      "provider_draining",
    );
    assert.deepEqual(result.headers, { "retry-after": "5" });
  } finally {
    socket.terminate();
    await gateway.close();
  }
});
