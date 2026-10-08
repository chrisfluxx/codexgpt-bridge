import assert from "node:assert/strict";
import { it } from "node:test";
import { FullTurnBroker } from "./full-turn-broker.js";
import {
  FullTurnCoordinator,
  type FullTurnRunInput,
} from "./full-turn-coordinator.js";
import { compileResponsesPrompt } from "./prompt.js";
import { ProviderLifecycleController } from "./provider-lifecycle.js";
import { FullNativeRegistry } from "./full-native-registry.js";
import {
  BRIDGE_TEXT_FRAME_CLOSE,
  BRIDGE_TEXT_FRAME_OPEN,
} from "./tool-protocol.js";

function fullInput(
  overrides: Partial<FullTurnRunInput> = {},
): FullTurnRunInput {
  return {
    compiled: compileResponsesPrompt({
      metadata: { thread_id: "full-test", turn_id: "full-turn" },
      input: "Say hello.",
    }),
    model: "codexgpt-bridge/high",
    mode: "high",
    connectorName: "Bridge",
    operationId: "full-test",
    requestSignal: AbortSignal.timeout(5_000),
    acquireToolLease: () => ({ release() {} }),
    runBrowser: async () => "Hello",
    ...overrides,
  };
}

it("loads deferred native tools from tool search and invokes them within the same Full response", async () => {
  const broker = new FullTurnBroker();
  const coordinator = new FullTurnCoordinator(broker);
  const native = new FullNativeRegistry(broker);
  const request = {
    metadata: {
      thread_id: "deferred-native-thread",
      turn_id: "deferred-native-turn",
    },
    input: [
      {
        role: "user",
        content: "Discover node_repl, then inspect the test window.",
      },
    ],
    tools: [
      {
        type: "tool_search",
        execution: "client",
        parameters: { type: "object" },
      },
    ],
  };
  const discovered = [
    {
      type: "namespace",
      name: "mcp__node_repl",
      tools: [
        {
          type: "function",
          name: "js",
          defer_loading: true,
          parameters: {
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
            additionalProperties: false,
          },
        },
      ],
    },
  ];
  let browserRuns = 0;
  const input = fullInput({
    compiled: compileResponsesPrompt(request),
    runBrowser: async (browser) => {
      browserRuns++;
      const token = /turn_[A-Za-z0-9_-]{40,}/u.exec(browser.contract)![0]!;
      await broker.invoke(token, "tool_search", {
        arguments: { query: "node_repl" },
      });
      const inventory = await native.inventory(token, "node_repl");
      assert.equal(inventory.total, 1);
      assert.equal(inventory.tools[0]?.wireName, "mcp__node_repl__js");
      const discoveredTool = inventory.tools[0];
      assert.ok(discoveredTool && "parameters" in discoveredTool);
      assert.deepEqual(
        discoveredTool.parameters,
        discovered[0]!.tools[0]!.parameters,
      );
      const result = await native.invoke(token, "mcp__node_repl__js", {
        arguments: { code: "observe_test_window()" },
      });
      assert.deepEqual(result.content, [
        { type: "text", text: "Observed window" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ]);
      return "DEFERRED_NATIVE_TOOL_OK";
    },
  });
  try {
    const search = await withDeadline(coordinator.run(input));
    if (search.kind !== "tool_calls") assert.fail("expected tool search");
    assert.equal(search.calls[0]?.kind, "tool_search");
    const history = [
      ...request.input,
      {
        type: "tool_search_output",
        call_id: search.calls[0]!.callId,
        status: "completed",
        tools: discovered,
      },
    ];
    const invocation = await withDeadline(
      coordinator.run({
        ...input,
        compiled: compileResponsesPrompt({ ...request, input: history }),
      }),
    );
    if (invocation.kind !== "tool_calls")
      assert.fail("expected discovered native tool");
    assert.equal(invocation.calls[0]?.wireName, "mcp__node_repl__js");
    assert.equal(invocation.calls[0]?.namespace, "mcp__node_repl");
    assert.deepEqual(invocation.calls[0]?.arguments, {
      code: "observe_test_window()",
    });
    assert.deepEqual(
      await withDeadline(
        coordinator.run({
          ...input,
          compiled: compileResponsesPrompt({
            ...request,
            input: [
              ...history,
              {
                type: "function_call_output",
                call_id: invocation.calls[0]!.callId,
                output: [
                  { type: "input_text", text: "Observed window" },
                  {
                    type: "input_image",
                    image_url: "data:image/png;base64,aGVsbG8=",
                  },
                ],
              },
            ],
          }),
        }),
      ),
      { kind: "text", text: "DEFERRED_NATIVE_TOOL_OK" },
    );
    assert.equal(browserRuns, 1);
  } finally {
    native.close();
    coordinator.close();
  }
});

it("revokes an overdue Full generation and replays the failure without submitting the same turn again", async () => {
  const broker = new FullTurnBroker();
  const coordinator = new FullTurnCoordinator(broker, { turnTimeoutMs: 40 });
  let runs = 0;
  let released = 0;
  let token = "";
  let browserSignal: AbortSignal | undefined;
  const input = fullInput({
    acquireToolLease: () => ({
      release() {
        released++;
      },
    }),
    runBrowser: async (request) => {
      runs++;
      token = /turn_[A-Za-z0-9_-]{40,}/u.exec(request.contract)![0];
      browserSignal = request.signal;
      return new Promise<string>(() => {});
    },
  });
  try {
    await assert.rejects(
      withDeadline(coordinator.run(input)),
      /execution deadline/u,
    );
    assert.equal(browserSignal?.aborted, true);
    assert.equal(broker.isActive(token), false);
    assert.equal(released, 1);
    await assert.rejects(coordinator.run(input), /execution deadline/u);
    assert.equal(runs, 1);
    assert.equal(released, 1);
  } finally {
    coordinator.close();
  }
});

it("withholds a Full answer when the required native tool was never invoked", async () => {
  const coordinator = new FullTurnCoordinator(new FullTurnBroker());
  const deltas: string[] = [];
  try {
    await assert.rejects(
      withDeadline(
        coordinator.run(
          fullInput({
            compiled: compileResponsesPrompt({
              metadata: {
                thread_id: "required-thread",
                turn_id: "required-turn",
              },
              input: "Read the file.",
              tool_choice: "required",
              tools: [
                {
                  type: "function",
                  name: "read_file",
                  parameters: { type: "object" },
                },
              ],
            }),
            onDelta: (delta) => deltas.push(delta),
            runBrowser: async (request) => {
              request.onStreamSnapshot?.(
                `${BRIDGE_TEXT_FRAME_OPEN}\nPretended file contents`,
              );
              return `${BRIDGE_TEXT_FRAME_OPEN}\nPretended file contents\n${BRIDGE_TEXT_FRAME_CLOSE}`;
            },
          }),
        ),
      ),
      /without the tool required/u,
    );
    assert.deepEqual(deltas, []);
  } finally {
    coordinator.close();
  }
});

it("withholds intermediate text across Full tool rounds until the final answer", async () => {
  const broker = new FullTurnBroker();
  const coordinator = new FullTurnCoordinator(broker);
  const deltas: string[] = [];
  let token = "";
  const input = fullInput({
    compiled: compileResponsesPrompt({
      metadata: {
        thread_id: "multi-round-stream-thread",
        turn_id: "multi-round-stream-turn",
      },
      input: "Read both files before answering.",
      tool_choice: "required",
      tools: [
        {
          type: "function",
          name: "read_first",
          parameters: { type: "object" },
        },
        {
          type: "function",
          name: "read_second",
          parameters: { type: "object" },
        },
      ],
    }),
    onDelta: (delta) => deltas.push(delta),
    runBrowser: async (request) => {
      token = /turn_[A-Za-z0-9_-]{40,}/u.exec(request.contract)![0]!;
      await broker.invoke(token, "read_first", { arguments: {} });
      request.onStreamSnapshot?.("Intermediate answer");
      await broker.invoke(token, "read_second", { arguments: {} });
      return "Final answer";
    },
  });

  const next = async () => withDeadline(coordinator.run(input));
  try {
    const first = await next();
    assert.equal(first.kind, "tool_calls");
    if (first.kind !== "tool_calls")
      assert.fail("expected the first tool round");
    assert.equal(first.calls[0]?.name, "read_first");
    const firstCallId = first.calls[0]?.callId;
    assert.ok(firstCallId);
    broker.complete(token, firstCallId, {
      content: [{ type: "text", text: "first contents" }],
    });

    const second = await next();
    assert.equal(second.kind, "tool_calls");
    if (second.kind !== "tool_calls")
      assert.fail("expected the second tool round");
    assert.equal(second.calls[0]?.name, "read_second");
    assert.deepEqual(deltas, []);
    const secondCallId = second.calls[0]?.callId;
    assert.ok(secondCallId);
    broker.complete(token, secondCallId, {
      content: [{ type: "text", text: "second contents" }],
    });

    assert.deepEqual(await next(), { kind: "text", text: "Final answer" });
    assert.deepEqual(deltas, ["Final answer"]);
  } finally {
    coordinator.close();
  }
});

async function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Coordinator did not settle within five seconds")),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const successful of [1, 2]) {
  it(`a parent requiring two subagents ${successful === 2 ? "accepts" : "withholds"} ${successful} verified completions`, async () => {
    const broker = new FullTurnBroker();
    const coordinator = new FullTurnCoordinator(broker);
    const deltas: string[] = [];
    let token = "";
    const input = fullInput({
      compiled: compileResponsesPrompt({
        metadata: { thread_id: `success-${successful}`, turn_id: "two-agents" },
        input: "Spawn two subagents and summarize their results.",
        tools: [
          {
            type: "namespace",
            name: "multi_agent_v1",
            tools: [
              {
                type: "function",
                name: "spawn_agent",
                parameters: { type: "object" },
              },
              {
                type: "function",
                name: "wait_agent",
                parameters: { type: "object" },
              },
            ],
          },
        ],
      }),
      onDelta: (delta) => deltas.push(delta),
      runBrowser: async (request) => {
        token = /turn_[A-Za-z0-9_-]{40,}/u.exec(request.contract)![0]!;
        for (let index = 0; index < 2; index++)
          await broker.invoke(token, "multi_agent_v1__spawn_agent", {
            arguments: { message: String(index) },
          });
        request.onStreamSnapshot?.(`${BRIDGE_TEXT_FRAME_OPEN}\nPARENT_OK`);
        await broker.invoke(token, "multi_agent_v1__wait_agent", {
          arguments: { targets: ["owned-1", "owned-2"], timeout_ms: 30000 },
        });
        request.onStreamSnapshot?.(`${BRIDGE_TEXT_FRAME_OPEN}\nPARENT_OK`);
        return `${BRIDGE_TEXT_FRAME_OPEN}\nPARENT_OK\n${BRIDGE_TEXT_FRAME_CLOSE}`;
      },
    });
    let spawns = 0;
    const pump = async () => {
      for (;;) {
        const result = await withDeadline(coordinator.run(input));
        if (result.kind !== "tool_calls") return result;
        for (const call of result.calls) {
          assert.ok(call.callId);
          broker.complete(token, call.callId, {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  call.name === "spawn_agent"
                    ? { agent_id: `owned-${++spawns}` }
                    : {
                        status: {
                          "owned-1": { completed: "A" },
                          "owned-2":
                            successful === 2 ? { completed: "B" } : "running",
                          foreign: { completed: "Not owned" },
                        },
                        timed_out: successful !== 2,
                      },
                ),
              },
            ],
          });
        }
      }
    };
    try {
      if (successful === 2)
        assert.deepEqual(await pump(), { kind: "text", text: "PARENT_OK" });
      else {
        await assert.rejects(
          pump(),
          /1 verified successful subagent results.*exactly 2/u,
        );
        assert.deepEqual(deltas, []);
      }
      assert.equal(spawns, 2);
    } finally {
      coordinator.close();
    }
  });
}

it("a connector failure after a completed tool is terminal and cannot repeat that action", async () => {
  const broker = new FullTurnBroker();
  const coordinator = new FullTurnCoordinator(broker);
  const lifecycle = new ProviderLifecycleController();
  let browserRuns = 0;
  let toolsExecuted = 0;
  let token = "";
  const compiled = compileResponsesPrompt({
    metadata: { thread_id: "thread-test", turn_id: "turn-test" },
    input: [{ role: "user", content: "Read the file." }],
    tools: [
      {
        type: "function",
        name: "read_file",
        parameters: { type: "object", properties: {} },
      },
    ],
  });
  const input: FullTurnRunInput = {
    compiled,
    model: "codexgpt-bridge/high",
    mode: "high",
    connectorName: "Bridge",
    operationId: "op",
    requestSignal: AbortSignal.timeout(5_000),
    acquireToolLease: () => lifecycle.acquireToolTurn(),
    runBrowser: async (request) => {
      browserRuns++;
      token = /turn_[A-Za-z0-9_-]{40,}/u.exec(request.contract)![0];
      await broker.invoke(token, "read_file", { arguments: {} });
      return "<codex_text>Tool codex_exec not found</codex_text>";
    },
  };
  try {
    const first = await withDeadline(coordinator.run(input));
    assert.equal(first.kind, "tool_calls");
    if (first.kind !== "tool_calls") assert.fail("expected a real broker call");
    toolsExecuted++;
    const callId = first.calls[0]?.callId;
    assert.ok(callId);
    broker.complete(token, callId, {
      content: [{ type: "text", text: "file contents" }],
    });
    for (let replay = 0; replay < 2; replay++) {
      await assert.rejects(withDeadline(coordinator.run(input)), {
        code: "bridge_full_mcp_unavailable",
      });
    }
    assert.equal(browserRuns, 1);
    assert.equal(toolsExecuted, 1);
    assert.equal(broker.isActive(token), false);
    assert.equal(lifecycle.status().activeToolTurns, 0);
  } finally {
    coordinator.close();
  }
});

for (const malformed of [
  `${BRIDGE_TEXT_FRAME_OPEN}\nunfinished`,
  "<codex_text>unfinished",
  "<codex_tool_calls>[]</codex_tool_calls>",
]) {
  it(
    "a malformed Full response retires its token and lease: " + malformed,
    async () => {
      const broker = new FullTurnBroker();
      const coordinator = new FullTurnCoordinator(broker);
      const lifecycle = new ProviderLifecycleController();
      let runs = 0;
      let token = "";
      const input: FullTurnRunInput = {
        compiled: compileResponsesPrompt({
          metadata: { thread_id: "malformed", turn_id: "turn-test" },
          input: [{ role: "user", content: "Say hello." }],
          tools: [
            {
              type: "function",
              name: "read_file",
              parameters: { type: "object" },
            },
          ],
        }),
        model: "codexgpt-bridge/high",
        mode: "high",
        connectorName: "Bridge",
        operationId: "malformed",
        requestSignal: AbortSignal.timeout(5_000),
        acquireToolLease: () => lifecycle.acquireToolTurn(),
        runBrowser: async (request) => {
          runs++;
          token = /turn_[A-Za-z0-9_-]{40,}/u.exec(request.contract)![0];
          return malformed;
        },
      };
      try {
        await assert.rejects(withDeadline(coordinator.run(input)));
        await assert.rejects(withDeadline(coordinator.run(input)));
        assert.equal(runs, 1);
        assert.equal(broker.isActive(token), false);
        assert.equal(lifecycle.status().activeToolTurns, 0);
      } finally {
        coordinator.close();
      }
    },
  );
}

it("returns ordinary Markdown without final framing in Full MCP mode", async () => {
  const broker = new FullTurnBroker();
  const coordinator = new FullTurnCoordinator(broker);
  const lifecycle = new ProviderLifecycleController();
  const markdown = "```text\nCodex\n  |\n  v\nChatGPT Web\n```";
  const input: FullTurnRunInput = {
    compiled: compileResponsesPrompt({
      metadata: { thread_id: "markdown", turn_id: "turn-test" },
      input: [{ role: "user", content: "Show the architecture." }],
      tools: [
        {
          type: "function",
          name: "read_file",
          parameters: { type: "object" },
        },
      ],
    }),
    model: "codexgpt-bridge/high",
    mode: "high",
    connectorName: "Bridge",
    operationId: "markdown",
    requestSignal: AbortSignal.timeout(5_000),
    acquireToolLease: () => lifecycle.acquireToolTurn(),
    runBrowser: async (request) => {
      assert.match(request.contract, /Markdown directly/u);
      assert.doesNotMatch(request.contract, /codex_text/u);
      return markdown;
    },
  };

  try {
    assert.deepEqual(await withDeadline(coordinator.run(input)), {
      kind: "text",
      text: markdown,
    });
  } finally {
    coordinator.close();
  }
});

it("keeps a tool_choice none turn on the Full connector with an empty capability inventory", async () => {
  const broker = new FullTurnBroker();
  const coordinator = new FullTurnCoordinator(broker);
  const lifecycle = new ProviderLifecycleController();
  let token = "";
  try {
    const result = await withDeadline(
      coordinator.run(
        fullInput({
          compiled: compileResponsesPrompt({
            metadata: { thread_id: "thread-none", turn_id: "turn-none" },
            input: "Say hello.",
            tool_choice: "none",
            tools: [
              {
                type: "function",
                name: "read_file",
                parameters: { type: "object" },
              },
            ],
          }),
          acquireToolLease: () => lifecycle.acquireToolTurn(),
          runBrowser: async (request) => {
            token = /turn_[A-Za-z0-9_-]{40,}/u.exec(request.contract)![0];
            assert.equal(request.allowWebNativeTools, true);
            assert.equal(request.connectorName, "Bridge");
            assert.equal(broker.inventory(token).total, 0);
            assert.throws(
              () => broker.invoke(token, "read_file", { arguments: {} }),
              /did not advertise/u,
            );
            return "Hello";
          },
        }),
      ),
    );
    assert.deepEqual(result, { kind: "text", text: "Hello" });
    assert.equal(broker.isActive(token), false);
    assert.equal(lifecycle.status().activeToolTurns, 0);
  } finally {
    coordinator.close();
  }
});

it("streams bound text and progress before the Full browser completes", async () => {
  const coordinator = new FullTurnCoordinator(new FullTurnBroker());
  const deltas: string[] = [];
  const progress: string[] = [];
  let finish!: (value: string) => void;
  let observed!: () => void;
  const observedText = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const browserOutcome = new Promise<string>((resolve) => {
    finish = resolve;
  });
  try {
    const result = coordinator.run(
      fullInput({
        onDelta: (delta) => {
          deltas.push(delta);
          observed();
        },
        onProgress: (stage) => progress.push(stage),
        runBrowser: async (request) => {
          request.onProgress?.("generating");
          request.onStreamSnapshot?.(`${BRIDGE_TEXT_FRAME_OPEN}\nHello`);
          return browserOutcome;
        },
      }),
    );
    await withDeadline(observedText);
    assert.deepEqual(deltas, ["Hello"]);
    assert.deepEqual(progress, ["generating"]);
    finish("Hello world");
    assert.deepEqual(await withDeadline(result), {
      kind: "text",
      text: "Hello world",
    });
    assert.equal(deltas.join(""), "Hello world");
  } finally {
    coordinator.close();
  }
});

it("reconnects streaming observers to the same Full generation without resubmission", async () => {
  const coordinator = new FullTurnCoordinator(new FullTurnBroker());
  const firstAbort = new AbortController();
  const firstDeltas: string[] = [];
  const nextDeltas: string[] = [];
  let browserRuns = 0;
  let finish!: (value: string) => void;
  let observed!: () => void;
  const observedText = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const browserOutcome = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const input = fullInput({
    runBrowser: async (request) => {
      browserRuns++;
      request.onStreamSnapshot?.(`${BRIDGE_TEXT_FRAME_OPEN}\nHello`);
      return browserOutcome;
    },
  });
  try {
    const first = coordinator.run({
      ...input,
      requestSignal: firstAbort.signal,
      onDelta: (delta) => {
        firstDeltas.push(delta);
        observed();
      },
    });
    await withDeadline(observedText);
    firstAbort.abort();
    await assert.rejects(withDeadline(first), { name: "AbortError" });
    const reconnected = coordinator.run({
      ...input,
      onDelta: (delta) => nextDeltas.push(delta),
    });
    assert.deepEqual(nextDeltas, ["Hello"]);
    finish("Hello world");
    assert.deepEqual(await withDeadline(reconnected), {
      kind: "text",
      text: "Hello world",
    });
    assert.equal(nextDeltas.join(""), "Hello world");
    assert.deepEqual(firstDeltas, ["Hello"]);
    assert.equal(browserRuns, 1);
  } finally {
    coordinator.close();
  }
});

it("buffers markerless rewrites until the Full browser settles", async () => {
  const coordinator = new FullTurnCoordinator(new FullTurnBroker());
  const deltas: string[] = [];
  try {
    const result = await withDeadline(
      coordinator.run(
        fullInput({
          onDelta: (delta) => deltas.push(delta),
          runBrowser: async (request) => {
            request.onStreamSnapshot?.("Interim answer");
            request.onStreamSnapshot?.("Rewritten interim answer");
            assert.deepEqual(deltas, []);
            return "Final answer";
          },
        }),
      ),
    );
    assert.deepEqual(result, { kind: "text", text: "Final answer" });
    assert.deepEqual(deltas, ["Final answer"]);
  } finally {
    coordinator.close();
  }
});

it("does not expose structured JSON deltas before validation", async () => {
  const coordinator = new FullTurnCoordinator(new FullTurnBroker());
  const deltas: string[] = [];
  try {
    const result = await withDeadline(
      coordinator.run(
        fullInput({
          compiled: compileResponsesPrompt({
            metadata: { thread_id: "thread-json", turn_id: "turn-json" },
            input: "Return JSON.",
            text: { format: { type: "json_object" } },
          }),
          onDelta: (delta) => deltas.push(delta),
          runBrowser: async (request) => {
            assert.equal(request.onStreamSnapshot, undefined);
            return '<codex_text>{"ok":true}</codex_text>';
          },
        }),
      ),
    );
    assert.deepEqual(result, { kind: "text", text: '{"ok":true}' });
    assert.deepEqual(deltas, []);
  } finally {
    coordinator.close();
  }
});

it("retires a failed browser while Codex is between Full tool rounds", async () => {
  const broker = new FullTurnBroker();
  const coordinator = new FullTurnCoordinator(broker);
  const lifecycle = new ProviderLifecycleController();
  let fail!: (error: Error) => void;
  let token = "";
  const browserFailure = new Promise<string>((_resolve, reject) => {
    fail = reject;
  });
  const input = fullInput({
    compiled: compileResponsesPrompt({
      metadata: { thread_id: "idle-failure", turn_id: "idle-failure" },
      input: "Read the file.",
      tools: [
        { type: "function", name: "read_file", parameters: { type: "object" } },
      ],
    }),
    acquireToolLease: () => lifecycle.acquireToolTurn(),
    runBrowser: async (request) => {
      token = /turn_[A-Za-z0-9_-]{40,}/u.exec(request.contract)![0];
      void broker.invoke(token, "read_file", { arguments: {} }).catch(() => {});
      return browserFailure;
    },
  });
  try {
    assert.equal(
      (await withDeadline(coordinator.run(input))).kind,
      "tool_calls",
    );
    assert.equal(lifecycle.status().activeToolTurns, 1);
    fail(new Error("Owned browser closed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(lifecycle.status().activeToolTurns, 0);
    assert.equal(broker.isActive(token), false);
    await assert.rejects(
      withDeadline(coordinator.run(input)),
      /Owned browser closed/u,
    );
  } finally {
    coordinator.close();
  }
});

it("does not acquire a capability or launch the browser for invalid or cancelled startup", async () => {
  const coordinator = new FullTurnCoordinator(new FullTurnBroker());
  let leases = 0;
  let browserRuns = 0;
  const input = fullInput({
    acquireToolLease: () => {
      leases++;
      return { release() {} };
    },
    runBrowser: async () => {
      browserRuns++;
      return "Hello";
    },
  });
  try {
    await assert.rejects(
      coordinator.run({ ...input, connectorName: "bad\nconnector" }),
      /connector name/u,
    );
    await assert.rejects(
      coordinator.run({ ...input, requestSignal: AbortSignal.abort() }),
      { name: "AbortError" },
    );
    assert.equal(leases, 0);
    assert.equal(browserRuns, 0);
  } finally {
    coordinator.close();
  }
});
