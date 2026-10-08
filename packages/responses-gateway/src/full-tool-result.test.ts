import assert from "node:assert/strict";
import { it } from "node:test";
import { FullTurnBroker, fullTurnResultFromCodex } from "./full-turn-broker.js";
import { FullTurnCoordinator } from "./full-turn-coordinator.js";
import { compileResponsesPrompt } from "./prompt.js";

async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native Full image round did not complete")),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it("preserves MCP multimodal content, error status, structured result and metadata", () => {
  const result = {
    content: [
      { type: "text", text: "Image and audio" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
      {
        type: "resource_link",
        name: "source",
        uri: "https://example.com/source",
      },
    ],
    structuredContent: { session_id: 42 },
    isError: true,
    _meta: { status: "partial" },
  };
  assert.deepEqual(fullTurnResultFromCodex(JSON.stringify(result)), result);
});

it("converts native Responses image output to MCP image bytes without textual base64", () => {
  const native = [
    { type: "input_text", text: "Native image" },
    { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
  ];
  assert.deepEqual(fullTurnResultFromCodex("Native image", native), {
    content: [
      { type: "text", text: "Native image" },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    ],
  });
});

it("keeps plain JSON command results structured and plain strings textual", () => {
  const result = fullTurnResultFromCodex('{"session_id":42,"output":"ready"}');
  assert.deepEqual(result.structuredContent, {
    session_id: 42,
    output: "ready",
  });
  assert.deepEqual(result.content, [
    { type: "text", text: '{"session_id":42,"output":"ready"}' },
  ]);
  assert.deepEqual(fullTurnResultFromCodex("raw command output"), {
    content: [{ type: "text", text: "raw command output" }],
  });
});

it("returns native image bytes to the waiting Full connector without a second Web submission", async () => {
  const broker = new FullTurnBroker();
  const coordinator = new FullTurnCoordinator(broker);
  let runs = 0;
  let delivered: unknown;
  const initial = {
    metadata: { thread_id: "image-thread", turn_id: "image-turn" },
    input: [{ role: "user", content: "Inspect the local image." }],
    tools: [
      {
        type: "function",
        name: "view_image",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ],
  };
  const input = {
    compiled: compileResponsesPrompt(initial),
    model: "codexgpt-bridge/high",
    mode: "high" as const,
    connectorName: "Bridge",
    operationId: "image-op",
    requestSignal: AbortSignal.timeout(5_000),
    acquireToolLease: () => ({ release() {} }),
    runBrowser: async (request: { contract: string }) => {
      runs++;
      const token = /turn_[A-Za-z0-9_-]{40,}/u.exec(request.contract)![0];
      delivered = await broker.invoke(token, "view_image", {
        arguments: { path: "C:/images/local.png" },
      });
      return "Image inspected.";
    },
  };
  try {
    const first = await deadline(coordinator.run(input));
    assert.equal(first.kind, "tool_calls");
    if (first.kind !== "tool_calls") assert.fail("expected native image call");
    const next = compileResponsesPrompt({
      ...initial,
      input: [
        ...initial.input,
        {
          type: "function_call_output",
          call_id: first.calls[0]!.callId,
          output: [
            { type: "input_text", text: "Image result" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,aGVsbG8=",
            },
          ],
        },
      ],
    });
    // Prompt compilation still avoids embedding image bytes in its textual summary.
    assert.equal(next.toolResults[0]!.output, "Image result");
    assert.deepEqual(
      await deadline(coordinator.run({ ...input, compiled: next })),
      {
        kind: "text",
        text: "Image inspected.",
      },
    );
    assert.deepEqual(delivered, {
      content: [
        { type: "text", text: "Image result" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ],
    });
    assert.equal(runs, 1);
  } finally {
    coordinator.close();
  }
});
