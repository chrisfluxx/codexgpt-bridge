import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { zstdCompressSync } from "node:zlib";
import WebSocket from "ws";
import {
  BRIDGE_AUTO_COMPACT_TOKEN_LIMIT,
  BRIDGE_CONTEXT_BUDGET_PROFILE,
  BRIDGE_CONTEXT_WINDOW,
  BRIDGE_HARD_INPUT_TOKEN_LIMIT,
  CODEXGPT_BRIDGE_WEB_MODEL_IDS,
  ResponsesGateway,
  type BridgeExecutionPreflight,
  type RunWebTurnInput,
  augmentModelsPayload,
  buildStartupModelsPayload,
  synchronizeBridgeExecutionPreflight,
} from "./responses-server.js";
import {
  compileResponsesPrompt,
  responsesNativeTurnIdentity,
} from "./prompt.js";
import { prepareBridgeWebTurn } from "./tool-protocol.js";
import { FullTurnBroker } from "./full-turn-broker.js";
import { FullTurnMcpServer } from "./full-turn-mcp-server.js";

const gateways: ResponsesGateway[] = [];
type JsonRecord = Record<string, unknown>;

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  milliseconds = 2_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

describe("ResponsesGateway", () => {
  it("marks V2 collaboration messages as plaintext in JSON and SSE tool items", async () => {
    for (const stream of [false, true]) {
      for (const name of [
        "spawn_agent",
        "send_message",
        "followup_task",
        "wait_agent",
      ]) {
        const gateway = new ResponsesGateway({
          port: 0,
          runWebTurn: async () =>
            `<codex_tool_calls>[{"name":"collaboration__${name}","arguments":{}}]</codex_tool_calls>`,
        });
        gateways.push(gateway);
        const address = await gateway.start();
        const response = await fetch(`${address.baseUrl}/responses`, {
          method: "POST",
          headers: {
            authorization: "Bearer fixture",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "codexgpt-bridge/high",
            input: "Perform the fixture action.",
            stream,
            tools: [
              {
                type: "namespace",
                name: "collaboration",
                tools: [
                  { type: "function", name, parameters: { type: "object" } },
                ],
              },
            ],
          }),
        });
        assert.equal(response.status, 200);
        const body = await response.text();
        const items = stream
          ? body
              .split("\n")
              .filter((line) => line.startsWith("data: {"))
              .map((line) => JSON.parse(line.slice(6)))
              .filter(
                (event) =>
                  event.type === "response.output_item.added" ||
                  event.type === "response.output_item.done",
              )
              .map((event) => event.item)
              .filter((item) => item.type === "function_call")
          : JSON.parse(body).output;
        assert.ok(items.length > 0);
        for (const item of items) {
          assert.equal(item.namespace, "collaboration");
          assert.equal(item.name, name);
          assert.deepEqual(
            item.encrypted_function_args,
            name === "wait_agent" ? undefined : [],
          );
        }
      }
    }
  });

  it("repairs and validates strict JSON output before streaming it", async () => {
    const browserInputs: Array<{ prompt: string; contract: string }> = [];
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async (input) => {
        browserInputs.push({
          prompt: input.prompt,
          contract: input.contract ?? "",
        });
        return browserInputs.length === 1 ? "不是 JSON" : '{"ok":true}';
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const format = {
      type: "json_schema",
      name: "strict_json_probe",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
      },
    } as const;
    const response = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: "Return the probe result.",
        stream: true,
        text: { format },
      }),
    });
    const body = await response.text();
    const events = body
      .split("\n")
      .filter((line) => line.startsWith("data: {") && !line.includes("[DONE]"))
      .map((line) => JSON.parse(line.slice(6)) as JsonRecord);
    const completed = events.find(
      (event) => event.type === "response.completed",
    )?.response as JsonRecord;

    assert.equal(response.status, 200);
    assert.equal(browserInputs.length, 2);
    assert.match(browserInputs[0]?.contract ?? "", /strict_json_probe/);
    assert.match(
      browserInputs[1]?.prompt ?? "",
      /structured output correction/,
    );
    for (const input of browserInputs) {
      assert.doesNotMatch(input.contract, /codex_text/u);
      assert.doesNotMatch(input.prompt, /codex_text/u);
    }
    assert.doesNotMatch(body, /不是 JSON/);
    assert.equal(
      events
        .filter(
          (event) =>
            event.type === "response.output_text.delta" &&
            !String(event.item_id).includes("_bridge_"),
        )
        .map((event) => event.delta)
        .join(""),
      '{"ok":true}',
    );
    assert.deepEqual((completed.text as JsonRecord).format, format);
    assert.equal(completed.status, "completed");
  });

  it("fails instead of completing after a second schema-invalid reply", async () => {
    let browserRuns = 0;
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async () => {
        browserRuns += 1;
        return "<codex_text>still not JSON</codex_text>";
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const response = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: "Return the probe result.",
        stream: true,
        text: {
          format: {
            type: "json_schema",
            name: "strict_json_probe",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["ok"],
              properties: { ok: { type: "boolean" } },
            },
          },
        },
      }),
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(browserRuns, 2);
    assert.match(body, /response\.failed/);
    assert.match(body, /bridge_structured_output_invalid/);
    assert.doesNotMatch(body, /response\.completed/);
    assert.doesNotMatch(body, /still not JSON/);
  });

  it("serves a turn-scoped MCP call without exposing a fixed workspace runtime", async () => {
    const broker = new FullTurnBroker();
    const turnToken = broker.register(
      "mcp-test",
      [
        {
          kind: "function",
          wireName: "read_file",
          name: "read_file",
          description: "Read one file",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["path"],
            properties: { path: { type: "string" } },
          },
        },
      ],
      true,
    );
    const mcp = new FullTurnMcpServer(broker);
    const address = await mcp.start();
    try {
      const initialized = await fetch(address.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26" },
        }),
      });
      const sessionId = initialized.headers.get("mcp-session-id");
      assert.ok(sessionId);
      const listed = await fetch(address.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      const catalog = (await listed.json()) as {
        result: { tools: Array<{ name: string }> };
      };
      assert.deepEqual(
        catalog.result.tools.map((tool) => tool.name),
        [
          "codex_exec",
          "codex_write_stdin",
          "codex_apply_patch",
          "codex_view_image",
          "codex_tool_inventory",
          "codex_tool_call",
        ],
      );

      const called = fetch(address.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "codex_tool_call",
            arguments: {
              turn_token: turnToken,
              wire_name: "read_file",
              arguments: { path: "README.md" },
            },
          },
        }),
      });
      const batch = await broker.nextBatch(turnToken);
      assert.equal(batch[0]?.wireName, "read_file");
      const toolResult = {
        content: [{ type: "text", text: "README contents" }],
      } as const;
      broker.complete(turnToken, batch[0]!.callId, toolResult);
      broker.complete(turnToken, batch[0]!.callId, toolResult);
      assert.throws(
        () =>
          broker.complete(turnToken, batch[0]!.callId, {
            content: [{ type: "text", text: "different contents" }],
          }),
        /different result/u,
      );
      const response = (await (await called).json()) as {
        result: { content: Array<{ text: string }> };
      };
      assert.equal(response.result.content[0]?.text, "README contents");
    } finally {
      await mcp.close();
      broker.close();
    }
  });

  it("publishes dedicated command, session, patch and image gateways over the turn broker", async () => {
    const broker = new FullTurnBroker();
    const tools = [
      {
        kind: "function" as const,
        wireName: "exec_command",
        name: "exec_command",
        description: "Run a command",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["cmd"],
          properties: {
            cmd: { type: "string" },
            workdir: { type: "string" },
            yield_time_ms: { type: "integer" },
            max_output_tokens: { type: "integer" },
            tty: { type: "boolean" },
          },
        },
      },
      {
        kind: "function" as const,
        wireName: "write_stdin",
        name: "write_stdin",
        description: "Continue a command",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["session_id"],
          properties: {
            session_id: { type: "integer" },
            chars: { type: "string" },
            yield_time_ms: { type: "integer" },
            max_output_tokens: { type: "integer" },
          },
        },
      },
      {
        kind: "custom" as const,
        wireName: "apply_patch",
        name: "apply_patch",
        description: "Apply a patch",
        parameters: {},
        format: { type: "text" },
      },
      {
        kind: "function" as const,
        wireName: "view_image",
        name: "view_image",
        description: "View an image",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            path: { type: "string" },
            detail: { type: "string", enum: ["high", "original"] },
          },
        },
      },
    ];
    const turnToken = broker.register("dedicated-gateway-test", tools, true);
    const otherToken = broker.register(
      "other-dedicated-gateway-test",
      tools,
      true,
    );
    const mcp = new FullTurnMcpServer(broker);
    const address = await mcp.start();
    try {
      const initialized = await fetch(address.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26" },
        }),
      });
      const sessionId = initialized.headers.get("mcp-session-id");
      assert.ok(sessionId);
      let rpcId = 1;
      const call = async (
        name: string,
        args: Record<string, unknown>,
      ): Promise<JsonRecord> => {
        rpcId += 1;
        return (await (
          await fetch(address.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "mcp-session-id": sessionId,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: rpcId,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          })
        ).json()) as JsonRecord;
      };

      const exec = call("codex_exec", {
        turn_token: turnToken,
        cmd: "node server.js",
        workdir: "C:/work",
        yield_time_ms: 1_000,
        max_output_tokens: 2_000,
        tty: true,
      });
      const [execRequest] = await broker.nextBatch(turnToken);
      assert.deepEqual(execRequest?.arguments, {
        cmd: "node server.js",
        workdir: "C:/work",
        yield_time_ms: 1_000,
        max_output_tokens: 2_000,
        tty: true,
      });
      broker.complete(turnToken, execRequest!.callId, {
        content: [{ type: "text", text: "server started" }],
        structuredContent: { output: "server started", session_id: 42 },
      });
      assert.deepEqual(((await exec).result as JsonRecord).structuredContent, {
        output: "server started",
        session_id: 42,
      });

      const continued = call("codex_write_stdin", {
        turn_token: turnToken,
        session_id: 42,
        chars: "y\n",
        yield_time_ms: 5_000,
      });
      const [writeRequest] = await broker.nextBatch(turnToken);
      assert.equal(writeRequest?.wireName, "write_stdin");
      assert.deepEqual(writeRequest?.arguments, {
        session_id: 42,
        chars: "y\n",
        yield_time_ms: 5_000,
        max_output_tokens: 3_000,
      });
      broker.complete(turnToken, writeRequest!.callId, {
        content: [{ type: "text", text: "continued" }],
        structuredContent: { output: "continued" },
      });
      assert.equal(
        (
          ((await continued).result as JsonRecord)
            .structuredContent as JsonRecord
        ).output,
        "continued",
      );

      const patchText =
        "*** Begin Patch\n*** Add File: direct-token.txt\n+ok\n*** End Patch";
      const patched = call("codex_apply_patch", {
        turn_token: turnToken,
        patch: patchText,
      });
      const [patchRequest] = await broker.nextBatch(turnToken);
      assert.equal(patchRequest?.wireName, "apply_patch");
      assert.equal(patchRequest?.input, patchText);
      broker.complete(turnToken, patchRequest!.callId, {
        content: [{ type: "text", text: "Done!" }],
      });
      assert.match(JSON.stringify((await patched).result), /Done!/u);

      const viewed = call("codex_view_image", {
        turn_token: turnToken,
        path: "C:/work/image.png",
        detail: "original",
      });
      const [viewRequest] = await broker.nextBatch(turnToken);
      assert.equal(viewRequest?.wireName, "view_image");
      assert.deepEqual(viewRequest?.arguments, {
        path: "C:/work/image.png",
        detail: "original",
      });
      broker.complete(turnToken, viewRequest!.callId, {
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      });
      assert.match(JSON.stringify((await viewed).result), /image\/png/u);

      const unowned = await call("codex_write_stdin", {
        turn_token: otherToken,
        session_id: 42,
      });
      assert.equal((unowned.result as JsonRecord).isError, true);
      assert.match(
        JSON.stringify((unowned.result as JsonRecord).content),
        /not returned by codex_exec for this turn/u,
      );
      assert.equal(broker.hasPending(otherToken), false);
    } finally {
      await mcp.close();
      broker.close();
    }
  });

  it("uses the raw Codex exec gateway when command and session tools are nested", async () => {
    const broker = new FullTurnBroker();
    const turnToken = broker.register(
      "raw-exec-gateway-test",
      [
        {
          kind: "custom",
          wireName: "exec",
          name: "exec",
          description: "Run native tool orchestration code",
          parameters: {},
          format: { type: "text" },
        },
      ],
      true,
    );
    const mcp = new FullTurnMcpServer(broker);
    const address = await mcp.start();
    try {
      const initialized = await fetch(address.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26" },
        }),
      });
      const sessionId = initialized.headers.get("mcp-session-id");
      assert.ok(sessionId);
      const call = async (
        id: number,
        name: string,
        args: Record<string, unknown>,
      ): Promise<JsonRecord> =>
        (await (
          await fetch(address.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "mcp-session-id": sessionId,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          })
        ).json()) as JsonRecord;

      const exec = call(2, "codex_exec", {
        turn_token: turnToken,
        cmd: "git status --short",
      });
      const [execRequest] = await broker.nextBatch(turnToken);
      assert.equal(execRequest?.wireName, "exec");
      assert.match(execRequest?.input ?? "", /ALL_TOOLS/u);
      assert.match(execRequest?.input ?? "", /exec_command/u);
      assert.match(execRequest?.input ?? "", /git status --short/u);
      broker.complete(turnToken, execRequest!.callId, {
        content: [
          {
            type: "text",
            text: '{"output":"running","session_id":7}',
          },
        ],
      });
      await exec;

      const write = call(3, "codex_write_stdin", {
        turn_token: turnToken,
        session_id: 7,
      });
      const [writeRequest] = await broker.nextBatch(turnToken);
      assert.equal(writeRequest?.wireName, "exec");
      assert.match(writeRequest?.input ?? "", /write_stdin/u);
      assert.match(writeRequest?.input ?? "", /session_id/u);
      broker.complete(turnToken, writeRequest!.callId, {
        content: [{ type: "text", text: '{"output":"done","exit_code":0}' }],
      });
      assert.match(JSON.stringify((await write).result), /exit_code/u);
    } finally {
      await mcp.close();
      broker.close();
    }
  });

  it("reuses a completed spawn-and-wait result instead of creating a duplicate subagent", async () => {
    const broker = new FullTurnBroker();
    const turnToken = broker.register(
      "subagent-dedup-test",
      [
        {
          kind: "custom",
          wireName: "functions__exec",
          name: "exec",
          namespace: "functions",
          description: "Run tool orchestration code",
          parameters: {},
          format: { type: "text" },
        },
      ],
      true,
    );
    const firstInput =
      'const spawned=await tools.multi_agent_v1__spawn_agent({message:"Reply with exactly CHILD_OK"});' +
      "const done=await tools.multi_agent_v1__wait_agent({targets:[spawned.agent_id],timeout_ms:60000});text(done);";
    const first = broker.invoke(turnToken, "functions__exec", {
      input: firstInput,
    });
    const batch = await broker.nextBatch(turnToken);
    assert.equal(batch.length, 1);
    const completed = {
      content: [
        {
          type: "text",
          text: '{"status":{"child":{"completed":"CHILD_OK"}}}',
        },
      ],
    } as const;
    broker.complete(turnToken, batch[0]!.callId, completed);
    assert.deepEqual(await first, completed);

    const duplicate = await broker.invoke(turnToken, "functions__exec", {
      input:
        '// retry with a longer wait\nconst spawned = await tools.multi_agent_v1__spawn_agent( { message: "Reply with exactly CHILD_OK" } );' +
        "const done=await tools.multi_agent_v1__wait_agent({targets:[spawned.agent_id],timeout_ms:90000});text(done);",
    });
    assert.equal(broker.hasPending(turnToken), false);
    assert.match(
      JSON.stringify(duplicate.content),
      /duplicate subagent spawn/u,
    );
    assert.match(JSON.stringify(duplicate.content), /CHILD_OK/u);

    const different = broker.invoke(turnToken, "functions__exec", {
      input:
        'const spawned=await tools.multi_agent_v1__spawn_agent({message:"Review a different task"});' +
        "const done=await tools.multi_agent_v1__wait_agent({targets:[spawned.agent_id],timeout_ms:60000});text(done);",
    });
    const differentBatch = await broker.nextBatch(turnToken);
    assert.equal(differentBatch.length, 1);
    broker.complete(turnToken, differentBatch[0]!.callId, {
      content: [{ type: "text", text: "different result" }],
    });
    assert.match(JSON.stringify(await different), /different result/u);
    broker.close();
  });

  it("blocks subagent spawns beyond the explicit per-turn count", async () => {
    const broker = new FullTurnBroker();
    const turnToken = broker.register(
      "subagent-limit-test",
      [
        {
          kind: "custom",
          wireName: "functions__exec",
          name: "exec",
          namespace: "functions",
          description: "Run tool orchestration code",
          parameters: {},
          format: { type: "text" },
        },
      ],
      true,
      { subagentLimit: 1 },
    );
    const first = broker.invoke(turnToken, "functions__exec", {
      input:
        'const child=await tools.multi_agent_v1__spawn_agent({message:"first"});text(child);',
    });
    const firstBatch = await broker.nextBatch(turnToken);
    broker.complete(turnToken, firstBatch[0]!.callId, {
      content: [{ type: "text", text: "first child" }],
    });
    await first;

    const blocked = await broker.invoke(turnToken, "functions__exec", {
      input:
        'const child=await tools.multi_agent_v1__spawn_agent({message:"second"});text(child);',
    });
    assert.equal(blocked.isError, true);
    assert.match(JSON.stringify(blocked.content), /requested exactly 1/u);
    assert.equal(broker.subagentSpawns(turnToken), 1);
    assert.equal(broker.hasPending(turnToken), false);
    broker.close();
  });

  it("allows one replacement only after a terminal subagent failure", async () => {
    const broker = new FullTurnBroker();
    const turnToken = broker.register(
      "subagent-replacement-test",
      [
        {
          kind: "custom",
          wireName: "functions__exec",
          name: "exec",
          namespace: "functions",
          description: "Run tool orchestration code",
          parameters: {},
          format: { type: "text" },
        },
      ],
      true,
      { subagentLimit: 1 },
    );
    const workflow =
      'const child=await tools.multi_agent_v1__spawn_agent({message:"Reply CHILD_OK"});' +
      "const done=await tools.multi_agent_v1__wait_agent({targets:[child.agent_id],timeout_ms:60000});text(done);";
    const failed = broker.invoke(turnToken, "functions__exec", {
      input: workflow,
    });
    const failedBatch = await broker.nextBatch(turnToken);
    broker.complete(turnToken, failedBatch[0]!.callId, {
      content: [
        {
          type: "text",
          text: '{"status":{"01a096e7-94b7-7c50-8557-5ef0ecf96e23":{"errored":"rate limit exceeded: ChatGPT Web is temporarily rate limited"}}}',
        },
      ],
    });
    assert.match(JSON.stringify((await failed).content), /rate limit/u);

    const replacement = broker.invoke(turnToken, "functions__exec", {
      input: workflow,
    });
    const replacementBatch = await broker.nextBatch(turnToken);
    assert.equal(replacementBatch.length, 1);
    broker.complete(turnToken, replacementBatch[0]!.callId, {
      content: [
        {
          type: "text",
          text: '{"status":{"replacement":{"completed":"CHILD_OK"}}}',
        },
      ],
    });
    assert.match(JSON.stringify((await replacement).content), /CHILD_OK/u);

    const extra = await broker.invoke(turnToken, "functions__exec", {
      input:
        'const child=await tools.multi_agent_v1__spawn_agent({message:"extra"});text(child);',
    });
    assert.equal(extra.isError, true);
    assert.match(JSON.stringify(extra.content), /terminally failed/u);
    assert.equal(broker.subagentSpawns(turnToken), 2);
    broker.close();
  });

  it("continues one Full MCP response when a subagent notification follows the tool result", async () => {
    const broker = new FullTurnBroker();
    const adminToken = "f".repeat(64);
    let browserResolve: ((value: string) => void) | undefined;
    let submittedContract = "";
    let browserRuns = 0;
    const browserResult = new Promise<string>((resolvePromise) => {
      browserResolve = resolvePromise;
    });
    const gateway = new ResponsesGateway({
      port: 0,
      admin: { token: adminToken },
      fullMcp: {
        broker,
        enabled: () => true,
        connectorName: () => "CodexGPT Bridge",
      },
      runWebTurn: async (input) => {
        browserRuns += 1;
        assert.equal(input.cwd, "C:/Code/Project");
        if (browserRuns === 1) {
          submittedContract = input.contract ?? "";
          assert.equal(input.allowWebNativeTools, true);
          assert.equal(input.connectorName, "CodexGPT Bridge");
          assert.equal(input.execution?.toolTransport, "full");
          assert.equal(input.execution?.operationToolTransport, "full");
          assert.equal(input.execution?.attempt, "initial");
          assert.equal(input.execution?.route, "codexgpt-bridge/high");
          assert.ok((input.execution?.toolCount ?? 0) > 0);
          return browserResult;
        }
        assert.equal(input.allowWebNativeTools, undefined);
        assert.equal(input.execution?.toolTransport, "none");
        assert.equal(input.execution?.operationToolTransport, "full");
        assert.equal(input.execution?.attempt, "follow-up");
        assert.equal(input.execution?.toolCount, 0);
        assert.match(input.prompt, /structured output correction/);
        return '<codex_text>{"summary":"Read complete."}</codex_text>';
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const metadata = {
      thread_id: "thread-full-mcp",
      turn_id: "turn-full-mcp",
      cwd: "C:/Code/Project",
    };
    const firstRequest = fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        metadata,
        input: [{ role: "user", content: "Read the file." }],
        text: {
          format: {
            type: "json_schema",
            name: "full_mcp_result",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["summary"],
              properties: { summary: { type: "string" } },
            },
          },
        },
        tools: [
          {
            type: "function",
            name: "read_file",
            parameters: {
              type: "object",
              additionalProperties: false,
              required: ["path"],
              properties: { path: { type: "string" } },
            },
          },
        ],
      }),
    });
    await withTimeout(
      (async () => {
        while (!submittedContract)
          await new Promise((resolve) => setImmediate(resolve));
      })(),
      "Full MCP browser turn did not start",
    );
    const turnToken = /turn_[A-Za-z0-9_-]{40,}/u.exec(submittedContract)?.[0];
    assert.ok(turnToken);
    assert.match(submittedContract, /full_mcp_result/);
    const connectorCall = broker.invoke(turnToken, "read_file", {
      arguments: { path: "README.md" },
    });
    const first = await withTimeout(
      firstRequest,
      "Codex tool batch was not returned",
    );
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as {
      id: string;
      output: Array<{ call_id: string; name: string }>;
    };
    assert.equal(firstBody.output[0]?.name, "read_file");
    const callId = firstBody.output[0]?.call_id;
    assert.ok(callId);
    const activeLifecycle = (await (
      await fetch(`${address.baseUrl.replace(/\/v1$/u, "")}/admin/lifecycle`, {
        headers: { authorization: `Bearer ${adminToken}` },
      })
    ).json()) as JsonRecord;
    assert.equal(activeLifecycle.active_tool_turns, 1);

    const continuation = fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        previous_response_id: firstBody.id,
        input: [
          {
            type: "function_call_output",
            call_id: callId,
            output: "file contents",
          },
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: '<subagent_notification>{"status":{"completed":"CHILD_OK"}}</subagent_notification>',
              },
            ],
            internal_chat_message_metadata_passthrough: {
              content_item_kinds: ["multi_agent.subagent_notification"],
            },
          },
          {
            type: "world_state",
            state: { environments: { subagents: "one completed agent" } },
          },
        ],
      }),
    });
    const connectorResult = await withTimeout(
      connectorCall,
      "Codex result did not return to the connector",
    );
    assert.match(JSON.stringify(connectorResult.content), /file contents/);
    browserResolve?.("<codex_text>not JSON</codex_text>");
    const final = await withTimeout(
      continuation,
      "Full MCP turn did not finish",
    );
    const finalBody = (await final.json()) as {
      output: Array<{ content: Array<{ text: string }> }>;
      text: { format: { name?: string; type: string } };
    };
    assert.equal(
      finalBody.output[0]?.content[0]?.text,
      '{"summary":"Read complete."}',
    );
    assert.equal(finalBody.text.format.name, "full_mcp_result");
    assert.equal(browserRuns, 2);
    const settledLifecycle = (await (
      await fetch(`${address.baseUrl.replace(/\/v1$/u, "")}/admin/lifecycle`, {
        headers: { authorization: `Bearer ${adminToken}` },
      })
    ).json()) as JsonRecord;
    assert.equal(settledLifecycle.active_tool_turns, 0);
  });

  for (const diagnostic of [
    "無法取得 inventory：Tool codex_tool_inventory not found",
    "Tool codex_exec not found",
    "MCP Session terminated",
    "MCP session not found",
  ]) {
    it(
      "keeps Full MCP selected, releases leases and replays its failure: " +
        diagnostic,
      async () => {
        const broker = new FullTurnBroker();
        const browserModes: Array<boolean | undefined> = [];
        const adminToken = "d".repeat(64);
        const gateway = new ResponsesGateway({
          port: 0,
          admin: { token: adminToken },
          fullMcp: {
            broker,
            enabled: () => true,
            connectorName: () => "CodexGPT Bridge",
          },
          runWebTurn: async (input) => {
            browserModes.push(input.allowWebNativeTools);
            return "<codex_text>" + diagnostic + "</codex_text>";
          },
        });
        gateways.push(gateway);
        const address = await gateway.start();
        const request = {
          model: "codexgpt-bridge/medium",
          metadata: { thread_id: "full-failure", turn_id: "same-turn" },
          input: [
            { role: "user", content: "Reply with the connection probe." },
          ],
          tools: [
            {
              type: "function",
              name: "read_file",
              parameters: { type: "object", properties: {} },
            },
          ],
        };
        for (let replay = 0; replay < 2; replay++) {
          const response = await fetch(address.baseUrl + "/responses", {
            method: "POST",
            headers: {
              authorization: "Bearer test",
              "content-type": "application/json",
            },
            body: JSON.stringify(request),
          });
          assert.equal(response.status, 400);
          const body = (await response.json()) as {
            error: { code: string; message: string };
          };
          assert.equal(body.error.code, "bridge_full_mcp_unavailable");
          assert.match(body.error.message, /explicitly select Simple/);
        }
        const stream = await fetch(address.baseUrl + "/responses", {
          method: "POST",
          headers: {
            authorization: "Bearer test",
            "content-type": "application/json",
          },
          body: JSON.stringify({ ...request, stream: true }),
        });
        const events = await stream.text();
        assert.match(events, /bridge_full_mcp_unavailable/);
        assert.doesNotMatch(events, /response.completed/);
        assert.deepEqual(browserModes, [true]);
        const lifecycle = (await (
          await fetch(
            address.baseUrl.replace(/\/v1$/u, "") + "/admin/lifecycle",
            {
              headers: { authorization: "Bearer " + adminToken },
            },
          )
        ).json()) as JsonRecord;
        assert.equal(lifecycle.active_tool_turns, 0);
        assert.equal(lifecycle.active_browser_turns, 0);
      },
    );
  }

  it("returns explanations and quoted connector errors without resending or classifying them as failures", async () => {
    const broker = new FullTurnBroker();
    let runs = 0;
    const answer =
      'The message "Tool codex_exec not found" means the connector needs refreshing. MCP Session terminated is another possible diagnostic.';
    const gateway = new ResponsesGateway({
      port: 0,
      fullMcp: {
        broker,
        enabled: () => true,
        connectorName: () => "CodexGPT Bridge",
      },
      runWebTurn: async () => {
        runs++;
        return "<codex_text>" + answer + "</codex_text>";
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const response = await fetch(address.baseUrl + "/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/medium",
        metadata: { thread_id: "explain", turn_id: "explain" },
        input: [{ role: "user", content: "Explain connection diagnostics." }],
        tools: [
          {
            type: "function",
            name: "read_file",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      output: Array<{ content: Array<{ text: string }> }>;
    };
    assert.equal(body.output[0]?.content[0]?.text, answer);
    assert.equal(runs, 1);
  });

  it("does not accept a Simple tool call from a formatting-only Full MCP correction", async () => {
    const broker = new FullTurnBroker();
    let runs = 0;
    const gateway = new ResponsesGateway({
      port: 0,
      fullMcp: { broker, enabled: () => true, connectorName: () => "Bridge" },
      runWebTurn: async (input) => {
        runs++;
        if (runs === 1) return "<codex_text>not JSON</codex_text>";
        assert.match(input.contract ?? "", /formatting-only/);
        assert.doesNotMatch(
          input.contract ?? "",
          /turn_token|wire_name|Codex tool protocol/,
        );
        return '<codex_tool_calls>[{"name":"read_file","arguments":{}}]</codex_tool_calls>';
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const response = await fetch(address.baseUrl + "/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        metadata: { thread_id: "formatting", turn_id: "formatting" },
        input: [{ role: "user", content: "Reply with JSON." }],
        text: { format: { type: "json_object" } },
        tools: [
          {
            type: "function",
            name: "read_file",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    });
    assert.equal(response.status, 500);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "bridge_structured_output_invalid");
    assert.equal(runs, 2);
  });

  it("forwards only the latest user message to the browser", () => {
    const compiled = compileResponsesPrompt({
      instructions: `large base instructions ${"x".repeat(20_000)}`,
      input: [
        {
          role: "developer",
          content: `You are Codex. ${"y".repeat(20_000)}`,
        },
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
        {
          role: "developer",
          content: `<skills_instructions>${"z".repeat(20_000)}</skills_instructions>`,
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "可以訪問 C:\\Users\\example-user\\Desktop\\demo-project 嗎？",
            },
          ],
        },
      ],
      tools: [{ type: "function", name: "DevSpace" }],
    });

    assert.equal(
      compiled.prompt,
      "可以訪問 C:\\Users\\example-user\\Desktop\\demo-project 嗎？",
    );
    assert.deepEqual(compiled.images, []);
    assert.equal(compiled.hasToolDefinitions, true);
  });

  it("extracts stable native turn identity for reconnect-safe browser replay", () => {
    const turnId = "01a071fc-b54c-76d3-894b-1a97b3c662ef";
    const compiled = compileResponsesPrompt({
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "01a071f6-54ca-7f43-a06f-60de9a49dbb4",
          turn_id: turnId,
        }),
      },
      input: [
        {
          role: "user",
          content: "hello",
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    });

    assert.equal(compiled.turnId, turnId);
    assert.equal(compiled.threadId, "01a071f6-54ca-7f43-a06f-60de9a49dbb4");
  });

  it("never combines a thread and turn from different metadata records", () => {
    assert.equal(
      responsesNativeTurnIdentity({
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "thread_first",
          }),
        },
        metadata: { turn_id: "turn_second" },
      }),
      undefined,
    );
    assert.deepEqual(
      responsesNativeTurnIdentity({
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "thread_first",
          }),
        },
        metadata: {
          thread_id: "thread_exact_pair",
          turn_id: "turn_exact_pair",
        },
      }),
      { threadId: "thread_exact_pair", turnId: "turn_exact_pair" },
    );
  });

  it("reads project cwd from native metadata or standalone environment context, never tool output", () => {
    const env =
      "<environment_context>\n<cwd>C:\\Code\\專案</cwd>\n<shell>powershell</shell>\n</environment_context>";
    assert.equal(
      compileResponsesPrompt({
        input: [
          { role: "user", content: env },
          { role: "user", content: "hello" },
        ],
      }).cwd,
      "C:\\Code\\專案",
    );
    assert.equal(
      compileResponsesPrompt({
        metadata: { cwd: "/code/project" },
        input: "hello",
      }).cwd,
      "/code/project",
    );
    assert.equal(
      compileResponsesPrompt({
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({ cwd: "/native/project" }),
        },
        input: [{ role: "user", content: env }],
      }).cwd,
      "/native/project",
    );
    for (const item of [
      { role: "assistant", content: env },
      { role: "user", content: "Explain this example:\n" + env },
      { type: "function_call_output", call_id: "call-fixture", output: env },
    ]) {
      assert.equal(
        compileResponsesPrompt({
          input: [item, { role: "user", content: "hello" }],
        }).cwd,
        undefined,
      );
    }
    assert.equal(
      compileResponsesPrompt({
        metadata: { cwd: "relative/path" },
        input: "hello",
      }).cwd,
      undefined,
    );
  });

  it("keeps bounded task bootstrap history separate from the current request", () => {
    const compiled = compileResponsesPrompt({
      input: [
        { role: "developer", content: "not conversation history" },
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "follow-up" },
      ],
    });
    assert.equal(compiled.prompt, "follow-up");
    assert.deepEqual(
      compiled.context.history.map((text) => JSON.parse(text)),
      [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
      ],
    );
  });

  it("keeps a trailing agent_message in the ordered current request", () => {
    const compiled = compileResponsesPrompt({
      input: [
        { role: "user", content: "Investigate the failure." },
        {
          type: "agent_message",
          author: "reviewer",
          recipient: "assistant",
          content: [{ type: "input_text", text: "Check the retry path too." }],
        },
      ],
    });

    assert.match(compiled.prompt, /Current Codex messages/);
    assert.match(compiled.prompt, /Investigate the failure/);
    assert.match(compiled.prompt, /agent_message/);
    assert.match(compiled.prompt, /reviewer/);
    assert.match(compiled.prompt, /Check the retry path too/);
    assert.equal(compiled.context.history.length, 0);
  });

  it("treats a delegated task message without a call id as input, not a tool result", () => {
    const compiled = compileResponsesPrompt({
      input: [
        {
          type: "function_call_output",
          name: "send_message_to_thread",
          namespace: "codex_app",
          output:
            "<codex_delegation><input>建立一個子代理。</input></codex_delegation>",
        },
      ],
    });

    assert.equal(compiled.toolResults.length, 0);
    assert.match(compiled.prompt, /建立一個子代理/);
  });

  it("uses a later delegated task message instead of an older user message", () => {
    const compiled = compileResponsesPrompt({
      input: [
        { role: "user", content: "old request" },
        {
          type: "function_call_output",
          name: "send_message_to_thread",
          namespace: "codex_app",
          output:
            "<codex_delegation><input>建立且僅建立 1 個子代理。</input></codex_delegation>",
        },
      ],
    });

    assert.equal(compiled.toolResults.length, 0);
    assert.doesNotMatch(compiled.prompt, /old request/);
    assert.match(compiled.prompt, /建立且僅建立 1 個子代理/);
    const prepared = prepareBridgeWebTurn({
      ...compiled,
      toolDefinitions: [
        {
          type: "custom",
          name: "exec",
          namespace: "functions",
          description: "Run tool orchestration code",
          format: { type: "text" },
        },
      ],
    });
    assert.equal(prepared.requiresSubagent, true);
    assert.equal(prepared.subagentCount, 1);
  });

  it("keeps latest-user images structured instead of pasting base64 as text", () => {
    const imageUrl = "data:image/png;base64,aGVsbG8=";
    const compiled = compileResponsesPrompt({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "看這張圖" },
            { type: "input_image", image_url: imageUrl, detail: "high" },
          ],
        },
      ],
    });

    assert.equal(compiled.prompt, "看這張圖");
    assert.deepEqual(compiled.images, [
      {
        ref: "codex-input-image-1",
        imageUrl,
        detail: "high",
      },
    ]);
    assert.equal(compiled.prompt.includes("aGVsbG8="), false);
  });

  it("loads Codex 0.153 additional_tools input items", () => {
    const namespace = {
      type: "namespace",
      name: "codexgpt-bridge",
      tools: [
        {
          type: "function",
          name: "open_workspace",
          description: "Open an allowed workspace.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    };
    const compiled = compileResponsesPrompt({
      input: [
        {
          type: "additional_tools",
          id: "additional_tools_1",
          role: "developer",
          tools: [namespace],
        },
        { role: "user", content: "開啟 C:\\work" },
      ],
      tool_choice: "auto",
    });

    assert.equal(compiled.hasToolDefinitions, true);
    assert.deepEqual(compiled.toolDefinitions, [namespace]);
    assert.match(
      prepareBridgeWebTurn(compiled).contract ?? "",
      /codexgpt-bridge__open_workspace/,
    );
  });

  it("forwards string input without adding a transport wrapper", () => {
    assert.equal(
      compileResponsesPrompt({
        instructions: "ignored developer instructions",
        input: "test",
      }).prompt,
      "test",
    );
  });

  it("extracts only the trailing Codex tool-result batch", () => {
    const compiled = compileResponsesPrompt({
      input: [
        { role: "user", content: "create a file" },
        {
          type: "function_call",
          call_id: "call_old",
          name: "open_workspace",
          namespace: "codexgpt-bridge",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_old",
          output: "old result",
        },
        {
          type: "function_call",
          call_id: "call_new",
          name: "apply_patch",
          namespace: "codexgpt-bridge",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_new",
          output: '{"changed":true}',
        },
      ],
      tools: [{ type: "function", name: "apply_patch" }],
    });

    assert.deepEqual(compiled.toolResults, [
      {
        callId: "call_new",
        kind: "function_call_output",
        toolName: "codexgpt-bridge__apply_patch",
        output: '{"changed":true}',
      },
    ]);
  });

  it("preserves the pre-install native and existing Web rows exactly", () => {
    const existing = {
      etag: "pre-install-catalog",
      models: [
        {
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6-Sol",
          base_instructions: "native instructions",
          supports_reasoning_summaries: true,
          supports_parallel_tool_calls: true,
          visibility: "list",
          supported_in_api: true,
          priority: 6,
          multi_agent_version: "v1",
          tool_mode: "code_mode_only",
          context_window: 272_000,
          max_context_window: 872_000,
        },
        {
          slug: "chatgpt-web/high",
          display_name: "ChatGPT Web — High",
          base_instructions: "web instructions",
          supports_reasoning_summaries: true,
          supports_parallel_tool_calls: true,
          visibility: "list",
          supported_in_api: true,
          priority: 6,
          multi_agent_version: "v1",
          tool_mode: null,
          context_window: 333_579,
          max_context_window: 333_579,
          auto_compact_token_limit: 285_000,
          custom_legacy_metadata: "must-survive",
        },
        {
          slug: "codexgpt-bridge/high",
          display_name: "stale Bridge row",
          priority: -1,
        },
      ],
    };
    const snapshot = structuredClone(existing);

    const payload = buildStartupModelsPayload(existing) as {
      etag: string;
      models: Array<Record<string, unknown>>;
    };

    assert.deepEqual(existing, snapshot);
    assert.equal(payload.etag, "pre-install-catalog");
    assert.deepEqual(payload.models.slice(0, 2), snapshot.models.slice(0, 2));
    assert.deepEqual(
      payload.models.map((model) => model.slug),
      ["gpt-5.6-sol", "chatgpt-web/high", ...CODEXGPT_BRIDGE_WEB_MODEL_IDS],
    );
    assert.equal(
      payload.models.find((model) => model.slug === "chatgpt-web/high")
        ?.custom_legacy_metadata,
      "must-survive",
    );
  });

  it("does not invent existing Web rows when they were not installed", () => {
    const payload = buildStartupModelsPayload({
      models: [{ slug: "gpt-native", visibility: "list" }],
    }) as { models: Array<{ slug: string }> };
    assert.deepEqual(
      payload.models.map((model) => model.slug),
      ["gpt-native", ...CODEXGPT_BRIDGE_WEB_MODEL_IDS],
    );
  });

  it("keeps Pro listed alongside account-proven regular modes", () => {
    const payload = buildStartupModelsPayload(
      { models: [{ slug: "gpt-native", visibility: "list" }] },
      ["instant", "medium", "high", "extra-high"],
    ) as { models: Array<{ slug: string }> };
    assert.deepEqual(
      payload.models.map((model) => model.slug),
      [
        "gpt-native",
        "codexgpt-bridge/instant",
        "codexgpt-bridge/medium",
        "codexgpt-bridge/high",
        "codexgpt-bridge/extra-high",
        "codexgpt-bridge/pro",
      ],
    );
  });

  it("publishes only Luna and proven Think for a Free/Go-style account", () => {
    const payload = buildStartupModelsPayload(
      { models: [{ slug: "gpt-native", visibility: "list" }] },
      ["luna", "think"],
    ) as { models: Array<{ slug: string }> };
    assert.deepEqual(
      payload.models.map((model) => model.slug),
      ["gpt-native", "codexgpt-bridge/luna", "codexgpt-bridge/think"],
    );
  });

  it("hydrates static base instructions from the live model message schema", () => {
    const existing = {
      models: [
        {
          slug: "gpt-live",
          model_messages: { instructions_template: "live instructions" },
        },
      ],
    };

    const payload = buildStartupModelsPayload(existing) as {
      models: Array<Record<string, unknown>>;
    };

    const sourceModel = existing.models[0];
    assert.ok(sourceModel);
    assert.equal("base_instructions" in sourceModel, false);
    assert.ok(payload.models.length > 1);
    for (const model of payload.models) {
      assert.equal(model.base_instructions, "live instructions");
      assert.equal(model.supports_reasoning_summaries, true);
      assert.equal(model.supports_parallel_tool_calls, true);
    }
  });

  it("hydrates required flags without replacing existing base instructions", () => {
    const payload = buildStartupModelsPayload({
      models: [
        { slug: "gpt-existing", base_instructions: "existing instructions" },
      ],
    }) as { models: Array<Record<string, unknown>> };

    const model = payload.models.find((entry) => entry.slug === "gpt-existing");
    assert.ok(model);
    assert.equal(model.base_instructions, "existing instructions");
    assert.equal(model.supports_reasoning_summaries, true);
    assert.equal(model.supports_parallel_tool_calls, true);
  });

  it("adds the seven separately named Bridge Web models without removing native models", () => {
    const payload = augmentModelsPayload({
      models: [
        {
          slug: "gpt-native",
          display_name: "Native",
          visibility: "list",
          tool_mode: "code",
          multi_agent_version: "v2",
          comp_hash: "native-hash",
        },
      ],
    }) as {
      models: Array<{
        slug: string;
        display_name: string;
        tool_mode?: unknown;
        multi_agent_version?: string;
        use_responses_lite?: boolean;
        comp_hash?: string;
        input_modalities?: string[];
      }>;
    };
    assert.deepEqual(
      payload.models.map((model) => model.slug),
      ["gpt-native", ...CODEXGPT_BRIDGE_WEB_MODEL_IDS],
    );
    assert.equal(payload.models[1]?.display_name, "CodexGPT Bridge — Instant");
    assert.equal(payload.models[1]?.tool_mode, "code");
    assert.equal(payload.models[1]?.multi_agent_version, "v2");
    assert.equal(payload.models[1]?.use_responses_lite, false);
    assert.equal(payload.models[1]?.comp_hash, undefined);
    assert.deepEqual(payload.models[1]?.input_modalities, ["text", "image"]);
    assert.equal(payload.models[5]?.display_name, "CodexGPT Bridge — Pro");
  });

  it("advertises a 90k compaction threshold inside the 95k hard window", () => {
    const payload = augmentModelsPayload({
      models: [{ slug: "gpt-native", visibility: "list" }],
    }) as {
      models: Array<Record<string, unknown>>;
    };
    const bridgeModels = payload.models.filter((model) =>
      CODEXGPT_BRIDGE_WEB_MODEL_IDS.includes(String(model.slug)),
    );

    assert.equal(bridgeModels.length, CODEXGPT_BRIDGE_WEB_MODEL_IDS.length);
    for (const model of bridgeModels) {
      assert.equal(model.context_window, BRIDGE_CONTEXT_WINDOW);
      assert.equal(model.max_context_window, BRIDGE_HARD_INPUT_TOKEN_LIMIT);
      assert.equal(
        model.auto_compact_token_limit,
        BRIDGE_AUTO_COMPACT_TOKEN_LIMIT,
      );
    }
  });

  it("rejects over-limit input without submitting a browser prompt", async () => {
    let browserCalls = 0;
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async () => {
        browserCalls += 1;
        return "must-not-run";
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const response = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: " token".repeat(BRIDGE_HARD_INPUT_TOKEN_LIMIT),
        stream: true,
      }),
    });
    const body = await response.text();

    assert.equal(browserCalls, 0);
    assert.match(body, /bridge_context_limit_exceeded/);
    assert.match(body, /codexgpt-bridge\/high \(high\)/);
    assert.match(body, new RegExp(BRIDGE_CONTEXT_BUDGET_PROFILE));
    assert.match(body, /Compact the task and retry/);
    assert.match(body, /No prompt was submitted/);
  });

  it("defers the hard gate to a receipt-aware browser provider", async () => {
    let execution: BridgeExecutionPreflight | undefined;
    const gateway = new ResponsesGateway({
      port: 0,
      receiptAwareContextSync: true,
      runWebTurn: async (input) => {
        execution = input.execution;
        return "receipt-aware-ok";
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const response = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: " token".repeat(BRIDGE_HARD_INPUT_TOKEN_LIMIT),
      }),
    });

    assert.equal(response.status, 200, await response.text());
    assert.equal(execution?.inputBasis, "full-context");
    assert.ok(
      (execution?.sourceContextTokens ?? 0) > BRIDGE_HARD_INPUT_TOKEN_LIMIT,
    );
  });

  it("recalculates the synchronized payload without hiding source context growth", () => {
    const full: BridgeExecutionPreflight = {
      version: 1,
      route: "codexgpt-bridge/high",
      mode: "high",
      operationToolTransport: "simple",
      toolTransport: "simple",
      attempt: "initial",
      toolCount: 4,
      sourceContextTokens: 140_000,
      inputBasis: "full-context",
      inputTokens: 140_000,
      textTokens: 131_808,
      textCharacters: 500_000,
      imageCount: 0,
      imageReserveTokens: 0,
      platformReserveTokens: 8_192,
      contextWindow: 95_000,
      autoCompactTokenLimit: 90_000,
      hardInputTokenLimit: 95_000,
      remainingInputTokens: 0,
      status: "compaction-recommended",
      budgetProfile: "bridge-safe-v1",
    };
    const synchronized = synchronizeBridgeExecutionPreflight(full, {
      prompt: "Only this new context tail is submitted.",
      images: [],
    });

    assert.equal(synchronized.inputBasis, "synchronized-payload");
    assert.equal(synchronized.sourceContextTokens, 140_000);
    assert.ok(synchronized.inputTokens < synchronized.hardInputTokenLimit);
    assert.equal(synchronized.status, "within-limit");
    assert.equal(
      synchronized.remainingInputTokens,
      synchronized.hardInputTokenLimit - synchronized.inputTokens,
    );
  });

  it("submits a near-limit turn with an explicit compaction recommendation", async () => {
    let execution: BridgeExecutionPreflight | undefined;
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async (input) => {
        execution = input.execution;
        return "near-limit-ok";
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const response = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: " token".repeat(BRIDGE_AUTO_COMPACT_TOKEN_LIMIT - 7_000),
      }),
    });
    const body = await response.text();

    assert.equal(response.status, 200, body);
    assert.equal(execution?.status, "compaction-recommended");
    assert.ok((execution?.inputTokens ?? 0) > BRIDGE_AUTO_COMPACT_TOKEN_LIMIT);
    assert.ok(
      (execution?.inputTokens ?? Number.POSITIVE_INFINITY) <=
        BRIDGE_HARD_INPUT_TOKEN_LIMIT,
    );
  });

  it("rechecks the token budget before a structured-output correction", async () => {
    let browserCalls = 0;
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async () => {
        browserCalls += 1;
        return "not-json";
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const response = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: "Reply with JSON.",
        text: {
          format: {
            type: "json_schema",
            name: "large_result",
            strict: true,
            schema: {
              type: "object",
              properties: {
                answer: {
                  type: "string",
                  description: " token".repeat(50_000),
                },
              },
              required: ["answer"],
              additionalProperties: false,
            },
          },
        },
      }),
    });
    const body = await response.text();

    assert.equal(response.status, 400, body);
    assert.equal(browserCalls, 1);
    assert.match(body, /bridge_context_limit_exceeded/);
    assert.match(body, /No additional prompt was submitted/);
    assert.match(body, /earlier browser response was not retried/);
  });

  for (const stream of [false, true]) {
    it(`preserves manual verification failure without a second browser call (stream=${stream})`, async () => {
      let browserCalls = 0;
      const gateway = new ResponsesGateway({
        port: 0,
        runWebTurn: async () => {
          browserCalls++;
          throw Object.assign(
            new Error("Complete verification in the existing Chrome tab."),
            {
              code: "chatgpt_web_verification_required",
            },
          );
        },
      });
      gateways.push(gateway);
      const address = await gateway.start();
      const response = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer codex-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/high",
          input: "verification probe",
          stream,
        }),
      });
      const body = await response.text();
      assert.match(body, /chatgpt_web_verification_required/u);
      assert.match(body, /Complete verification in the existing Chrome tab/u);
      assert.equal(browserCalls, 1);
      assert.equal(gateway.lifecycleStatus().activeBrowserTurns, 0);
    });
  }

  it("releases the browser lease when a provider throws synchronously", async () => {
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: () => {
        throw new Error("synchronous provider failure");
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const response = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: "fail before returning a promise",
      }),
    });

    assert.equal(response.status, 500);
    assert.equal(gateway.lifecycleStatus().activeBrowserTurns, 0);
  });

  it("allows an over-limit compaction request to create its checkpoint", async () => {
    let browserCalls = 0;
    let compactionExecution: BridgeExecutionPreflight | undefined;
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async (input) => {
        browserCalls += 1;
        compactionExecution = input.execution;
        return "checkpoint-ok";
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const response = await fetch(`${address.baseUrl}/responses/compact`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: " token".repeat(BRIDGE_HARD_INPUT_TOKEN_LIMIT),
      }),
    });
    const body = await response.text();

    assert.equal(response.status, 200, body);
    assert.equal(browserCalls, 1);
    assert.equal(compactionExecution?.status, "compaction-bypass");
    assert.equal(compactionExecution?.toolTransport, "none");
    assert.ok(
      (compactionExecution?.inputTokens ?? 0) > BRIDGE_HARD_INPUT_TOKEN_LIMIT,
    );
    const compacted = JSON.parse(body) as {
      object: string;
      output: Array<{ type: string; encrypted_content: string }>;
    };
    assert.equal(compacted.object, "response.compaction");
    assert.equal(compacted.output[0]?.type, "compaction");
    assert.equal(
      Buffer.from(
        compacted.output[0]!.encrypted_content.slice("cgb1:".length),
        "base64",
      ).toString("utf8"),
      "checkpoint-ok",
    );
  });

  it("rolls an oversized receipt-aware compaction through bounded record stages", async () => {
    const browserInputs: RunWebTurnInput[] = [];
    const gateway = new ResponsesGateway({
      port: 0,
      receiptAwareContextSync: true,
      runWebTurn: async (input) => {
        browserInputs.push(input);
        return `checkpoint-stage-${browserInputs.length}`;
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const records = Array.from({ length: 12 }, (_value, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `record-${index}:` + " token".repeat(12_000),
    }));
    const response = await fetch(`${address.baseUrl}/responses/compact`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: [...records, { type: "compaction_trigger" }],
      }),
    });
    const body = await response.text();

    assert.equal(response.status, 200, body);
    assert.ok(browserInputs.length > 1);
    assert.equal(browserInputs.at(-1)?.context?.history.length, records.length);
    for (const [index, input] of browserInputs.entries()) {
      assert.match(input.prompt, /rolling checkpoint stage/i);
      assert.match(input.contract ?? "", /compaction protocol/i);
      assert.equal(input.allowWebNativeTools, undefined);
      assert.notEqual(input.execution?.status, "compaction-bypass");
      if (index > 0) {
        assert.ok(
          (input.context?.history.length ?? 0) >
            (browserInputs[index - 1]?.context?.history.length ?? 0),
        );
      }
    }
    const compacted = JSON.parse(body) as {
      output: Array<{ encrypted_content: string }>;
    };
    assert.equal(
      Buffer.from(
        compacted.output[0]!.encrypted_content.slice("cgb1:".length),
        "base64",
      ).toString("utf8"),
      `checkpoint-stage-${browserInputs.length}`,
    );
  });

  it("uses the compaction-only protocol and corrects one invalid checkpoint", async () => {
    const browserInputs: Array<{ prompt: string; contract: string }> = [];
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async (input) => {
        browserInputs.push({
          prompt: input.prompt,
          contract: input.contract ?? "",
        });
        return browserInputs.length === 1
          ? '<codex_tool_call>{"name":"must_not_run"}</codex_tool_call>'
          : "```text\ncheckpoint-after-correction\n```";
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const response = await fetch(`${address.baseUrl}/responses/compact`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: [
          { role: "user", content: "preserve this task" },
          { type: "compaction_trigger" },
        ],
      }),
    });
    const body = await response.text();

    assert.equal(response.status, 200, body);
    assert.equal(browserInputs.length, 2);
    assert.match(browserInputs[0]?.contract ?? "", /compaction protocol/i);
    assert.doesNotMatch(
      browserInputs[0]?.contract ?? "",
      /<codex_tool_calls?>/i,
    );
    assert.match(browserInputs[1]?.prompt ?? "", /checkpoint correction/i);
    const compacted = JSON.parse(body) as {
      output: Array<{ encrypted_content: string }>;
    };
    assert.equal(
      Buffer.from(
        compacted.output[0]!.encrypted_content.slice("cgb1:".length),
        "base64",
      ).toString("utf8"),
      "checkpoint-after-correction",
    );
  });

  it("routes each Bridge Web model to the matching browser mode", async () => {
    let prompt = "";
    let mode = "";
    let imageCount = 0;
    let execution: BridgeExecutionPreflight | undefined;
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async (input) => {
        prompt = input.prompt;
        mode = input.mode;
        imageCount = input.images.length;
        execution = input.execution;
        return "provider-ok";
      },
      fetchImpl: async () => {
        throw new Error("native fetch must not run");
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const expectedModes = [
      "instant",
      "medium",
      "high",
      "extra-high",
      "pro",
      "luna",
      "think",
    ];
    for (const [index, model] of CODEXGPT_BRIDGE_WEB_MODEL_IDS.entries()) {
      const response = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer codex-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          stream: true,
          instructions: "system rule",
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "hello" },
                ...(index === 2
                  ? [
                      {
                        type: "input_image",
                        image_url: "data:image/png;base64,aGVsbG8=",
                      },
                    ]
                  : []),
              ],
            },
          ],
        }),
      });
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.equal(mode, expectedModes[index]);
      assert.match(
        response.headers.get("content-type") ?? "",
        /text\/event-stream/,
      );
      assert.equal(prompt, "hello");
      assert.equal(imageCount, index === 2 ? 1 : 0);
      assert.ok(execution);
      assert.equal(execution.route, model);
      assert.equal(execution.mode, expectedModes[index]);
      assert.equal(execution.toolTransport, "none");
      assert.equal(execution.operationToolTransport, "none");
      assert.equal(execution.attempt, "initial");
      assert.equal(execution.toolCount, 0);
      assert.equal(execution.status, "within-limit");
      assert.equal(execution.budgetProfile, BRIDGE_CONTEXT_BUDGET_PROFILE);
      assert.equal(
        execution.remainingInputTokens,
        execution.hardInputTokenLimit - execution.inputTokens,
      );
      assert.equal(execution.imageReserveTokens, index === 2 ? 4_096 : 0);
      assert.equal(execution.imageCount, index === 2 ? 1 : 0);
      assert.ok(execution.textCharacters > "hello".length);
      assert.match(body, /event: response\.output_text\.delta/);
      assert.match(body, /provider-ok/);
      assert.match(body, /event: response\.completed/);
      assert.ok(body.endsWith("data: [DONE]\n\n"));
    }
  });

  it("streams captured images with visible Markdown and native image history", async () => {
    const imageBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async () => ({
        kind: "generated_images",
        text: "Lesson ready.",
        images: [
          {
            base64: imageBase64,
            mimeType: "image/png",
            localPath: "C:\\tmp\\lesson.png",
          },
        ],
      }),
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const response = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: "make a lesson image",
        stream: true,
      }),
    });

    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /event: response\.output_text\.delta/);
    assert.match(body, /Lesson ready\./);
    assert.match(body, /event: response\.image_generation_call\.in_progress/);
    assert.match(body, /event: response\.image_generation_call\.generating/);
    assert.match(body, /event: response\.image_generation_call\.completed/);
    assert.match(body, /"type":"image_generation_call"/);
    assert.ok(body.includes(imageBase64));
    assert.ok(body.includes("![Generated image 1](<C:/tmp/lesson.png>)"));
    assert.ok(body.endsWith("data: [DONE]\n\n"));
  });

  for (const transport of ["sse", "json", "websocket"] as const) {
    it(`returns a visible assistant message for image-only output over ${transport}`, async () => {
      const expectedText =
        "![Generated image 1](<C:/Users/Image Test/圖片 (1).png>)\n\n" +
        "![Generated image 2](</tmp/second image.png>)";
      let replayedHistory = "";
      const gateway = new ResponsesGateway({
        port: 0,
        runWebTurn: async (input) => {
          if (input.prompt === "follow-up") {
            replayedHistory = input.context?.history.join("\n") ?? "";
            return "Text follow-up.";
          }
          return {
            kind: "generated_images",
            text: "  ",
            images: [
              {
                base64: "aW1hZ2Ux",
                mimeType: "image/png",
                localPath: "C:\\Users\\Image Test\\圖片 (1).png",
              },
              {
                base64: "aW1hZ2Uy",
                mimeType: "image/png",
                localPath: "/tmp/second image.png",
              },
            ],
          };
        },
      });
      gateways.push(gateway);
      const address = await gateway.start();
      const request = {
        model: "codexgpt-bridge/high",
        input: "generate images",
        stream: transport !== "json",
      };
      const headers = {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      };
      let snapshot: JsonRecord;
      const events: JsonRecord[] = [];
      if (transport === "websocket") {
        const socket = new WebSocket(
          `${address.baseUrl.replace(/^http/, "ws")}/responses`,
          { headers },
        );
        try {
          snapshot = await withTimeout(
            new Promise<JsonRecord>((resolve, reject) => {
              socket.once("error", reject);
              socket.once("open", () =>
                socket.send(
                  JSON.stringify({ ...request, type: "response.create" }),
                ),
              );
              socket.on("message", (data) => {
                const event = JSON.parse(data.toString()) as JsonRecord;
                events.push(event);
                if (event.type === "response.completed")
                  resolve(event.response as JsonRecord);
                if (event.type === "response.failed")
                  reject(new Error(JSON.stringify(event)));
              });
            }),
            "Image WebSocket response did not complete.",
          );
        } finally {
          socket.terminate();
        }
      } else {
        const response = await fetch(`${address.baseUrl}/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify(request),
        });
        assert.equal(response.status, 200);
        if (transport === "json")
          snapshot = (await response.json()) as JsonRecord;
        else {
          events.push(
            ...(await response.text())
              .split("\n")
              .filter((line) => line.startsWith("data: {"))
              .map((line) => JSON.parse(line.slice(6)) as JsonRecord),
          );
          snapshot = events.find((event) => event.type === "response.completed")
            ?.response as JsonRecord;
        }
      }
      const output = snapshot.output as JsonRecord[];
      assert.deepEqual(
        output.map((item) => item.type),
        ["message", "image_generation_call", "image_generation_call"],
      );
      assert.equal(output[0]?.role, "assistant");
      assert.equal((output[0]?.content as JsonRecord[])[0]?.text, expectedText);
      assert.deepEqual(
        output.slice(1).map((item) => item.result),
        ["aW1hZ2Ux", "aW1hZ2Uy"],
      );
      if (transport !== "json") {
        assert.equal(
          events
            .filter((event) => event.type === "response.output_text.delta")
            .map((event) => event.delta)
            .join(""),
          expectedText,
        );
        assert.deepEqual(
          events
            .filter((event) => event.type === "response.output_item.done")
            .map((event) => event.output_index),
          [0, 1, 2],
        );
      }
      const followUp = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...request,
          input: "follow-up",
          previous_response_id: snapshot.id,
          stream: false,
        }),
      });
      assert.equal(followUp.status, 200);
      assert.ok(
        replayedHistory.includes(
          "![Generated image 1](<C:/Users/Image Test/圖片 (1).png>)",
        ),
      );
      assert.doesNotMatch(
        await followUp.text(),
        /Generated image|image_generation_call/,
      );
    });
  }

  it("opens the HTTP event stream before the browser turn completes", async () => {
    let resolveTurn: ((text: string) => void) | undefined;
    const browserTurn = new Promise<string>((resolvePromise) => {
      resolveTurn = resolvePromise;
    });
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async () => browserTurn,
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const response = await withTimeout(
      fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer codex-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/high",
          input: "hello",
          stream: true,
        }),
      }),
      "HTTP stream headers were not sent before the browser turn completed.",
    );
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const firstChunk = await withTimeout(
      reader.read(),
      "HTTP stream did not send an initial event.",
    );
    assert.match(
      Buffer.from(firstChunk.value ?? []).toString("utf8"),
      /response\.created/,
    );
    assert.ok(resolveTurn);
    resolveTurn("delayed-provider-ok");
    let remainder = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remainder += Buffer.from(chunk.value).toString("utf8");
    }
    assert.match(remainder, /delayed-provider-ok/);
    assert.match(remainder, /response\.completed/);
  });

  it("emits application-level heartbeats while an HTTP browser turn is pending", async () => {
    let resolveTurn: ((text: string) => void) | undefined;
    const gateway = new ResponsesGateway({
      port: 0,
      applicationHeartbeatMs: 10,
      runWebTurn: async () =>
        new Promise<string>((resolvePromise) => {
          resolveTurn = resolvePromise;
        }),
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const response = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: "hello",
        stream: true,
      }),
    });
    assert.ok(response.body);
    const reader = response.body.getReader();
    let body = "";
    await withTimeout(
      (async () => {
        while (!body.includes("response.heartbeat")) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("HTTP stream ended before heartbeat");
          body += Buffer.from(chunk.value).toString("utf8");
        }
      })(),
      "HTTP stream did not emit an application heartbeat.",
    );
    resolveTurn?.("done");
    await reader.cancel();
  });

  it("relays a ChatGPT tool envelope to Codex and continues from its result", async () => {
    const prompts: string[] = [];
    const executions: BridgeExecutionPreflight[] = [];
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async (input) => {
        prompts.push(input.prompt);
        assert.ok(input.execution);
        executions.push(input.execution);
        return prompts.length === 1
          ? '<codex_tool_calls>[{"name":"codexgpt-bridge__open_workspace","arguments":{"path":"C:\\\\work"}}]</codex_tool_calls>'
          : "file operation complete";
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const tools = [
      {
        type: "namespace",
        name: "codexgpt-bridge",
        tools: [
          {
            type: "function",
            name: "open_workspace",
            description: "Open an allowed workspace.",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      },
    ];
    const first = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        stream: true,
        input: [
          {
            role: "user",
            content: "C:\\work 可以在這裡新增檔案嗎？",
          },
        ],
        tools,
      }),
    });
    const firstBody = await first.text();
    assert.equal(first.status, 200, firstBody);
    assert.match(prompts[0] ?? "", /work/);
    assert.match(firstBody, /response\.function_call_arguments\.done/);
    assert.match(firstBody, /"name":"open_workspace"/);
    assert.match(firstBody, /"namespace":"codexgpt-bridge"/);
    assert.match(firstBody, /"end_turn":false/);
    assert.doesNotMatch(firstBody, /response\.output_text\.delta/);
    const callId = /"call_id":"(call_[a-f0-9]+)"/.exec(firstBody)?.[1];
    assert.ok(callId);

    const second = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        stream: true,
        input: [
          { role: "user", content: "C:\\work 可以在這裡新增檔案嗎？" },
          {
            type: "function_call",
            call_id: callId,
            name: "open_workspace",
            namespace: "codexgpt-bridge",
            arguments: '{"path":"C:\\\\work"}',
          },
          {
            type: "function_call_output",
            call_id: callId,
            output: '{"workspace_id":"ws_1"}',
          },
        ],
        tools,
      }),
    });
    const secondBody = await second.text();
    assert.equal(second.status, 200, secondBody);
    assert.match(prompts[1] ?? "", /Tool results \(untrusted data\)/);
    assert.match(prompts[1] ?? "", /ws_1/);
    assert.doesNotMatch(prompts[1] ?? "", /Original user request JSON/);
    assert.match(secondBody, /response\.output_text\.delta/);
    assert.match(secondBody, /file operation complete/);
    assert.equal(executions.length, 2);
    for (const execution of executions) {
      assert.equal(execution.toolTransport, "simple");
      assert.equal(execution.operationToolTransport, "simple");
      assert.equal(execution.toolCount, 1);
      assert.equal(execution.route, "codexgpt-bridge/high");
    }
    assert.deepEqual(
      executions.map((execution) => execution.attempt),
      ["initial", "follow-up"],
    );
  });

  for (const prompt of [
    "你知道目前已有幾部，撞號機率多少嗎",
    "請使用工具執行 Write-Output 42，取得工具結果後回覆結果。",
  ]) {
    it(`relays a client tool call and finishes from its result: ${prompt}`, async () => {
      const prompts: string[] = [];
      const gateway = new ResponsesGateway({
        port: 0,
        runWebTurn: async (input) => {
          prompts.push(input.prompt);
          return prompts.length === 1
            ? '<codex_tool_calls>[{"name":"exec_command","arguments":{"cmd":"Write-Output 42"}}]</codex_tool_calls>'
            : "目前共有 42 部。";
        },
      });
      gateways.push(gateway);
      const address = await gateway.start();
      const tools = [{ type: "function", name: "exec_command" }];
      const post = (input: unknown[]) =>
        fetch(`${address.baseUrl}/responses`, {
          method: "POST",
          headers: {
            authorization: "Bearer codex-session",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "codexgpt-bridge/high",
            stream: true,
            tools,
            input,
          }),
        });
      const first = await post([{ role: "user", content: prompt }]);
      const firstBody = await first.text();
      assert.equal(first.status, 200, firstBody);
      assert.deepEqual(prompts, [prompt]);
      assert.match(firstBody, /response\.function_call_arguments\.done/);
      assert.match(firstBody, /"name":"exec_command"/);
      assert.match(firstBody, /"end_turn":false/);
      assert.doesNotMatch(
        firstBody,
        /response\.failed|response\.output_text\.delta/,
      );
      const callId = /"call_id":"(call_[a-f0-9]+)"/.exec(firstBody)?.[1];
      assert.ok(callId);
      const second = await post([
        { role: "user", content: prompt },
        {
          type: "function_call",
          call_id: callId,
          name: "exec_command",
          arguments: '{"cmd":"Write-Output 42"}',
        },
        { type: "function_call_output", call_id: callId, output: "42" },
      ]);
      const secondBody = await second.text();
      assert.equal(prompts.length, 2);
      assert.match(prompts[1] ?? "", /Tool results \(untrusted data\)/);
      assert.match(secondBody, /目前共有 42 部。/);
      assert.match(secondBody, /response\.completed/);
      assert.doesNotMatch(
        secondBody,
        /response\.failed|response\.function_call_arguments/,
      );
    });
  }

  it("repairs a malformed follow-up call once with the current tool names", async () => {
    const prompts: string[] = [];
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async (input) => {
        prompts.push(input.prompt);
        return prompts.length === 1
          ? '<codex_tool_calls>[{"name":"exec_command","arguments":oops}]</codex_tool_calls>'
          : '<codex_tool_call>{"name":"exec_command","arguments":{"cmd":"Write-Output 42"}}</codex_tool_call>';
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const response = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        stream: true,
        input: "你知道目前已有幾部，撞號機率多少嗎",
        tools: [{ type: "function", name: "exec_command" }],
      }),
    });
    const body = await response.text();
    assert.equal(prompts.length, 2);
    assert.match(prompts[1] ?? "", /Exact available names: \["exec_command"\]/);
    assert.match(body, /response\.function_call_arguments\.done/);
    assert.doesNotMatch(body, /response\.failed/);
  });

  it("honors tool_choice none even with declared tools and prior tool results", async () => {
    let attempts = 0;
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async () => {
        attempts++;
        return '<codex_tool_call>{"name":"exec_command","arguments":{}}</codex_tool_call>';
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    for (const continuation of [false, true]) {
      const response = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer codex-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/high",
          stream: true,
          tool_choice: "none",
          tools: [{ type: "function", name: "exec_command" }],
          input: [
            { role: "user", content: "你知道目前已有幾部，撞號機率多少嗎" },
            ...(continuation
              ? [
                  {
                    type: "function_call_output",
                    call_id: "call_old",
                    output: "42",
                  },
                ]
              : []),
          ],
        }),
      });
      const body = await response.text();
      assert.match(body, /response\.failed/);
      assert.doesNotMatch(body, /response\.function_call_arguments\.done/);
    }
    assert.equal(attempts, 2);
  });

  it("stops after one correction when a follow-up keeps requesting a stale tool", async () => {
    let attempts = 0;
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async () => {
        attempts++;
        return '<codex_tool_call>{"name":"old_tool","arguments":{}}</codex_tool_call>';
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const response = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        stream: true,
        input: "你知道目前已有幾部，撞號機率多少嗎",
        tools: [{ type: "function", name: "exec_command" }],
      }),
    });
    const body = await response.text();
    assert.equal(attempts, 2);
    assert.match(body, /unavailable tool: old_tool/);
    assert.match(body, /response\.failed/);
    assert.doesNotMatch(body, /response\.function_call_arguments\.done/);
  });

  it("corrects one prose-only reply when Codex requires a tool", async () => {
    const prompts: string[] = [];
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async (input) => {
        prompts.push(input.prompt);
        return prompts.length === 1
          ? "I cannot access that local folder."
          : '<codex_tool_call>{"name":"open_workspace","arguments":{"path":"C:\\\\work"}}</codex_tool_call>';
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const response = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        stream: true,
        tool_choice: "required",
        input: [{ role: "user", content: "開啟 C:\\work" }],
        tools: [
          {
            type: "function",
            name: "open_workspace",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        ],
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1] ?? "", /tool protocol correction/);
    assert.match(body, /"type":"function_call"/);
    assert.doesNotMatch(body, /I cannot access/);
  });

  it("corrects prose when the prompt explicitly requests a Codex tool", async () => {
    const prompts: string[] = [];
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async (input) => {
        prompts.push(input.prompt);
        return prompts.length === 1
          ? "I cannot access that local file."
          : '<codex_tool_call>{"name":"exec_command","arguments":{"cmd":"Get-Content .bridge-live-probe.txt"}}</codex_tool_call>';
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const response = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        stream: true,
        input: [
          {
            role: "user",
            content: "Please use a Codex tool to read .bridge-live-probe.txt.",
          },
        ],
        tools: [
          {
            type: "function",
            name: "exec_command",
            parameters: {
              type: "object",
              properties: { cmd: { type: "string" } },
              required: ["cmd"],
            },
          },
        ],
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1] ?? "", /tool protocol correction/);
    assert.match(body, /"type":"function_call"/);
    assert.doesNotMatch(body, /I cannot access/);
  });

  it("handles Codex response.create turns over WebSocket", async () => {
    let resolveTurn: ((text: string) => void) | undefined;
    const browserTurn = new Promise<string>((resolvePromise) => {
      resolveTurn = resolvePromise;
    });
    let seenMode = "";
    let seenPrompt = "";
    const gateway = new ResponsesGateway({
      port: 0,
      applicationHeartbeatMs: 10,
      runWebTurn: async (input) => {
        seenMode = input.mode;
        seenPrompt = input.prompt;
        return browserTurn;
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const webSocketUrl = `${address.baseUrl.replace(/^http/, "ws")}/responses`;
    const webSocket = new WebSocket(webSocketUrl, {
      headers: {
        authorization: "Bearer codex-session",
        "x-codex-routing-hint": "model=codexgpt-bridge/high",
      },
    });
    try {
      await withTimeout(
        new Promise<void>((resolvePromise, rejectPromise) => {
          webSocket.once("open", resolvePromise);
          webSocket.once("error", rejectPromise);
        }),
        "WebSocket upgrade did not complete.",
      );
      const messages: JsonRecord[] = [];
      let resolveStarted: (() => void) | undefined;
      let resolveHeartbeat: (() => void) | undefined;
      let resolveCompleted: (() => void) | undefined;
      const started = new Promise<void>((resolvePromise) => {
        resolveStarted = resolvePromise;
      });
      const heartbeat = new Promise<void>((resolvePromise) => {
        resolveHeartbeat = resolvePromise;
      });
      const completed = new Promise<void>((resolvePromise) => {
        resolveCompleted = resolvePromise;
      });
      webSocket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as JsonRecord;
        messages.push(event);
        if (event.type === "response.created") resolveStarted?.();
        if (event.type === "response.heartbeat") resolveHeartbeat?.();
        if (event.type === "response.completed") resolveCompleted?.();
      });
      webSocket.send(
        JSON.stringify({
          type: "response.create",
          model: "codexgpt-bridge/high",
          input: [{ role: "user", content: "hello over websocket" }],
          stream: true,
        }),
      );
      await withTimeout(
        started,
        "WebSocket did not send response.created before the browser turn completed.",
      );
      assert.equal(seenMode, "high");
      assert.match(seenPrompt, /hello over websocket/);
      await withTimeout(
        heartbeat,
        "WebSocket did not send an application heartbeat while the browser turn was pending.",
      );
      assert.ok(resolveTurn);
      resolveTurn("websocket-provider-ok");
      await withTimeout(completed, "WebSocket response did not complete.");
      assert.ok(
        messages.some(
          (event) =>
            event.type === "response.output_text.delta" &&
            event.delta === "websocket-provider-ok",
        ),
      );
    } finally {
      webSocket.terminate();
    }
  });

  it("cancels an active WebSocket response without waiting behind it", async () => {
    let resolveStarted: (() => void) | undefined;
    let resolveAborted: (() => void) | undefined;
    const started = new Promise<void>((resolvePromise) => {
      resolveStarted = resolvePromise;
    });
    const aborted = new Promise<void>((resolvePromise) => {
      resolveAborted = resolvePromise;
    });
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async ({ signal }) =>
        new Promise<string>((_resolvePromise, rejectPromise) => {
          resolveStarted?.();
          signal.addEventListener(
            "abort",
            () => {
              resolveAborted?.();
              rejectPromise(
                new DOMException("Provider turn was cancelled.", "AbortError"),
              );
            },
            { once: true },
          );
        }),
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const webSocket = new WebSocket(
      `${address.baseUrl.replace(/^http/, "ws")}/responses`,
      {
        headers: {
          authorization: "Bearer codex-session",
          "x-codex-routing-hint": "model=codexgpt-bridge/high",
        },
      },
    );
    try {
      await withTimeout(
        new Promise<void>((resolvePromise, rejectPromise) => {
          webSocket.once("open", resolvePromise);
          webSocket.once("error", rejectPromise);
        }),
        "WebSocket upgrade did not complete.",
      );
      webSocket.send(
        JSON.stringify({
          type: "response.create",
          model: "codexgpt-bridge/high",
          input: [{ role: "user", content: "wait until cancelled" }],
          stream: true,
        }),
      );
      await withTimeout(started, "Browser turn did not start.");
      webSocket.send(JSON.stringify({ type: "response.cancel" }));
      await withTimeout(aborted, "WebSocket cancellation was not immediate.");
    } finally {
      webSocket.terminate();
    }
  });

  it("routes Codex zstd-compressed request bodies to Bridge Web models", async () => {
    let mode = "";
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async (input) => {
        mode = input.mode;
        return "compressed-ok";
      },
      fetchImpl: async () => {
        throw new Error("native fetch must not run");
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const compressed = zstdCompressSync(
      Buffer.from(
        JSON.stringify({
          model: "codexgpt-bridge/high",
          input: "hello",
          stream: false,
        }),
      ),
    );
    const response = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
        "content-encoding": "zstd",
      },
      body: new Uint8Array(compressed),
    });
    assert.equal(response.status, 200);
    assert.equal(mode, "high");
    assert.match(await response.text(), /compressed-ok/);
  });

  it("passes the original provider catalog through with Codex headers and appends Bridge models", async () => {
    let seenUrl = "";
    let seenAuthorization = "";
    let originalProviderBaseUrl = "https://original.example/codex";
    const gateway = new ResponsesGateway({
      port: 0,
      upstreamBaseUrl: () => originalProviderBaseUrl,
      runWebTurn: async () => "unused",
      fetchImpl: async (input, init) => {
        seenUrl = String(input);
        seenAuthorization =
          new Headers(init?.headers).get("authorization") ?? "";
        return new Response(
          JSON.stringify({ models: [{ slug: "native-1" }] }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const response = await fetch(
      `${address.baseUrl}/models?client_version=1.2.3`,
      {
        headers: { authorization: "Bearer codex-oauth-token" },
      },
    );
    const payload = (await response.json()) as {
      models: Array<{ slug: string }>;
    };
    assert.equal(
      seenUrl,
      "https://original.example/codex/models?client_version=1.2.3",
    );
    assert.equal(seenAuthorization, "Bearer codex-oauth-token");
    assert.deepEqual(
      payload.models.map((model) => model.slug),
      ["native-1", ...CODEXGPT_BRIDGE_WEB_MODEL_IDS],
    );

    originalProviderBaseUrl = "https://replacement.example/v1/";
    await fetch(`${address.baseUrl}/models`, {
      headers: { authorization: "Bearer codex-oauth-token" },
    });
    assert.equal(seenUrl, "https://replacement.example/v1/models");
  });

  it("routes every non-Bridge model to the captured provider without namespace rules", async () => {
    const seenUrls: string[] = [];
    const seenModels: string[] = [];
    const gateway = new ResponsesGateway({
      port: 0,
      upstreamBaseUrl: "http://original-provider.example/api/v1",
      runWebTurn: async () => "unused",
      fetchImpl: async (input, init) => {
        const url = String(input);
        seenUrls.push(url);
        if (url === "http://original-provider.example/api/v1/models") {
          return Response.json({
            models: [
              { slug: "gpt-6.1-sol" },
              { slug: "chatgpt-web/high", display_name: "Web High" },
              { slug: "acme-router/custom", display_name: "Custom" },
            ],
          });
        }
        if (url === "http://original-provider.example/api/v1/responses") {
          const request = JSON.parse(String(init?.body)) as { model: string };
          seenModels.push(request.model);
          return new Response(`original-ok:${request.model}`, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        throw new Error(`unexpected URL: ${url}`);
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const models = await fetch(`${address.baseUrl}/models`, {
      headers: { authorization: "Bearer codex-session" },
    });
    const catalog = (await models.json()) as {
      models: Array<{ slug: string }>;
    };
    assert.deepEqual(
      catalog.models.map((model) => model.slug),
      [
        "gpt-6.1-sol",
        "chatgpt-web/high",
        "acme-router/custom",
        ...CODEXGPT_BRIDGE_WEB_MODEL_IDS,
      ],
    );

    for (const model of [
      "gpt-6.1-sol",
      "chatgpt-web/high",
      "acme-router/custom",
    ]) {
      const passthrough = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer codex-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, input: "hello" }),
      });
      assert.equal(await passthrough.text(), `original-ok:${model}`);
    }
    assert.deepEqual(seenModels, [
      "gpt-6.1-sol",
      "chatgpt-web/high",
      "acme-router/custom",
    ]);
    assert.equal(
      seenUrls.filter(
        (url) => url === "http://original-provider.example/api/v1/responses",
      ).length,
      3,
    );
  });

  it("drains atomically, lets accepted work finish and resumes with the owning transaction", async () => {
    const adminToken = "a".repeat(64);
    let startTurn!: () => void;
    let finishTurn!: () => void;
    const started = new Promise<void>((resolve) => {
      startTurn = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    const gateway = new ResponsesGateway({
      port: 0,
      admin: { token: adminToken },
      runWebTurn: async () => {
        startTurn();
        await finish;
        return "drained safely";
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const adminBase = address.baseUrl.replace(/\/v1$/u, "");
    const headers = {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    };
    const active = fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: "finish this turn",
        metadata: {
          thread_id: "thread_drain",
          turn_id: "turn_drain",
        },
      }),
    });
    await started;
    const drained = await fetch(`${adminBase}/admin/drain`, {
      method: "POST",
      headers,
    });
    const drain = (await drained.json()) as JsonRecord;
    assert.equal(drain.state, "draining");
    assert.equal(drain.accepting_turns, false);
    assert.equal(drain.active_http_turns, 1);
    assert.equal(drain.active_browser_turns, 1);

    const rejected = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/high",
        input: "must not enter",
      }),
    });
    assert.equal(rejected.status, 503);
    assert.equal(
      ((await rejected.json()) as { error: { code: string } }).error.code,
      "provider_draining",
    );

    finishTurn();
    assert.equal((await active).status, 200);
    const settled = (await (
      await fetch(`${adminBase}/admin/lifecycle`, { headers })
    ).json()) as JsonRecord;
    assert.equal(settled.state, "drained");
    assert.equal(settled.active_http_turns, 0);
    assert.equal(settled.active_browser_turns, 0);

    const wrongResume = await fetch(`${adminBase}/admin/resume`, {
      method: "POST",
      headers,
      body: JSON.stringify({ drain_id: "drain_not_owner" }),
    });
    assert.equal(wrongResume.status, 409);
    const resumed = await fetch(`${adminBase}/admin/resume`, {
      method: "POST",
      headers,
      body: JSON.stringify({ drain_id: drain.drain_id }),
    });
    assert.equal(resumed.status, 200);
    assert.equal(((await resumed.json()) as JsonRecord).state, "accepting");
  });

  it("uses the authenticated interrupt endpoint to cancel only an exact native turn", async () => {
    const adminToken = "b".repeat(64);
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const seen: string[] = [];
    const gateway = new ResponsesGateway({
      port: 0,
      admin: { token: adminToken },
      runWebTurn: async (input) => {
        seen.push(input.turnId ?? "missing");
        if (input.turnId === "turn_target") {
          started();
          await new Promise<never>((_resolve, reject) => {
            if (input.signal.aborted) reject(input.signal.reason);
            input.signal.addEventListener(
              "abort",
              () => reject(input.signal.reason),
              { once: true },
            );
          });
        }
        return "unrelated turn completed";
      },
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const adminBase = address.baseUrl.replace(/\/v1$/u, "");
    const request = (turnId: string) =>
      fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer codex-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/high",
          input: "interrupt probe",
          metadata: { thread_id: "thread_exact", turn_id: turnId },
        }),
      });
    const target = request("turn_target");
    await running;

    const unauthorized = await fetch(`${adminBase}/admin/interrupt-turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        thread_id: "thread_exact",
        turn_id: "turn_target",
      }),
    });
    assert.equal(unauthorized.status, 401);
    const interrupted = await fetch(`${adminBase}/admin/interrupt-turn`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        thread_id: "thread_exact",
        turn_id: "turn_target",
      }),
    });
    const result = (await interrupted.json()) as JsonRecord;
    assert.equal(interrupted.status, 200);
    assert.equal(result.matched_http, 1);
    assert.equal(result.already_interrupted, false);
    assert.notEqual((await target).status, 200);

    const unrelated = await request("turn_newer");
    assert.equal(unrelated.status, 200);
    assert.deepEqual(seen, ["turn_target", "turn_newer"]);
    const duplicate = await fetch(`${adminBase}/admin/interrupt-turn`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        thread_id: "thread_exact",
        turn_id: "turn_target",
      }),
    });
    assert.equal(
      ((await duplicate.json()) as JsonRecord).already_interrupted,
      true,
    );
  });

  it("requires an owned idle drain before invoking administrative shutdown", async () => {
    const adminToken = "c".repeat(64);
    let shutdown!: () => void;
    const shutdownCalled = new Promise<void>((resolve) => {
      shutdown = resolve;
    });
    const gateway = new ResponsesGateway({
      port: 0,
      admin: { token: adminToken, onShutdown: shutdown },
      runWebTurn: async () => "unused",
    });
    gateways.push(gateway);
    const address = await gateway.start();
    const adminBase = address.baseUrl.replace(/\/v1$/u, "");
    const headers = {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    };
    const drain = (await (
      await fetch(`${adminBase}/admin/drain`, { method: "POST", headers })
    ).json()) as JsonRecord;
    assert.equal(drain.state, "drained");

    const wrongOwner = await fetch(`${adminBase}/admin/shutdown`, {
      method: "POST",
      headers,
      body: JSON.stringify({ drain_id: "drain_not_owner" }),
    });
    assert.equal(wrongOwner.status, 409);
    const accepted = await fetch(`${adminBase}/admin/shutdown`, {
      method: "POST",
      headers,
      body: JSON.stringify({ drain_id: drain.drain_id }),
    });
    assert.equal(accepted.status, 202);
    assert.equal(
      ((await accepted.json()) as JsonRecord).state,
      "shutting-down",
    );
    await shutdownCalled;
  });
});
