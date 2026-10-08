import assert from "node:assert/strict";
import { it } from "node:test";
import { Script } from "node:vm";
import {
  FullTurnBroker,
  fullTurnResultFromCodex,
  type FullTurnToolRequest,
} from "./full-turn-broker.js";
import { FullTurnMcpServer } from "./full-turn-mcp-server.js";
import { FullNativeRegistry } from "./full-native-registry.js";
import { normalizeResponsesTools } from "./tool-protocol.js";
import {
  fullTransportExec,
  FULL_AGENT_WAIT_POLL_MS,
  NATIVE_AGENT_FAMILIES,
} from "./full-native-transport.js";

const gateway = {
  kind: "custom" as const,
  wireName: "functions__exec",
  namespace: "functions",
  name: "exec",
  description: "Run native code",
  parameters: {},
  format: { type: "text" },
};

const discoveryTools = [
  {
    type: "function",
    name: "mcp__node_repl__js",
    parameters: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
  },
];
const searchTool = normalizeResponsesTools([
  { type: "tool_search", parameters: { type: "object" } },
]);

it("keeps discovered tools turn-bound and repeated search/reconnect idempotent", async () => {
  const broker = new FullTurnBroker();
  const token = broker.register("discovery-owner", searchTool, true);
  const other = broker.register("other-owner", searchTool, true);
  const timer = setTimeout(() => {}, 5_000);
  try {
    for (let index = 0; index < 2; index++) {
      const pending = broker.invoke(token, "tool_search", { arguments: {} });
      const [call] = await broker.nextBatch(token);
      const result = fullTurnResultFromCodex(
        JSON.stringify({ status: "completed", tools: discoveryTools }),
      );
      broker.complete(token, call!.callId, result);
      await pending;
      broker.complete(token, call!.callId, result);
    }
    assert.equal(broker.inventory(token, "node_repl").total, 1);
    assert.equal(broker.inventory(other, "node_repl").total, 0);
    assert.equal(broker.register("discovery-owner", searchTool, true), token);
  } finally {
    clearTimeout(timer);
    broker.close();
  }
});

it("does not grant tools from ordinary output or a failed native search", async () => {
  const broker = new FullTurnBroker();
  const timer = setTimeout(() => {}, 5_000);
  try {
    for (const kind of ["ordinary", "error", "failed-status"]) {
      const tools =
        kind === "ordinary"
          ? normalizeResponsesTools([
              {
                type: "function",
                name: "read_file",
                parameters: { type: "object" },
              },
            ])
          : searchTool;
      const token = broker.register(kind, tools, true);
      const pending = broker.invoke(token, tools[0]!.wireName, {
        arguments: {},
      });
      const [call] = await broker.nextBatch(token);
      const result = {
        ...fullTurnResultFromCodex(
          JSON.stringify({
            status: kind === "failed-status" ? "failed" : "completed",
            tools: discoveryTools,
          }),
        ),
        ...(kind === "error" ? { isError: true } : {}),
      };
      broker.complete(token, call!.callId, result);
      await pending;
      assert.equal(broker.inventory(token, "node_repl").total, 0);
    }
  } finally {
    clearTimeout(timer);
    broker.close();
  }
});

it("rejects conflicting tool discoveries atomically while retaining the original schema", async () => {
  const broker = new FullTurnBroker();
  const original = normalizeResponsesTools(discoveryTools)[0]!;
  const token = broker.register(
    "conflicting-discovery",
    [...searchTool, original],
    true,
  );
  const timer = setTimeout(() => {}, 5_000);
  try {
    const pending = broker.invoke(token, "tool_search", { arguments: {} });
    const [call] = await broker.nextBatch(token);
    broker.complete(
      token,
      call!.callId,
      fullTurnResultFromCodex(
        JSON.stringify({
          status: "completed",
          tools: [
            {
              type: "function",
              name: "new_uncommitted_tool",
              parameters: { type: "object" },
            },
            { ...discoveryTools[0], parameters: { type: "object" } },
          ],
        }),
      ),
    );
    const result = await pending;
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /cannot replace/u);
    assert.equal(broker.inventory(token, "new_uncommitted_tool").total, 0);
    assert.deepEqual(broker.inventory(token, "node_repl").tools, [original]);
  } finally {
    clearTimeout(timer);
    broker.close();
  }
});

async function execute(
  request: FullTurnToolRequest,
  registry: readonly { name: string; description: string }[],
  tools: Record<string, (...args: unknown[]) => unknown>,
  captureErrors = false,
) {
  const content: unknown[] = [];
  let isError = false;
  try {
    await new Script(`(async () => {\n${request.input}\n})()`).runInNewContext({
      ALL_TOOLS: registry,
      tools,
      text: (value: unknown) =>
        content.push({
          type: "text",
          text: typeof value === "string" ? value : JSON.stringify(value),
        }),
      image: (value: unknown) => content.push(value),
      audio: (value: unknown) => content.push(value),
      generatedImage: (value: unknown) => content.push(value),
    });
  } catch (error) {
    if (!captureErrors) throw error;
    isError = true;
    content.push({ type: "text", text: String(error) });
  }
  return { content, ...(isError ? { isError: true } : {}) };
}

it("discovers and invokes exact native MCP tools through a namespaced outer exec gateway", async () => {
  const broker = new FullTurnBroker();
  const token = broker.register("native-registry", [gateway], true);
  const other = broker.register("other-turn", [gateway], true);
  const mcp = new FullTurnMcpServer(broker);
  let timer: NodeJS.Timeout | undefined;
  let calls = 0;
  const registry = [
    {
      name: "mcp__fixture__read",
      description: 'Read fixture. Input schema: {"path":"string"}.',
    },
    { name: "exec_command", description: "Run a native shell command" },
  ];
  try {
    timer = setTimeout(() => {}, 5_000);
    const address = await mcp.start();
    const init = await fetch(address.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });
    const session = init.headers.get("mcp-session-id")!;
    let rpcId = 1;
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(address.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-session-id": session,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++rpcId,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      return (await response.json()) as {
        result: {
          isError?: boolean;
          content: Array<Record<string, unknown>>;
          structuredContent?: {
            tools: Array<{ wireName: string; description: string }>;
            total: number;
          };
        };
      };
    };

    const inventoryResponse = call("codex_tool_inventory", {
      turn_token: token,
      query: "fixture",
      limit: 1,
    });
    const [discovery] = await broker.nextBatch(token);
    assert.equal(discovery!.wireName, "functions__exec");
    broker.complete(
      token,
      discovery!.callId,
      await execute(discovery!, registry, {}),
    );
    const inventory = (await inventoryResponse).result.structuredContent!;
    assert.equal(inventory.total, 1);
    assert.equal(inventory.tools[0]!.wireName, "mcp__fixture__read");
    assert.match(inventory.tools[0]!.description, /Input schema/u);

    const invoked = call("codex_tool_call", {
      turn_token: token,
      wire_name: "mcp__fixture__read",
      arguments: { path: 'quotes " and backticks ` remain data' },
    });
    const [invocation] = await broker.nextBatch(token);
    assert.equal(invocation!.wireName, "functions__exec");
    const result = await execute(invocation!, registry, {
      mcp__fixture__read: (args) => {
        calls++;
        assert.equal(
          (args as { path: string }).path,
          'quotes " and backticks ` remain data',
        );
        return {
          content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
        };
      },
    });
    broker.complete(token, invocation!.callId, result);
    assert.deepEqual((await invoked).result.content, [
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    ]);
    assert.equal(calls, 1);

    const undiscovered = await call("codex_tool_call", {
      turn_token: other,
      wire_name: "mcp__fixture__read",
      arguments: {},
    });
    assert.equal(undiscovered.result.isError, true);
    assert.match(
      String(undiscovered.result.content[0]!.text),
      /Discover the exact/u,
    );

    const removed = call("codex_tool_call", {
      turn_token: token,
      wire_name: "mcp__fixture__read",
      arguments: {},
    });
    const [removedRequest] = await broker.nextBatch(token);
    await assert.rejects(
      execute(removedRequest!, [], {
        mcp__fixture__read: () => {
          calls++;
        },
      }),
      /not listed/u,
    );
    broker.complete(token, removedRequest!.callId, {
      isError: true,
      content: [{ type: "text", text: "Native registry changed" }],
    });
    assert.equal((await removed).result.isError, true);
    assert.equal(calls, 1);

    const command = call("codex_exec", {
      turn_token: token,
      cmd: "echo fixture",
    });
    const [commandRequest] = await broker.nextBatch(token);
    assert.equal(commandRequest!.wireName, "functions__exec");
    const commandResult = await execute(commandRequest!, registry, {
      exec_command: () => ({ output: "fixture", exit_code: 0 }),
    });
    broker.complete(token, commandRequest!.callId, commandResult);
    assert.match(JSON.stringify((await command).result), /fixture/u);
  } finally {
    clearTimeout(timer);
    await mcp.close();
    broker.close();
  }
});

it("does not silently choose between duplicate native exec gateways", async () => {
  const broker = new FullTurnBroker();
  const token = broker.register(
    "ambiguous",
    [gateway, { ...gateway, wireName: "other__exec", namespace: "other" }],
    true,
  );
  const { FullNativeRegistry } = await import("./full-native-registry.js");
  const registry = new FullNativeRegistry(broker);
  try {
    await assert.rejects(registry.inventory(token), /ambiguous native exec/u);
  } finally {
    registry.close();
    broker.close();
  }
});

it("preserves nested MCP errors and structured results emitted by the native code gateway", () => {
  const nested = {
    isError: true,
    content: [{ type: "text", text: "Native tool failed" }],
    structuredContent: { code: "fixture_error" },
  };
  const output = [{ type: "input_text", text: JSON.stringify(nested) }];
  assert.deepEqual(fullTurnResultFromCodex("tool result", output), nested);
});

it("pages across outer and native tools and refreshes discovery from the current runtime", async () => {
  const broker = new FullTurnBroker();
  const token = broker.register("pagination", [gateway], true);
  const native = new FullNativeRegistry(broker);
  const timer = setTimeout(() => {}, 5_000);
  let runtime = Array.from({ length: 104 }, (_, index) => ({
    name: `fixture__tool_${index}`,
    description: `Runtime version one, tool ${index}`,
  }));
  const page = async (offset: number, limit: number) => {
    const response = native.inventory(token, "", offset, limit);
    const [request] = await broker.nextBatch(token);
    broker.complete(
      token,
      request!.callId,
      await execute(request!, runtime, {}),
    );
    return response;
  };
  try {
    const first = await page(0, 1);
    assert.equal(first.tools[0]!.wireName, "functions__exec");
    assert.equal(first.total, 105);
    assert.equal(first.nextOffset, 1);
    const second = await page(1, 100);
    assert.equal(second.tools.length, 100);
    assert.equal(second.tools[0]!.wireName, "fixture__tool_0");
    assert.equal(second.nextOffset, 101);
    const last = await page(101, 100);
    assert.equal(last.tools.length, 4);
    assert.equal(last.tools[0]!.wireName, "fixture__tool_100");
    assert.equal(last.nextOffset, null);
    runtime = [{ name: "fixture__new", description: "Runtime version two" }];
    const updated = await page(0, 100);
    assert.equal(updated.total, 2);
    assert.equal(updated.tools[1]!.description, "Runtime version two");
  } finally {
    clearTimeout(timer);
    native.close();
    broker.close();
  }
});

for (const family of NATIVE_AGENT_FAMILIES) {
  it(`does not replace a completed ${family} child whose answer mentions failed tests`, async () => {
    const broker = new FullTurnBroker();
    const token = broker.register(
      `${family}-completed`,
      [
        {
          kind: "function",
          wireName: `${family}__spawn_agent`,
          name: "spawn_agent",
          description: "Create a native child",
          parameters: { type: "object" },
        },
      ],
      true,
      { subagentLimit: 1 },
    );
    const timer = setTimeout(() => {}, 5_000);
    try {
      const first = broker.invoke(token, `${family}__spawn_agent`, {
        arguments: { message: "Fix tests" },
      });
      const [request] = await broker.nextBatch(token);
      broker.complete(token, request!.callId, {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: {
                "01a096e7-94b7-7c50-8557-5ef0ecf96e23": {
                  completed:
                    "Tests failed earlier; fixed the code. A rate limit was also investigated.",
                },
              },
            }),
          },
        ],
      });
      await first;
      const extra = await broker.invoke(token, `${family}__spawn_agent`, {
        arguments: { message: "Unrequested replacement" },
      });
      assert.equal(extra.isError, true);
      assert.equal(broker.subagentSpawns(token), 1);
      assert.equal(broker.hasPending(token), false);
    } finally {
      clearTimeout(timer);
      broker.close();
    }
  });
  it(`counts and limits discovered ${family} subagents, with a replacement after terminal failure`, async () => {
    const broker = new FullTurnBroker();
    const token = broker.register(family, [gateway], true, {
      subagentLimit: 1,
    });
    const native = new FullNativeRegistry(broker);
    const timer = setTimeout(() => {}, 5_000);
    const name = `${family}__spawn_agent`;
    const runtime = [{ name, description: "Create a native child" }];
    try {
      const inventory = native.inventory(token, family);
      const [discovery] = await broker.nextBatch(token);
      broker.complete(
        token,
        discovery!.callId,
        await execute(discovery!, runtime, {}),
      );
      await inventory;
      const spawned = native.invoke(token, name, {
        arguments: { message: "One child" },
      });
      const [request] = await broker.nextBatch(token);
      assert.equal(broker.subagentSpawns(token), 0);
      broker.complete(token, request!.callId, {
        ...(await execute(request!, runtime, {
          [name]: () => ({ agent_id: "failed-child", status: "errored" }),
        })),
      });
      await spawned;
      assert.equal(broker.subagentSpawns(token), 1);
      const replacement = native.invoke(token, name, {
        arguments: { message: "Replacement child" },
      });
      const [replacementRequest] = await broker.nextBatch(token);
      let executions = 0;
      broker.complete(
        token,
        replacementRequest!.callId,
        await execute(replacementRequest!, runtime, {
          [name]: () => {
            executions++;
            return { agent_id: "replacement", status: "completed" };
          },
        }),
      );
      await replacement;
      const extraPending = native.invoke(token, name, {
        arguments: { message: "Extra child" },
      });
      const [extraRequest] = await broker.nextBatch(token);
      broker.complete(
        token,
        extraRequest!.callId,
        await execute(
          extraRequest!,
          runtime,
          {
            [name]: () => {
              executions++;
              return { agent_id: "extra" };
            },
          },
          true,
        ),
      );
      const extra = await extraPending;
      assert.equal(extra.isError, true);
      assert.match(
        String((extra.content[0] as { text: string }).text),
        /requested successful count/u,
      );
      assert.equal(broker.hasPending(token), false);
      assert.equal(executions, 1);
    } finally {
      clearTimeout(timer);
      native.close();
      broker.close();
    }
  });

  it(`enforces ${family} wait polling inside arbitrary native code, including aliases`, async () => {
    const name = `${family}__wait_agent`;
    const runtime = [{ name, description: "Wait for native children" }];
    let executions = 0;
    const tools = {
      [name]: (args: unknown) => {
        executions++;
        return args;
      },
    };
    const request = (input: string): FullTurnToolRequest => ({
      callId: "fixture",
      kind: "custom",
      name: "exec",
      wireName: "functions__exec",
      arguments: { input },
      input,
    });
    const invalid = fullTransportExec(
      `const wait = tools[${JSON.stringify(name)}]; await wait({ timeout_ms: 120000 });`,
      "functions__exec",
    );
    await assert.rejects(
      execute(request(invalid), runtime, tools),
      /timeout_ms=30000/u,
    );
    assert.equal(executions, 0);
    const valid = fullTransportExec(
      `const wait = tools[${JSON.stringify(name)}]; text(await wait({ timeout_ms: ${FULL_AGENT_WAIT_POLL_MS}, targets: ['child'] }));`,
      "functions__exec",
    );
    const result = await execute(request(valid), runtime, tools);
    assert.match(JSON.stringify(result), /child/u);
    assert.equal(executions, 1);
    await assert.rejects(
      execute(
        request(
          fullTransportExec(
            "await tools.exec('recursive');",
            "functions__exec",
          ),
        ),
        [],
        {
          exec: () => {
            executions++;
          },
        },
      ),
      /Recursive native exec/u,
    );
    assert.equal(executions, 1);
  });
}
