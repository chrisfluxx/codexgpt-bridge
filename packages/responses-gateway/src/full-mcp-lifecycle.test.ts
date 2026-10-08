import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Script } from "node:vm";
import { it } from "node:test";
import { FullTurnBroker } from "./full-turn-broker.js";
import { FullTurnMcpServer } from "./full-turn-mcp-server.js";

async function fixture(gatewayOnly = false) {
  const broker = new FullTurnBroker();
  const token = broker.register(
    "rpc-fixture",
    gatewayOnly
      ? [
          {
            kind: "custom",
            wireName: "exec",
            name: "exec",
            description: "Run native orchestration code",
            parameters: {},
            format: { type: "text" },
          },
        ]
      : [
          {
            kind: "function",
            wireName: "exec_command",
            name: "exec_command",
            description: "Run a command",
            parameters: { type: "object" },
          },
          {
            kind: "function",
            wireName: "write_stdin",
            name: "write_stdin",
            description: "Continue a command session",
            parameters: { type: "object" },
          },
        ],
    true,
  );
  const server = new FullTurnMcpServer(broker);
  const address = await server.start();
  const initialized = await fetch(address.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }),
  });
  const session = initialized.headers.get("mcp-session-id")!;
  const send = async (body: unknown, signal?: AbortSignal) => {
    const response = await fetch(address.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-session-id": session,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (response.status === 202) return { notification: true };
    return (await response.json()) as Record<string, unknown>;
  };
  const call = (
    id: string | number,
    args: Record<string, unknown> = {
      turn_token: token,
      cmd: "perform operation",
    },
    signal?: AbortSignal,
  ) =>
    send(
      {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "codex_exec", arguments: args },
      },
      signal,
    );
  return { broker, token, server, send, call };
}

async function receivedCommandBudget(request: {
  readonly arguments?: unknown;
  readonly input?: string;
}): Promise<unknown> {
  if (request.input === undefined) {
    return (request.arguments as Record<string, unknown>).max_output_tokens;
  }
  let captured: Record<string, unknown> | undefined;
  const nativeCommand = (args: Record<string, unknown>) => {
    captured = args;
    return { output: "bounded result", exit_code: 0 };
  };
  await new Script(`(async () => {\n${request.input}\n})()`).runInNewContext({
    ALL_TOOLS: [{ name: "exec_command" }, { name: "write_stdin" }],
    tools: { exec_command: nativeCommand, write_stdin: nativeCommand },
    text: (value: unknown) => value,
  });
  return captured?.max_output_tokens;
}

for (const gatewayOnly of [false, true]) {
  const transport = gatewayOnly ? "nested code gateway" : "native command tool";
  it(`bounds command output before execution through the ${transport}`, async () => {
    const { broker, token, server, call } = await fixture(gatewayOnly);
    const timer = setTimeout(() => {}, 5_000);
    try {
      for (const [requested, expected] of [
        [undefined, 3_000],
        [600, 600],
        [50_000, 8_000],
      ] as const) {
        const pending = call(`budget-${requested}`, {
          turn_token: token,
          cmd: "read selected file lines",
          ...(requested === undefined ? {} : { max_output_tokens: requested }),
        });
        const [request] = await broker.nextBatch(token);
        assert.ok(request);
        assert.equal(await receivedCommandBudget(request), expected);
        broker.complete(token, request.callId, {
          content: [{ type: "text", text: "bounded result" }],
        });
        assert.match(JSON.stringify((await pending).result), /bounded result/u);
      }
    } finally {
      clearTimeout(timer);
      await server.close();
      broker.close();
    }
  });

  it(`bounds polling output without losing session ownership through the ${transport}`, async () => {
    const { broker, token, server, call, send } = await fixture(gatewayOnly);
    const timer = setTimeout(() => {}, 5_000);
    try {
      const command = call("start-owned-session");
      const [request] = await broker.nextBatch(token);
      assert.ok(request);
      broker.complete(token, request.callId, {
        content: [{ type: "text", text: "running" }],
        structuredContent: { session_id: 7 },
      });
      await command;
      for (const [requested, expected] of [
        [undefined, 3_000],
        [50_000, 8_000],
      ] as const) {
        const pending = send({
          jsonrpc: "2.0",
          id: `poll-budget-${requested}`,
          method: "tools/call",
          params: {
            name: "codex_write_stdin",
            arguments: {
              turn_token: token,
              session_id: 7,
              ...(requested === undefined
                ? {}
                : { max_output_tokens: requested }),
            },
          },
        });
        const [poll] = await broker.nextBatch(token);
        assert.ok(poll);
        assert.equal(await receivedCommandBudget(poll), expected);
        broker.complete(token, poll.callId, {
          content: [{ type: "text", text: "bounded session output" }],
        });
        assert.match(
          JSON.stringify((await pending).result),
          /bounded session output/u,
        );
      }
    } finally {
      clearTimeout(timer);
      await server.close();
      broker.close();
    }
  });
}

it("joins pending duplicate RPCs and replays completed results without re-executing a command", async () => {
  const { broker, token, server, call } = await fixture();
  const timer = setTimeout(() => {}, 5_000);
  try {
    const first = call("operation");
    const [request] = await broker.nextBatch(token);
    const duplicate = call("operation", {
      cmd: "perform operation",
      turn_token: token,
    });
    await delay(40);
    assert.deepEqual(
      (await broker.nextBatch(token)).map((call) => call.callId),
      [request!.callId],
    );
    const nativeResult = {
      content: [{ type: "text", text: "Executed once" }],
      structuredContent: { session_id: 7, output: "Executed once" },
    };
    broker.complete(token, request!.callId, nativeResult);
    assert.deepEqual((await first).result, nativeResult);
    assert.deepEqual((await duplicate).result, nativeResult);
    assert.deepEqual((await call("operation")).result, nativeResult);
    assert.equal(broker.hasPending(token), false);
    const conflicting = await call("operation", {
      turn_token: token,
      cmd: "different operation",
    });
    assert.equal((conflicting.error as { code: number }).code, -32600);
    assert.equal(broker.hasPending(token), false);
    // Equal arguments with a new RPC identity are an intentional new operation.
    const next = call("next-operation");
    const [nextRequest] = await broker.nextBatch(token);
    assert.notEqual(nextRequest!.callId, request!.callId);
    broker.complete(token, nextRequest!.callId, nativeResult);
    await next;
  } finally {
    clearTimeout(timer);
    await server.close();
    broker.close();
  }
});

it("detaches a disconnected HTTP observer while retaining the delivered operation for retry", async () => {
  const { broker, token, server, call } = await fixture();
  const timer = setTimeout(() => {}, 5_000);
  try {
    const observer = new AbortController();
    const first = call(2, undefined, observer.signal).catch(
      (error) => error as Error,
    );
    const [request] = await broker.nextBatch(token);
    observer.abort();
    assert.equal((await first).name, "AbortError");
    await delay(40);
    assert.equal(broker.hasPending(token), true);
    const retry = call(2);
    broker.complete(token, request!.callId, {
      content: [{ type: "text", text: "Original operation result" }],
    });
    assert.match(
      JSON.stringify((await retry).result),
      /Original operation result/u,
    );
    assert.equal(broker.hasPending(token), false);
  } finally {
    clearTimeout(timer);
    await server.close();
    broker.close();
  }
});

it("honors explicit MCP cancellation and replays its terminal result", async () => {
  const { broker, token, server, call, send } = await fixture();
  const timer = setTimeout(() => {}, 5_000);
  try {
    const first = call("cancelled");
    await broker.nextBatch(token);
    assert.deepEqual(
      await send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "cancelled" },
      }),
      { notification: true },
    );
    const result = (await first).result;
    assert.equal((result as { isError: boolean }).isError, true);
    assert.equal(broker.hasPending(token), false);
    assert.deepEqual((await call("cancelled")).result, result);
    assert.equal(broker.hasPending(token), false);
  } finally {
    clearTimeout(timer);
    await server.close();
    broker.close();
  }
});
