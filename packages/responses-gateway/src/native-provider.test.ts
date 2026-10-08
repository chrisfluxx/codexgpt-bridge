import assert from "node:assert/strict";
import { it } from "node:test";
import WebSocket from "ws";
import {
  BridgeTextStream,
  isBridgeTextStreamCandidate,
} from "./text-stream.js";
import { compileResponsesPrompt } from "./prompt.js";
import {
  BRIDGE_TEXT_FRAME_OPEN,
  prepareBridgeWebTurn,
  parseBridgeWebTurnResult,
  UnsupportedWebNativeToolError,
} from "./tool-protocol.js";
import { ResponsesGateway } from "./responses-server.js";
import { responsesOperationId } from "./operation-identity.js";
import { BRIDGE_PROGRESS_TEXT } from "./bridge-progress.js";
import {
  bridgeProgressText,
  isBridgeProgressMessage,
} from "./bridge-progress.js";

it("streams network text without exposing split frame tags, tools or broken Unicode", () => {
  const deltas: string[] = [];
  const stream = new BridgeTextStream((delta) => deltas.push(delta));
  stream.updateNetwork("<codex_text>INTERIM_COMPLETE_FRAME</codex_text>");
  assert.deepEqual(deltas, []);
  stream.updateNetwork('<codex_tool_calls>[{"name":"read"}]');
  assert.deepEqual(deltas, []);
  stream.updateNetwork("<codex_text>你好\ud83d");
  assert.equal(deltas.join(""), "你好");
  stream.updateNetwork("<codex_text>你好😀</codex_");
  assert.equal(deltas.join(""), "你好😀");
  stream.updateNetwork("<codex_text>你好😀</codex_text>");
  stream.update("<codex_text>你好😀</codex_text>", true);
  assert.deepEqual(deltas, ["你好", "😀"]);
  assert.throws(() => stream.updateNetwork("<codex_text>changed"), /rewrote/);
  assert.throws(() => stream.update("你好😀", true), /lost/);
});

it("streams Markdown-safe comment frames and accepts their unframed DOM result", () => {
  const deltas: string[] = [];
  const stream = new BridgeTextStream((delta) => deltas.push(delta));
  stream.updateNetwork("<!--codex_text-->\n```text\nCodex");
  stream.updateNetwork("<!--codex_text-->\n```text\nCodex\n  |\n  v\n");
  stream.updateNetwork(
    "<!--codex_text-->\n```text\nCodex\n  |\n  v\nChatGPT Web\n```\n<!--/codex_text-->",
  );
  stream.update("```text\nCodex\n  |\n  v\nChatGPT Web\n```", true);

  assert.equal(deltas.join(""), "```text\nCodex\n  |\n  v\nChatGPT Web\n```");
});

it("buffers ordinary Markdown without markers until the settled final response", () => {
  for (const markdown of [
    "你好😀\n\nI don't know.",
    "```text\nCodex\n  |\n  v\nChatGPT Web\n```",
    "# Heading\n\n| A | B |\n|---|---|\n| 1 | 2 |",
    "<!-- ordinary comment -->\n\nAnswer",
  ]) {
    const deltas: string[] = [];
    const stream = new BridgeTextStream((delta) => deltas.push(delta));
    for (let end = 1; end <= markdown.length; end++) {
      stream.updateNetwork(`\n${markdown.slice(0, end)}`);
      assert.deepEqual(deltas, []);
    }
    stream.update(`\n${markdown}\n`, true);
    stream.update(markdown, true);
    assert.equal(deltas.join(""), markdown);
    assert.throws(() => stream.update("changed", true), /disagrees/u);
  }
});

it("accepts a markerless network rewrite before final text is committed", () => {
  const deltas: string[] = [];
  const stream = new BridgeTextStream((delta) => deltas.push(delta));
  stream.updateNetwork("Interim answer");
  stream.updateNetwork("Completely rewritten interim answer");
  assert.deepEqual(deltas, []);
  stream.update("Final answer", true);
  assert.deepEqual(deltas, ["Final answer"]);
});

it("withholds every split tool prefix while allowing ordinary opening code blocks", () => {
  for (const envelope of [
    '<codex_tool_calls>[{"name":"read"}]</codex_tool_calls>',
    '<CODEX_TOOL_CALL>{"name":"read"}</CODEX_TOOL_CALL>',
    '```text\n<codex_tool_calls>[{"name":"read"}]</codex_tool_calls>\n```',
    '```json\r\n<codex_tool_call>{"name":"read"}</codex_tool_call>\r\n```',
  ]) {
    const stream = new BridgeTextStream(() =>
      assert.fail("tool leaked as text"),
    );
    for (let end = 1; end <= envelope.length; end++) {
      const prefix = envelope.slice(0, end);
      assert.equal(isBridgeTextStreamCandidate(prefix), false);
      stream.updateNetwork(prefix);
    }
    stream.update(envelope, true);
  }
  for (const plain of ["```text\nHello", "```ts\nconst x = 1;", "<div>Hello"]) {
    assert.equal(isBridgeTextStreamCandidate(plain), true);
  }
  const closed = "<!--codex_text-->\nold answer\n<!--/codex_text-->";
  assert.equal(isBridgeTextStreamCandidate(closed), false);
  assert.equal(isBridgeTextStreamCandidate(closed, true), true);
});

it("allows uncommitted ordinary text to be replaced by a tool envelope", () => {
  const deltas: string[] = [];
  const stream = new BridgeTextStream((delta) => deltas.push(delta));
  stream.updateNetwork("Answer");
  stream.updateNetwork("```text\n<codex_tool_calls>");
  stream.update('<codex_tool_calls>[{"name":"read"}]</codex_tool_calls>', true);
  assert.deepEqual(deltas, []);
});

it("normalizes rendered comment-frame padding without changing streamed body text", () => {
  for (const padding of ["\n", "\r\n\r\n", "\n \n"]) {
    const deltas: string[] = [];
    const stream = new BridgeTextStream((delta) => deltas.push(delta));
    stream.updateNetwork(`<!--codex_text-->${padding}`);
    assert.deepEqual(deltas, []);
    stream.updateNetwork(`<!--codex_text-->${padding}first\n\n`);
    assert.equal(deltas.join(""), "first");
    stream.updateNetwork(`<!--codex_text-->${padding}first\n\nsecond\n`);
    stream.updateNetwork(
      `<!--codex_text-->${padding}first\n\nsecond\n<!--/codex_text-->`,
    );
    stream.update(
      "<!--codex_text-->\n\nfirst\n\nsecond\n\n<!--/codex_text-->",
      true,
    );
    assert.equal(deltas.join(""), "first\n\nsecond");
    assert.throws(() => stream.update("changed body", true), /disagrees/);
  }
});

it("excludes dynamic queue notices from history but preserves user quotes", () => {
  const text = bridgeProgressText("queued_2");
  const notice = {
    type: "message",
    role: "assistant",
    phase: "commentary",
    id: "msg_test_bridge_queued_2",
    content: [{ type: "output_text", text }],
  };
  assert.equal(isBridgeProgressMessage(notice), true);
  assert.equal(isBridgeProgressMessage({ ...notice, role: "user" }), false);
  assert.equal(isBridgeProgressMessage({ ...notice, id: "ordinary" }), false);
  assert.equal(bridgeProgressText("queued_-1"), undefined);
});

it("excludes cooldown status from model history without dropping user text", () => {
  const text = bridgeProgressText("cooldown_120");
  assert.match(text!, /120/);
  const notice = {
    role: "assistant",
    phase: "commentary",
    id: "msg_test_bridge_cooldown_120",
    content: [{ type: "output_text", text }],
  };
  assert.equal(isBridgeProgressMessage(notice), true);
  assert.equal(isBridgeProgressMessage({ ...notice, role: "user" }), false);
  assert.equal(bridgeProgressText("cooldown_-1"), undefined);
  assert.doesNotMatch(bridgeProgressText("queued_2")!, /一次執行一個/);
});

for (const transport of ["http", "websocket"] as const) {
  it(
    `${transport} delivers a network delta before browser completion`,
    { timeout: 5000 },
    async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let finished = false;
      const gateway = new ResponsesGateway({
        port: 0,
        runWebTurn: async (input) => {
          input.onProgress?.("queued_2");
          input.onStreamSnapshot?.(`${BRIDGE_TEXT_FRAME_OPEN}\n你好`);
          await gate;
          input.onStreamSnapshot?.(`${BRIDGE_TEXT_FRAME_OPEN}\n你好世界`);
          finished = true;
          return "你好世界";
        },
      });
      const address = await gateway.start();
      const request = {
        model: "codexgpt-bridge/high",
        input: "hello",
        stream: true,
      };
      const events: Record<string, unknown>[] = [];
      const observe = (event: Record<string, unknown>) => {
        events.push(event);
        if (
          event.type === "response.output_text.delta" &&
          event.delta === "你好"
        ) {
          assert.equal(
            finished,
            false,
            "must reach the client before browser completion",
          );
          release();
        }
      };
      let socket: WebSocket | undefined;
      try {
        if (transport === "http") {
          const response = await fetch(address.baseUrl + "/responses", {
            method: "POST",
            headers: {
              authorization: "Bearer test",
              "content-type": "application/json",
            },
            body: JSON.stringify(request),
          });
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let pending = "";
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            pending += decoder.decode(chunk.value, { stream: true });
            let end: number;
            while ((end = pending.indexOf("\n")) >= 0) {
              const line = pending.slice(0, end);
              pending = pending.slice(end + 1);
              if (line.startsWith("data: {"))
                observe(JSON.parse(line.slice(6)));
            }
          }
        } else {
          socket = new WebSocket(
            address.baseUrl.replace(/^http/, "ws") + "/responses",
            {
              headers: {
                authorization: "Bearer test",
                "x-codex-routing-hint": "model=codexgpt-bridge/high",
              },
            },
          );
          const connection = socket;
          await new Promise<void>((resolve, reject) => {
            connection.on("error", reject);
            connection.on("open", () =>
              connection.send(
                JSON.stringify({ type: "response.create", ...request }),
              ),
            );
            connection.on("message", (data) => {
              try {
                const event = JSON.parse(data.toString());
                observe(event);
                if (event.type === "response.completed") resolve();
                if (event.type === "response.failed")
                  reject(new Error(data.toString()));
              } catch (error) {
                reject(error);
              }
            });
          });
        }
        assert.equal(
          events.filter((event) => event.type === "response.completed").length,
          1,
        );
        assert.deepEqual(
          events
            .filter(
              (event) =>
                event.type === "response.output_text.delta" &&
                event.output_index === 1,
            )
            .map((event) => event.delta),
          ["你好", "世界"],
        );
      } finally {
        release();
        socket?.terminate();
        await gateway.close();
      }
    },
  );
}

it("does not repair or execute tools after visible text fails", async () => {
  let calls = 0;
  const gateway = new ResponsesGateway({
    port: 0,
    runWebTurn: async (input) => {
      calls++;
      input.onStreamSnapshot?.("<codex_text>partial");
      throw new UnsupportedWebNativeToolError();
    },
  });
  const address = await gateway.start();
  try {
    const response = await fetch(address.baseUrl + "/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: "do work",
        stream: true,
        tools: [
          {
            type: "function",
            name: "read",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    });
    const body = await response.text();
    assert.match(body, /response.failed/);
    assert.doesNotMatch(
      body,
      /response.completed|response.function_call_arguments/,
    );
    assert.equal(calls, 1);
  } finally {
    await gateway.close();
  }
});

it("keeps adapter progress out of replay history and reconnect identity", () => {
  const progress = Object.entries(BRIDGE_PROGRESS_TEXT).map(
    ([stage, text]) => ({
      id: `msg_fixture_bridge_${stage}`,
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", annotations: [], text }],
    }),
  );
  const user = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "test" }],
  };
  const reply = {
    type: "message",
    role: "assistant",
    phase: "final_answer",
    content: [{ type: "output_text", annotations: [], text: "test OK" }],
  };
  const current = { role: "user", content: "test2" };
  const metadata = { turn_id: "turn-retry", thread_id: "thread-retry" };
  const before = compileResponsesPrompt({
    metadata,
    input: [user, reply, current],
  });
  const retry = compileResponsesPrompt({
    metadata,
    input: [user, ...progress, reply, current, ...progress],
  });
  const rebuilt = compileResponsesPrompt({
    metadata,
    input: [
      user,
      ...progress.map(({ id: _id, ...item }) => item),
      reply,
      current,
    ],
  });
  for (const compiled of [retry, rebuilt]) {
    assert.deepEqual(compiled.context, before.context);
    assert.equal(
      responsesOperationId("codexgpt-bridge/high", compiled),
      responsesOperationId("codexgpt-bridge/high", before),
    );
  }
});

it("preserves user quotes, substantive commentary, annotated text and tool results", () => {
  const reserved = BRIDGE_PROGRESS_TEXT.preparing;
  const commentary = (text: string) => ({
    type: "message",
    role: "assistant",
    phase: "commentary",
    content: [{ type: "output_text", text }],
  });
  const keep = [
    { role: "user", content: reserved },
    commentary("Bridge：正在修復狀態回灌，已修改兩個檔案。"),
    { ...commentary(reserved), id: "user-authored-commentary" },
    { ...commentary(reserved), phase: "final_answer" },
    {
      ...commentary(reserved),
      content: [
        {
          type: "output_text",
          text: reserved,
          annotations: [{ type: "file_citation", file_id: "evidence" }],
        },
      ],
    },
    {
      type: "function_call",
      call_id: "call-one",
      name: "read",
      arguments: "{}",
    },
    { type: "function_call_output", call_id: "call-one", output: reserved },
  ];
  const history = compileResponsesPrompt({
    input: [...keep, { role: "user", content: "continue" }],
  }).context.history;
  assert.equal(history.length, keep.length);
  assert.match(history.join("\n"), /file_citation|已修改兩個檔案/);
  const trailing = compileResponsesPrompt({
    input: [...keep, commentary(reserved)],
  });
  assert.equal(trailing.toolResults[0]?.output, reserved);
  assert.equal(trailing.toolResults[0]?.callId, "call-one");
});

it("does not turn a failed template plus tool block into a successful text reply", () => {
  const prepared = prepareBridgeWebTurn(
    compileResponsesPrompt({
      input: "Build minesweeper",
      tools: [{ type: "custom", name: "exec" }],
    }),
  );
  const mixed =
    '## 載入應用程式時發生錯誤\n\nFailed to fetch template\n\n```text\n<codex_tool_calls>[{"name":"exec","input":"patch"}]</codex_tool_calls>\n```';
  assert.throws(
    () => parseBridgeWebTurnResult(mixed, prepared),
    UnsupportedWebNativeToolError,
  );
  assert.throws(
    () =>
      parseBridgeWebTurnResult(
        "## 載入應用程式時發生錯誤\n\nFailed to fetch template\n\nNormal assistant prose",
        prepared,
      ),
    UnsupportedWebNativeToolError,
  );
  assert.equal(
    parseBridgeWebTurnResult(`<codex_text>${mixed}</codex_text>`, prepared)
      .kind,
    "text",
  );
});

for (const transport of ["http", "websocket"] as const) {
  for (const resultKind of ["text", "tool", "image", "failure"] as const) {
    it(
      `${transport} delivers commentary before ${resultKind} completion with consistent indices`,
      { timeout: 8000 },
      async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let finished = false;
        let observedEarly = false;
        const gateway = new ResponsesGateway({
          port: 0,
          runWebTurn: async (input) => {
            input.onProgress?.("queued");
            input.onProgress?.("preparing");
            input.onProgress?.("rebuilding");
            input.onProgress?.("selecting");
            input.onProgress?.("submitting");
            input.onProgress?.("generating");
            input.onProgress?.("generating"); // Repeated DOM polling is not another message.
            input.onSnapshot?.(
              '<codex_tool_calls>[{"name":"exec","input":"partial',
            );
            await gate;
            input.onProgress?.("receiving");
            input.onProgress?.("validating");
            finished = true;
            if (resultKind === "failure")
              throw new Error("TEST_PROVIDER_FAILED");
            if (resultKind === "tool")
              return '<codex_tool_calls>[{"name":"exec","input":"run"}]</codex_tool_calls>';
            if (resultKind === "image")
              return {
                kind: "generated_images",
                text: "Caption",
                images: [
                  {
                    base64: "eA==",
                    mimeType: "image/png",
                    localPath: "C:/test.png",
                  },
                ],
              };
            return "<codex_text>Finished answer</codex_text>";
          },
        });
        const address = await gateway.start();
        const request = {
          model: "codexgpt-bridge/high",
          input: "test",
          stream: true,
          tools: [{ type: "custom", name: "exec" }],
        };
        type Event = {
          type: string;
          sequence_number: number;
          output_index?: number;
          item_id?: string;
          delta?: string;
          item?: { id: string; type: string; phase?: string };
          response?: {
            status: string;
            output: Array<{ id: string; type: string; phase?: string }>;
          };
        };
        const events: Event[] = [];
        const accept = (event: Event) => {
          events.push(event);
          if (
            event.type === "response.output_text.delta" &&
            event.delta?.includes("Bridge：") &&
            !observedEarly
          ) {
            assert.equal(
              finished,
              false,
              "Progress must arrive while generation is still blocked",
            );
            observedEarly = true;
            release();
          }
        };
        let socket: WebSocket | undefined;
        try {
          if (transport === "http") {
            const response = await fetch(address.baseUrl + "/responses", {
              method: "POST",
              headers: {
                authorization: "Bearer test",
                "content-type": "application/json",
              },
              body: JSON.stringify(request),
              signal: AbortSignal.timeout(6000),
            });
            assert.ok(response.body);
            const decoder = new TextDecoder();
            let pending = "";
            for await (const chunk of response.body) {
              pending += decoder.decode(chunk, { stream: true });
              const lines = pending.split("\n");
              pending = lines.pop()!;
              for (const line of lines)
                if (line.startsWith("data: {"))
                  accept(JSON.parse(line.slice(6)) as Event);
            }
          } else {
            socket = new WebSocket(
              address.baseUrl.replace(/^http/, "ws") + "/responses",
              {
                headers: {
                  authorization: "Bearer test",
                  "x-codex-routing-hint": "model=codexgpt-bridge/high",
                },
              },
            );
            const connection = socket;
            await new Promise<void>((done, fail) => {
              const timeout = setTimeout(
                () => fail(new Error("Stream did not complete")),
                6000,
              );
              connection.on("error", fail);
              connection.on("open", () =>
                connection.send(
                  JSON.stringify({ type: "response.create", ...request }),
                ),
              );
              connection.on("message", (data) => {
                try {
                  const event = JSON.parse(data.toString()) as Event;
                  accept(event);
                  if (
                    ["response.completed", "response.failed"].includes(
                      event.type,
                    )
                  ) {
                    clearTimeout(timeout);
                    done();
                  }
                } catch (error) {
                  clearTimeout(timeout);
                  fail(error);
                }
              });
            });
          }
          assert.equal(observedEarly, true);
          assert.deepEqual(
            events.map((event) => event.sequence_number),
            events.map((_, index) => index),
          );
          const terminal = events.at(-1)!;
          assert.equal(
            terminal.type,
            resultKind === "failure" ? "response.failed" : "response.completed",
          );
          const output = terminal.response!.output;
          assert.equal(
            output.filter((item) => item.phase === "commentary").length,
            1,
          );
          for (const event of events)
            if (event.output_index !== undefined) {
              assert.equal(
                output[event.output_index]?.id,
                event.item?.id ?? event.item_id,
              );
            }
          assert.equal(
            events.filter((event) => event.type === "response.completed")
              .length,
            resultKind === "failure" ? 0 : 1,
          );
          const answerDeltas = events.filter(
            (event) =>
              event.type === "response.output_text.delta" &&
              !event.delta?.startsWith("Bridge："),
          );
          assert.ok(
            answerDeltas.every(
              (event) => !event.delta?.includes("codex_tool_calls"),
            ),
          );
          if (resultKind === "tool")
            assert.equal(output[1]?.type, "custom_tool_call");
          if (resultKind === "text")
            assert.equal(output[1]?.phase, "final_answer");
        } finally {
          release();
          socket?.terminate();
          await gateway.close();
        }
      },
    );
  }
}

for (const transport of ["http", "websocket"] as const) {
  it(
    `${transport} keeps one routine notice across tool continuations while preserving recovery notices`,
    { timeout: 8000 },
    async () => {
      const gateway = new ResponsesGateway({
        port: 0,
        runWebTurn: async (input) => {
          for (const stage of [
            "queued",
            "preparing",
            "selecting",
            "submitting",
            "generating",
            "receiving",
            "validating",
            "waiting_challenge",
            "waiting_challenge",
            "repairing",
            "cooldown_120",
          ] as const)
            input.onProgress?.(stage);
          return '<codex_tool_calls>[{"name":"exec","input":"run"}]</codex_tool_calls>';
        },
      });
      const address = await gateway.start();
      type Result = {
        id: string;
        output: Array<{
          type: string;
          call_id?: string;
          phase?: string;
          content?: Array<{ text: string }>;
        }>;
      };
      const send = async (
        request: Record<string, unknown>,
      ): Promise<Result> => {
        const body = {
          model: "codexgpt-bridge/high",
          stream: true,
          tools: [{ type: "custom", name: "exec" }],
          ...request,
        };
        if (transport === "http") {
          const response = await fetch(address.baseUrl + "/responses", {
            method: "POST",
            headers: {
              authorization: "Bearer test",
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          });
          assert.equal(response.status, 200);
          const events = (await response.text())
            .split("\n")
            .filter((line) => line.startsWith("data: {"))
            .map(
              (line) =>
                JSON.parse(line.slice(6)) as {
                  type: string;
                  response?: Result;
                },
            );
          assert.equal(events.at(-1)?.type, "response.completed");
          return events.at(-1)!.response!;
        }
        const socket = new WebSocket(
          address.baseUrl.replace(/^http/, "ws") + "/responses",
          { headers: { authorization: "Bearer test" } },
        );
        try {
          return await new Promise<Result>((resolve, reject) => {
            socket.once("error", reject);
            socket.once("open", () =>
              socket.send(JSON.stringify({ type: "response.create", ...body })),
            );
            socket.on("message", (data) => {
              const event = JSON.parse(data.toString()) as {
                type: string;
                response?: Result;
              };
              if (event.type === "response.completed") resolve(event.response!);
              else if (["response.failed", "error"].includes(event.type))
                reject(new Error(JSON.stringify(event)));
            });
          });
        } finally {
          socket.terminate();
        }
      };
      const check = (result: Result, working: boolean): void => {
        const notices = result.output
          .filter((item) => item.phase === "commentary")
          .map((item) => item.content![0]!.text);
        assert.deepEqual(notices, [
          ...(working ? [BRIDGE_PROGRESS_TEXT.working] : []),
          BRIDGE_PROGRESS_TEXT.waiting_challenge,
          BRIDGE_PROGRESS_TEXT.repairing,
          bridgeProgressText("cooldown_120"),
        ]);
        assert.equal(result.output.at(-1)?.type, "custom_tool_call");
      };
      const toolResult = (result: Result) => ({
        type: "custom_tool_call_output",
        call_id: result.output.at(-1)!.call_id,
        output: "done",
      });
      try {
        const metadata = { thread_id: "progress-thread", turn_id: "turn-one" };
        const first = await send({ metadata, input: "test" });
        check(first, true);
        const continued = await send({
          previous_response_id: first.id,
          input: [toolResult(first)],
        });
        check(continued, false);
        check(await send({ metadata, input: "retry" }), false);
        check(
          await send({
            metadata: { ...metadata, turn_id: "turn-two" },
            previous_response_id: continued.id,
            input: "next user request",
          }),
          true,
        );
        check(
          await send({
            metadata: { ...metadata, thread_id: "another-thread" },
            input: "independent request",
          }),
          true,
        );
        const standalone = await send({ input: "without native metadata" });
        check(standalone, true);
        const standaloneContinued = await send({
          previous_response_id: standalone.id,
          input: [toolResult(standalone)],
        });
        check(standaloneContinued, false);
        check(
          await send({
            previous_response_id: standaloneContinued.id,
            input: "another user request without metadata",
          }),
          true,
        );
      } finally {
        await gateway.close();
      }
    },
  );
}

it("repairs the screenshot's mixed reply once and fails instead of printing a second invalid result", async () => {
  let attempts = 0;
  let repaired = false;
  const gateway = new ResponsesGateway({
    port: 0,
    runWebTurn: async () => {
      attempts++;
      if (repaired && attempts % 2 === 0)
        return '<codex_tool_calls>[{"name":"exec","input":"patch"}]</codex_tool_calls>';
      if (attempts % 2 === 0) return "I could not do it.";
      return 'Failed to fetch template\n\n<codex_tool_calls>[{"name":"exec","input":"patch"}]</codex_tool_calls>';
    },
  });
  const address = await gateway.start();
  const post = () =>
    fetch(address.baseUrl + "/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: "Build minesweeper",
        tools: [{ type: "custom", name: "exec" }],
      }),
    });
  try {
    const failed = await post();
    assert.equal(failed.status, 500);
    assert.match(await failed.text(), /after one correction/);
    assert.equal(attempts, 2);
    repaired = true;
    const success = await post();
    const body = (await success.json()) as {
      output: Array<{ type: string; input: string }>;
    };
    assert.equal(success.status, 200);
    assert.equal(body.output[0]?.type, "custom_tool_call");
    assert.equal(body.output[0]?.input, "patch");
    assert.equal(attempts, 4);
  } finally {
    await gateway.close();
  }
});

it("keeps operation identity on reconnect but separates steering, tools and results", () => {
  const input = {
    model: "codexgpt-bridge/high",
    input: "read file",
    instructions: "read carefully",
    metadata: { thread_id: "thread-identity", turn_id: "turn-identity" },
    tools: [
      {
        type: "function",
        name: "read",
        parameters: { type: "object", properties: {} },
      },
    ],
  };
  const id = (body: unknown) =>
    responsesOperationId(input.model, compileResponsesPrompt(body));
  assert.equal(id(input), id({ ...input, instructions: "rebuilt metadata" }));
  assert.notEqual(id(input), id({ ...input, input: "read another file" }));
  assert.notEqual(
    id(input),
    id({ ...input, metadata: { ...input.metadata, turn_id: "turn-next" } }),
  );
  assert.notEqual(id(input), id({ ...input, tools: [] }));
  assert.notEqual(id(input), id({ ...input, tool_choice: "none" }));
});

it("rejects schema-invalid tool arguments without coercing or stripping values", () => {
  const prepared = prepareBridgeWebTurn(
    compileResponsesPrompt({
      input: "read",
      tools: [
        {
          type: "function",
          name: "read",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              limit: { type: "integer", minimum: 1 },
            },
            required: ["path", "limit"],
            additionalProperties: false,
          },
        },
      ],
    }),
  );
  for (const args of [
    { limit: 1 },
    { path: "a", limit: "1" },
    { path: "a", limit: 0 },
    { path: "a", limit: 1, extra: true },
  ]) {
    const envelope = `<codex_tool_calls>${JSON.stringify([{ name: "read", arguments: args }])}</codex_tool_calls>`;
    assert.throws(
      () => parseBridgeWebTurnResult(envelope, prepared),
      /schema validation/,
    );
  }
  const valid =
    '<codex_tool_calls>[{"name":"read","arguments":{"path":"a","limit":1}}]</codex_tool_calls>';
  assert.equal(parseBridgeWebTurnResult(valid, prepared).kind, "tool_calls");
});

it("validates nested and draft-2020-12 schemas, and rejects invalid schemas before a browser turn", () => {
  const prepare = (parameters: unknown) =>
    prepareBridgeWebTurn(
      compileResponsesPrompt({
        input: "test",
        tools: [{ type: "function", name: "f", parameters }],
      }),
    );
  const prepared = prepare({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      data: {
        type: "array",
        prefixItems: [{ enum: ["approved"] }],
        minItems: 1,
      },
    },
    required: ["data"],
  });
  assert.throws(
    () =>
      parseBridgeWebTurnResult(
        '<codex_tool_calls>[{"name":"f","arguments":{"data":["wrong"]}}]</codex_tool_calls>',
        prepared,
      ),
    /schema validation/,
  );
  assert.throws(() => prepare({ type: "nonexistent" }), /schema/);
  assert.throws(
    () => prepare({ $ref: "https://example.invalid/schema" }),
    /schema/,
  );
  assert.throws(() => prepare({ $async: true, type: "object" }), /schema/);
});

for (const transport of ["http", "websocket"] as const) {
  it(
    `${transport} completes once after mutable network and rewritten DOM snapshots`,
    { timeout: 5000 },
    async () => {
      const gateway = new ResponsesGateway({
        port: 0,
        runWebTurn: async (input) => {
          // The network body and rendered Markdown can differ for the same
          // message. Neither snapshot can commit the final response text.
          input.onStreamSnapshot?.("**What");
          input.onStreamSnapshot?.("**What model are you?**");
          for (const text of [
            "<codex_text>What model are you_",
            "<codex_text>What model are you_",
            "<codex_text>What model are you?",
            "", // The page can temporarily replace the answer node.
            "<codex_text>**What model are you?**",
          ])
            input.onSnapshot?.(text);
          return "<codex_text>What model are you?</codex_text>\n";
        },
      });
      const address = await gateway.start();
      const request = {
        model: "codexgpt-bridge/high",
        input: "translate",
        stream: true,
      };
      let socket: WebSocket | undefined;
      try {
        let events: { type: string; delta?: string }[];
        if (transport === "http") {
          const response = await fetch(address.baseUrl + "/responses", {
            method: "POST",
            headers: {
              authorization: "Bearer test",
              "content-type": "application/json",
            },
            body: JSON.stringify(request),
          });
          events = (await response.text())
            .split("\n")
            .filter((line) => line.startsWith("data: {"))
            .map((line) => JSON.parse(line.slice(6)));
        } else {
          socket = new WebSocket(
            address.baseUrl.replace(/^http/, "ws") + "/responses",
            {
              headers: {
                authorization: "Bearer test",
                "x-codex-routing-hint": "model=codexgpt-bridge/high",
              },
            },
          );
          events = [];
          const connection = socket;
          await new Promise<void>((done, fail) => {
            connection.on("error", fail);
            connection.on("open", () =>
              connection.send(
                JSON.stringify({ type: "response.create", ...request }),
              ),
            );
            connection.on("message", (data) => {
              const event = JSON.parse(data.toString()) as {
                type: string;
                delta?: string;
              };
              events.push(event);
              if (event.type === "response.failed")
                fail(new Error(data.toString()));
              if (event.type === "response.completed") done();
            });
          });
        }
        assert.deepEqual(
          events
            .filter((e) => e.type === "response.output_text.delta")
            .map((e) => e.delta),
          ["What model are you?"],
        );
        assert.equal(
          events.filter((e) => e.type === "response.completed").length,
          1,
        );
        assert.equal(
          events.filter((e) => e.type === "response.failed").length,
          0,
        );
      } finally {
        socket?.terminate();
        await gateway.close();
      }
    },
  );
}

it("combines framed streamed text and generated media without duplicate text events", async () => {
  const gateway = new ResponsesGateway({
    port: 0,
    runWebTurn: async (input) => {
      input.onSnapshot?.("<codex_text>Image caption");
      input.onSnapshot?.("<codex_text>Image caption</codex_text>");
      return {
        kind: "generated_images",
        text: "<codex_text>Image caption</codex_text>",
        images: [
          {
            base64: "YQ==",
            mimeType: "image/png",
            localPath: "C:/fixture/image.png",
          },
        ],
      };
    },
  });
  const address = await gateway.start();
  try {
    const response = await fetch(address.baseUrl + "/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: "image",
        stream: true,
      }),
    });
    const text = await response.text();
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map(
        (line) => JSON.parse(line.slice(6)) as { type: string; delta?: string },
      );
    assert.equal(
      events
        .filter((event) => event.type === "response.output_text.delta")
        .map((event) => event.delta)
        .join(""),
      "Image caption\n\n![Generated image 1](<C:/fixture/image.png>)",
    );
    assert.equal(
      events.filter((event) => event.type === "response.completed").length,
      1,
    );
    assert.doesNotMatch(text, /<codex_text>|response.failed/);
  } finally {
    await gateway.close();
  }
});

it("binds unary compaction to the task identity in Codex headers", async () => {
  const gateway = new ResponsesGateway({
    port: 0,
    runWebTurn: async (input) => {
      assert.equal(input.threadId, "thread-header");
      assert.equal(input.turnId, "turn-header");
      return "Goal preserved; next step is verification.";
    },
  });
  const address = await gateway.start();
  try {
    const response = await fetch(address.baseUrl + "/responses/compact", {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread-header",
          turn_id: "turn-header",
        }),
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: [{ role: "user", content: "original goal" }],
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      object: string;
      output: unknown[];
    };
    assert.equal(body.object, "response.compaction");
    assert.equal(body.output.length, 1);
    const automatic = compileResponsesPrompt({ input: body.output });
    assert.match(automatic.prompt, /Continue the current Codex task/);
    assert.match(automatic.context.history.join("\n"), /Goal preserved/);
  } finally {
    await gateway.close();
  }
});

it("hydrates previous_response_id tool continuations and fails on missing history", async () => {
  let calls = 0;
  const gateway = new ResponsesGateway({
    port: 0,
    runWebTurn: async (input) => {
      calls++;
      if (calls === 1)
        return '<codex_tool_calls>[{"name":"read","arguments":{}}]</codex_tool_calls>';
      assert.match(input.context?.history.join("\n") ?? "", /original task/);
      assert.match(input.prompt, /read complete/);
      return "done";
    },
  });
  const address = await gateway.start();
  const post = (body: unknown) =>
    fetch(address.baseUrl + "/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    const first = (await (
      await post({
        model: "codexgpt-bridge/high",
        input: "original task",
        tools: [{ type: "function", name: "read" }],
      })
    ).json()) as { id: string; output: Array<{ call_id: string }> };
    const next = await post({
      model: "codexgpt-bridge/high",
      previous_response_id: first.id,
      input: [
        {
          type: "function_call_output",
          call_id: first.output[0]!.call_id,
          output: "read complete",
        },
      ],
    });
    assert.equal(next.status, 200);
    assert.match(await next.text(), /done/);
    const missing = await post({
      model: "codexgpt-bridge/high",
      previous_response_id: "missing",
      input: "continue",
    });
    assert.equal(missing.status, 500);
    assert.match(await missing.text(), /resend the complete Codex context/);
  } finally {
    await gateway.close();
  }
});

it("keeps framed protocol examples as prose and refuses oversized schemas", () => {
  const compiled = compileResponsesPrompt({
    input: "explain",
    tools: [{ type: "function", name: "read" }],
  });
  const prepared = prepareBridgeWebTurn(compiled);
  const text =
    'Example: <codex_tool_calls>[{"name":"read","arguments":{}}]</codex_tool_calls>';
  assert.deepEqual(
    parseBridgeWebTurnResult("<codex_text>" + text + "</codex_text>", prepared),
    { kind: "text", text },
  );
  assert.throws(
    () =>
      prepareBridgeWebTurn(
        compileResponsesPrompt({
          input: "continue",
          tools: [
            {
              type: "function",
              name: "large",
              description: "x".repeat(1024 * 1024),
            },
          ],
        }),
      ),
    /no schemas were removed/,
  );
});

it("buffers mutable DOM snapshots and commits settled Unicode text once", () => {
  const deltas: string[] = [];
  const stream = new BridgeTextStream((delta) => deltas.push(delta));
  stream.update("<codex_text>你好😀");
  stream.update("<codex_text>你好😀世界");
  stream.update("<codex_text>你好😀世界");
  stream.update("<codex_text>changed_");
  stream.update("");
  assert.deepEqual(deltas, []);
  stream.update("<codex_text>你好😀世界</codex_text>", true);
  assert.equal(deltas.join(""), "你好😀世界");
  stream.update("<codex_text>你好😀世界</codex_text>\n", true);
  assert.deepEqual(deltas, ["你好😀世界"]);
  assert.throws(() => stream.update("<codex_text>changed", true), /Incomplete/);
  const tools = new BridgeTextStream(() => assert.fail("tool leaked as text"));
  tools.update('<codex_tool_calls>[{"name":"read"}]</codex_tool_calls>', true);
});

it("honors explicit tool selection, serial calls, schema formats and large registries", () => {
  const tools = Array.from({ length: 20 }, (_, index) => ({
    type: "function",
    name: `tool_${index}`,
    parameters: { type: "object", properties: { value: { type: "integer" } } },
  }));
  const compiled = compileResponsesPrompt({
    input: "continue",
    tools,
    parallel_tool_calls: false,
  });
  assert.equal(prepareBridgeWebTurn(compiled).tools.length, 20);
  assert.throws(
    () =>
      parseBridgeWebTurnResult(
        '<codex_tool_calls>[{"name":"tool_1","arguments":{}},{"name":"tool_2","arguments":{}}]</codex_tool_calls>',
        prepareBridgeWebTurn(compiled),
      ),
    /Parallel/,
  );
  const searchOnly = prepareBridgeWebTurn(
    compileResponsesPrompt({
      input: "discover",
      tools: [{ type: "tool_search" }, ...tools],
      tool_choice: {
        type: "allowed_tools",
        mode: "auto",
        tools: [{ type: "tool_search" }],
      },
    }),
  );
  assert.deepEqual(
    searchOnly.tools.map((tool) => tool.kind),
    ["tool_search"],
  );
  const forced = prepareBridgeWebTurn(
    compileResponsesPrompt({
      input: "continue",
      tools,
      tool_choice: { type: "function", name: "tool_9" },
    }),
  );
  assert.equal(forced.expectsToolCall, true);
  assert.deepEqual(
    forced.tools.map((tool) => tool.name),
    ["tool_9"],
  );
  const custom = prepareBridgeWebTurn(
    compileResponsesPrompt({
      input: "patch",
      tools: [
        {
          type: "namespace",
          name: "local",
          tools: [
            {
              type: "custom",
              name: "patch",
              format: {
                type: "grammar",
                syntax: "lark",
                definition: "start: /.+/",
              },
            },
          ],
        },
      ],
    }),
  );
  assert.match(custom.contract ?? "", /grammar/);
  const parsed = parseBridgeWebTurnResult(
    '<codex_tool_calls>[{"name":"local__patch","input":"raw patch"}]</codex_tool_calls>',
    custom,
  );
  assert.equal(parsed.kind, "tool_calls");
  if (parsed.kind === "tool_calls")
    assert.equal(parsed.calls[0]?.namespace, "local");
});

it("produces a readable compaction checkpoint and rejects unfinished tools", async () => {
  assert.throws(
    () =>
      compileResponsesPrompt({
        input: [
          { type: "function_call", name: "read", call_id: "call_pending" },
          { type: "compaction_trigger" },
        ],
      }),
    /outstanding/,
  );
  const gateway = new ResponsesGateway({
    port: 0,
    runWebTurn: async (input) => {
      assert.match(input.prompt, /checkpoint/);
      assert.match(input.context?.history.join("\n") ?? "", /original goal/);
      return "Completed file A; next test B. Preserve original goal.";
    },
  });
  const address = await gateway.start();
  try {
    const result = await fetch(address.baseUrl + "/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: [
          { role: "user", content: "original goal" },
          { type: "compaction_trigger" },
        ],
      }),
    });
    const body = (await result.json()) as {
      output: Array<{ type: string; encrypted_content: string }>;
    };
    assert.equal(body.output.length, 1);
    assert.equal(body.output[0]?.type, "compaction");
    const automatic = compileResponsesPrompt({ input: body.output });
    assert.match(automatic.prompt, /Continue the current Codex task/);
    assert.match(automatic.context.history.join("\n"), /Completed file A/);
    const replay = compileResponsesPrompt({
      input: [body.output[0], { role: "user", content: "continue" }],
    });
    assert.match(replay.context.history.join("\n"), /Completed file A/);
  } finally {
    await gateway.close();
  }
});

it(
  "opens SSE before browser completion but delivers text only after settling",
  { timeout: 5000 },
  async () => {
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async (input) => {
        input.onSnapshot?.("<codex_text>first");
        input.onSnapshot?.("<codex_text>first second");
        await done;
        return "<codex_text>first second</codex_text>";
      },
    });
    const address = await gateway.start();
    try {
      const response = await fetch(address.baseUrl + "/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/high",
          stream: true,
          input: "hello",
        }),
      });
      const reader = response.body!.getReader();
      let data = "";
      while (!data.includes("response.created")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        data += new TextDecoder().decode(chunk.value);
      }
      assert.doesNotMatch(data, /response.completed/);
      assert.doesNotMatch(data, /response.output_text.delta/);
      release();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        data += new TextDecoder().decode(chunk.value);
      }
      const events = data
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map(
          (line) =>
            JSON.parse(line.slice(6)) as { type: string; delta?: string },
        );
      assert.equal(
        events.filter((event) => event.type === "response.completed").length,
        1,
      );
      assert.equal(
        events
          .filter((event) => event.type === "response.output_text.delta")
          .map((event) => event.delta)
          .join(""),
        "first second",
      );
    } finally {
      release();
      await gateway.close();
    }
  },
);

it("keeps tool call identifiers stable when a native turn reconnects", async () => {
  const operations: Array<string | undefined> = [];
  let decisionPath = "README.md";
  const gateway = new ResponsesGateway({
    port: 0,
    runWebTurn: async (input) => {
      operations.push(input.operationId);
      return `<codex_tool_calls>${JSON.stringify([{ name: "read", arguments: { path: decisionPath } }])}</codex_tool_calls>`;
    },
  });
  const address = await gateway.start();
  try {
    const request = {
      model: "codexgpt-bridge/high",
      metadata: { thread_id: "thread-123", turn_id: "turn-123" },
      input: "continue",
      tools: [{ type: "function", name: "read" }],
    };
    const post = async (overrides: Record<string, unknown> = {}) => {
      const response = await fetch(address.baseUrl + "/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...request, ...overrides }),
      });
      assert.equal(response.status, 200);
      return response.json() as Promise<{ output: Array<{ call_id: string }> }>;
    };
    const first = (await post()).output[0]!.call_id;
    assert.equal(first, (await post()).output[0]!.call_id);
    assert.equal(
      first,
      (await post({ instructions: "rebuilt instruction metadata\n" }))
        .output[0]!.call_id,
    );
    assert.ok(operations[0]);
    assert.equal(new Set(operations).size, 1);
    assert.notEqual(
      first,
      (await post({ input: "read the other file" })).output[0]!.call_id,
    );
    decisionPath = "different.md";
    assert.notEqual(first, (await post()).output[0]!.call_id);
  } finally {
    await gateway.close();
  }
});

it("rejects a name-independent web-native tool and retries once with the client allow-list", async () => {
  const prompts: string[] = [];
  const gateway = new ResponsesGateway({
    port: 0,
    runWebTurn: async (input) => {
      prompts.push(input.prompt);
      if (prompts.length === 1) throw new UnsupportedWebNativeToolError();
      return '<codex_tool_calls>[{"name":"write_file","arguments":{"path":"game.html","content":"ok"}}]</codex_tool_calls>';
    },
  });
  const address = await gateway.start();
  try {
    const response = await fetch(address.baseUrl + "/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: "Build a browser game",
        tools: [
          {
            type: "function",
            name: "write_file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
              required: ["path", "content"],
            },
          },
        ],
      }),
    });
    const body = (await response.json()) as {
      output: Array<{ type: string; name?: string }>;
    };
    assert.equal(response.status, 200);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1] ?? "", /unsupported ChatGPT Web tool/);
    assert.match(prompts[1] ?? "", /Exact available names: \["write_file"\]/);
    assert.equal(body.output[0]?.type, "function_call");
    assert.equal(body.output[0]?.name, "write_file");
  } finally {
    await gateway.close();
  }
});
