import assert from "node:assert/strict";
import { it } from "node:test";
import { FullTurnBroker } from "./full-turn-broker.js";
import { RetainedFullSourceUnavailableError } from "./full-turn-coordinator.js";
import { ResponsesGateway } from "./responses-server.js";
import { BRIDGE_PROGRESS_TEXT } from "./bridge-progress.js";
import { estimateBridgeInputTokens } from "./input-tokens.js";
import WebSocket from "ws";

it("Full WebSocket usage excludes the unused Simple tool catalog", async () => {
  const broker = new FullTurnBroker();
  let expectedInput = 0;
  const gateway = new ResponsesGateway({
    port: 0,
    fullMcp: { broker, enabled: () => true, connectorName: () => "Bridge" },
    runWebTurn: async (input) => {
      expectedInput = input.execution!.sourceContextTokens;
      return "Hello";
    },
  });
  let socket: WebSocket | undefined;
  try {
    const address = await gateway.start();
    socket = new WebSocket(
      `${address.baseUrl.replace("http:", "ws:")}/responses`,
      {
        headers: { authorization: "Bearer test" },
      },
    );
    const completed = new Promise<{ usage: { input_tokens: number } }>(
      (resolve, reject) => {
        socket!.once("error", reject);
        socket!.on("message", (data) => {
          const event = JSON.parse(data.toString());
          if (event.type === "response.failed" || event.type === "error")
            reject(new Error(JSON.stringify(event)));
          if (event.type === "response.completed") resolve(event.response);
        });
        socket!.once("open", () =>
          socket!.send(
            JSON.stringify({
              type: "response.create",
              model: "codexgpt-bridge/high",
              metadata: {
                thread_id: "full-ws-usage",
                turn_id: "full-ws-usage",
              },
              input: "Say hello.",
              tools: [
                {
                  type: "function",
                  name: "unused_tool",
                  description: " unused-schema".repeat(45_000),
                  parameters: { type: "object" },
                },
              ],
            }),
          ),
        );
      },
    );
    const result = await deadline(completed);
    assert.ok(expectedInput < 10_000);
    assert.equal(result.usage.input_tokens, expectedInput);
  } finally {
    socket?.terminate();
    await gateway.close();
  }
});

for (const stream of [false, true]) {
  it(`Full ${stream ? "SSE" : "JSON"} usage excludes the unused Simple tool catalog`, async () => {
    const broker = new FullTurnBroker();
    let expectedInput = 0;
    let runs = 0;
    const gateway = new ResponsesGateway({
      port: 0,
      fullMcp: { broker, enabled: () => true, connectorName: () => "Bridge" },
      runWebTurn: async (input) => {
        runs++;
        assert.equal(input.allowWebNativeTools, true);
        assert.doesNotMatch(input.contract ?? "", /unused-schema/);
        expectedInput = estimateBridgeInputTokens({
          instructions: input.context!.instructions,
          history: input.context!.history,
          contract: input.contract ?? "",
          prompt: input.prompt,
          images: input.images,
        });
        return "Hello";
      },
    });
    try {
      const address = await gateway.start();
      const response = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/high",
          metadata: { thread_id: "full-usage", turn_id: "full-usage" },
          input: "Say hello.",
          stream,
          tools: [
            {
              type: "function",
              name: "unused_tool",
              description: " unused-schema".repeat(45_000),
              parameters: { type: "object" },
            },
          ],
        }),
      });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      const result = stream
        ? body
            .split("\n")
            .filter((line) => line.startsWith("data: {"))
            .map((line) => JSON.parse(line.slice(6)))
            .find((event) => event.type === "response.completed")?.response
        : JSON.parse(body);
      assert.equal(runs, 1, body);
      assert.ok(result?.usage, body);
      assert.ok(expectedInput < 10_000);
      assert.equal(result.usage.input_tokens, expectedInput);
      assert.equal(
        result.usage.total_tokens,
        result.usage.input_tokens + result.usage.output_tokens,
      );
    } finally {
      await gateway.close();
    }
  });
}

it("Full resumed tool rounds count canonical history without resending the browser turn", async () => {
  const broker = new FullTurnBroker();
  let runs = 0;
  const gateway = new ResponsesGateway({
    port: 0,
    fullMcp: { broker, enabled: () => true, connectorName: () => "Bridge" },
    runWebTurn: async (input) => {
      runs++;
      const result = await broker.invoke(input.turnToken!, "read_file", {});
      assert.equal(result.isError, undefined);
      return "Read complete";
    },
  });
  try {
    const address = await gateway.start();
    const tools = [
      {
        type: "function",
        name: "read_file",
        description: " unused-schema".repeat(45_000),
        parameters: { type: "object" },
      },
    ];
    const input: unknown[] = [{ role: "user", content: "Read the file." }];
    const send = (input: unknown[]) =>
      fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/high",
          metadata: {
            thread_id: "full-round-usage",
            turn_id: "full-round-usage",
          },
          tools,
          input,
        }),
      });
    const first = await send(input);
    const firstBody = await first.json();
    assert.equal(first.status, 200, JSON.stringify(firstBody));
    assert.equal(firstBody.output[0].type, "function_call");
    assert.ok(firstBody.usage.input_tokens < 10_000);
    const second = await send([
      ...input,
      firstBody.output[0],
      {
        type: "function_call_output",
        call_id: firstBody.output[0].call_id,
        output: " evidence".repeat(5_000),
      },
    ]);
    const secondBody = await second.json();
    assert.equal(second.status, 200, JSON.stringify(secondBody));
    assert.equal(secondBody.output[0].content[0].text, "Read complete");
    assert.ok(
      secondBody.usage.input_tokens > firstBody.usage.input_tokens + 4_900,
    );
    assert.ok(
      secondBody.usage.input_tokens < firstBody.usage.input_tokens + 6_000,
    );
    assert.equal(runs, 1);
  } finally {
    await gateway.close();
  }
});

it("Full still rejects genuinely oversized canonical history", async () => {
  const broker = new FullTurnBroker();
  let runs = 0;
  const gateway = new ResponsesGateway({
    port: 0,
    fullMcp: { broker, enabled: () => true, connectorName: () => "Bridge" },
    runWebTurn: async () => {
      runs++;
      return "must not run";
    },
  });
  try {
    const address = await gateway.start();
    const response = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        metadata: {
          thread_id: "full-large-history",
          turn_id: "full-large-history",
        },
        input: " evidence".repeat(100_000),
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(
      (await response.json()).error.code,
      "bridge_context_limit_exceeded",
    );
    assert.equal(runs, 0);
  } finally {
    await gateway.close();
  }
});

for (const missingSource of [false, true]) {
  it(`Full compact HTTP ${missingSource ? "rebuilds a read-only checkpoint when restoration fails before Send" : "accepts the retained source's one-shot receipt"}`, async () => {
    const broker = new FullTurnBroker();
    let runs = 0;
    let retainedAttempts = 0;
    const summary =
      "Goal: say hello. Completed: original Full reply. Evidence: reply was received. Next: preserve the active constraints.";
    const gateway = new ResponsesGateway({
      port: 0,
      fullMcp: { broker, enabled: () => true, connectorName: () => "Bridge" },
      runWebTurn: async (input) => {
        runs++;
        if (runs === 1) {
          assert.equal(input.allowWebNativeTools, true);
          return "Original Full reply";
        }
        if (input.requireRetainedConversation) {
          retainedAttempts++;
          assert.equal(input.execution?.operationToolTransport, "full");
          assert.equal(input.execution?.toolCount, 1);
          if (missingSource) throw new RetainedFullSourceUnavailableError();
          const token = /turn_[A-Za-z0-9_-]{40,}/u.exec(
            input.contract ?? "",
          )![0];
          const capability = /checkpoint_[A-Za-z0-9_-]{40,}/u.exec(
            input.contract ?? "",
          )![0];
          broker.submitCheckpoint(token, {
            checkpoint_token: capability,
            summary,
          });
          return "Checkpoint submitted";
        }
        assert.equal(missingSource, true);
        assert.equal(input.allowWebNativeTools, undefined);
        assert.equal(input.execution?.toolTransport, "none");
        assert.match(input.contract ?? "", /Do not call tools/u);
        assert.match(
          input.context?.history.join("\n") ?? "",
          /Original Full reply/u,
        );
        return summary;
      },
    });
    try {
      const address = await gateway.start();
      const request = (path: string, body: unknown) =>
        fetch(`${address.baseUrl}/${path}`, {
          method: "POST",
          headers: {
            authorization: "Bearer test",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      const first = await request("responses", {
        model: "codexgpt-bridge/high",
        metadata: { thread_id: "compact-http", turn_id: "source-http" },
        input: "Hello",
        stream: false,
      });
      assert.equal(first.status, 200);
      await first.json();
      const compact = await request("responses/compact", {
        model: "codexgpt-bridge/high",
        metadata: { thread_id: "compact-http", turn_id: "compact-http" },
        input: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Original Full reply" },
        ],
      });
      assert.equal(compact.status, 200);
      const result = (await compact.json()) as {
        output: Array<{ type: string; encrypted_content: string }>;
      };
      assert.equal(result.output[0]!.type, "compaction");
      assert.equal(
        Buffer.from(
          result.output[0]!.encrypted_content.slice("cgb1:".length),
          "base64",
        ).toString("utf8"),
        summary,
      );
      assert.equal(retainedAttempts, 1);
      assert.equal(runs, missingSource ? 3 : 2);
    } finally {
      await gateway.close();
    }
  });
}

async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Full SSE did not deliver before browser completion"),
            ),
          3_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const toolChoice of [undefined, "none"] as const) {
  it(`Full SSE keeps progress live and commits settled text with tool_choice ${toolChoice ?? "auto"}`, async () => {
    const broker = new FullTurnBroker();
    let runs = 0;
    let finish!: (value: string) => void;
    const browserResult = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const gateway = new ResponsesGateway({
      port: 0,
      fullMcp: { broker, enabled: () => true, connectorName: () => "Bridge" },
      runWebTurn: async (input) => {
        runs++;
        assert.equal(input.allowWebNativeTools, true);
        assert.equal(input.connectorName, "Bridge");
        assert.equal(input.execution?.operationToolTransport, "full");
        assert.equal(input.execution?.toolTransport, "full");
        assert.equal(input.execution?.toolCount, 0);
        const token = /turn_[A-Za-z0-9_-]{40,}/u.exec(input.contract ?? "")![0];
        assert.equal(broker.inventory(token).total, 0);
        input.onProgress?.("generating");
        input.onStreamSnapshot?.("Live Full");
        input.onStreamSnapshot?.("Rewritten interim Full answer");
        return browserResult;
      },
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const address = await gateway.start();
      const response = await deadline(
        fetch(`${address.baseUrl}/responses`, {
          method: "POST",
          headers: {
            authorization: "Bearer test",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "codexgpt-bridge/high",
            metadata: { thread_id: "full-sse", turn_id: "full-sse" },
            input: "Say hello.",
            stream: true,
            ...(toolChoice
              ? {
                  tool_choice: toolChoice,
                  tools: [
                    {
                      type: "function",
                      name: "read_file",
                      parameters: { type: "object" },
                    },
                  ],
                }
              : {}),
          }),
        }),
      );
      assert.equal(response.status, 200);
      reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let body = "";
      await deadline(
        (async () => {
          while (!body.includes(BRIDGE_PROGRESS_TEXT.working)) {
            const chunk = await reader!.read();
            assert.equal(chunk.done, false);
            body += decoder.decode(chunk.value, { stream: true });
          }
        })(),
      );
      assert.ok(body.includes(BRIDGE_PROGRESS_TEXT.working));
      assert.doesNotMatch(body, /Live Full|Rewritten interim/u);
      assert.doesNotMatch(body, /event: response\.completed/u);
      finish("Live Full answer");
      await deadline(
        (async () => {
          for (;;) {
            const chunk = await reader!.read();
            if (chunk.done) break;
            body += decoder.decode(chunk.value, { stream: true });
          }
        })(),
      );
      const events = body
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
      assert.equal(
        events
          .filter(
            (event) =>
              event.type === "response.output_text.delta" &&
              !String(event.item_id).includes("_bridge_"),
          )
          .map((event) => event.delta)
          .join(""),
        "Live Full answer",
      );
      assert.equal(
        events.filter((event) => event.type === "response.completed").length,
        1,
      );
      assert.doesNotMatch(body, /turn_[A-Za-z0-9_-]{40,}/u);
      assert.equal(runs, 1);
    } finally {
      finish("cancelled");
      await reader?.cancel().catch(() => {});
      await gateway.close();
    }
  });
}
