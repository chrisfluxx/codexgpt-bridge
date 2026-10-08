import assert from "node:assert/strict";
import { it } from "node:test";
import WebSocket from "ws";
import {
  ResponsesGateway,
  buildWebOnlyModelsPayload,
  CODEXGPT_BRIDGE_WEB_MODEL_IDS,
} from "./responses-server.js";

const token = "ab".repeat(32);
const catalog = {
  models: [
    {
      slug: "gpt-native",
      base_instructions: "Fixture",
      supports_reasoning_summaries: false,
      supports_parallel_tool_calls: true,
      visibility: "list",
      supported_in_api: true,
    },
  ],
};

it("discovers and runs all seven Web models with no native auth or native upstream calls", async () => {
  const modes: string[] = [];
  const gateway = new ResponsesGateway({
    port: 0,
    webOnly: { token, models: async () => catalog },
    fetchImpl: async () => {
      throw new Error("Native inference unavailable: quota exhausted");
    },
    runWebTurn: async ({ mode }) => {
      modes.push(mode);
      return "<codex_text>WEB_OK</codex_text>";
    },
  });
  const address = await gateway.start();
  const url = address.baseUrl.replace("/v1", "/web/v1");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  try {
    const models = await fetch(url + "/models", { headers });
    assert.equal(models.status, 200);
    assert.deepEqual(
      ((await models.json()) as { models: { slug: string }[] }).models.map(
        (m) => m.slug,
      ),
      CODEXGPT_BRIDGE_WEB_MODEL_IDS,
    );
    for (const model of CODEXGPT_BRIDGE_WEB_MODEL_IDS) {
      const response = await fetch(url + "/responses", {
        method: "POST",
        headers,
        body: JSON.stringify({ model, input: "Hello", stream: true }),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /WEB_OK/u);
      assert.match(text, /response.completed/u);
      assert.ok(text.includes(model));
    }
    assert.deepEqual(modes, [
      "instant",
      "medium",
      "high",
      "extra-high",
      "pro",
      "luna",
      "think",
    ]);
  } finally {
    await gateway.close();
  }
});

it("keeps Pro selectable and recovers without changing the installed capability snapshot or restarting", async () => {
  let turns = 0;
  let proAvailable = false;
  const gateway = new ResponsesGateway({
    port: 0,
    webOnly: { token, models: async () => catalog },
    availableWebModes: async () => ["instant", "medium", "high", "extra-high"],
    accountContextProfile: () => "standard",
    fetchImpl: async () => {
      throw new Error("A Pro request must stay in the browser provider.");
    },
    runWebTurn: async (input) => {
      assert.equal(input.mode, "pro");
      assert.equal(input.execution?.contextWindow, 112_193);
      if (!proAvailable)
        throw new Error("ChatGPT Pro is temporarily unavailable.");
      turns++;
      return "<codex_text>PRO_RECOVERED</codex_text>";
    },
  });
  const address = await gateway.start();
  const url = address.baseUrl.replace("/v1", "/web/v1");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  try {
    const models = await fetch(url + "/models", { headers });
    assert.deepEqual(
      ((await models.json()) as { models: { slug: string }[] }).models.map(
        (model) => model.slug,
      ),
      [
        "codexgpt-bridge/instant",
        "codexgpt-bridge/medium",
        "codexgpt-bridge/high",
        "codexgpt-bridge/extra-high",
        "codexgpt-bridge/pro",
      ],
    );
    const unavailable = await fetch(url + "/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "codexgpt-bridge/pro",
        input: "Hello",
        stream: true,
      }),
    });
    const failure = await unavailable.text();
    assert.match(failure, /response.failed/u);
    assert.match(failure, /temporarily unavailable/u);
    assert.equal(turns, 0);
    proAvailable = true;
    for (const endpoint of [url, address.baseUrl]) {
      const restored = await fetch(endpoint + "/responses", {
        method: "POST",
        headers: {
          ...headers,
          Authorization:
            endpoint === url ? headers.Authorization : "Bearer codex-session",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/pro",
          input: "Hello again",
          stream: true,
        }),
      });
      assert.equal(restored.status, 200);
      const completion = await restored.text();
      assert.match(completion, /PRO_RECOVERED/u);
      assert.match(completion, /response.completed/u);
    }
    assert.equal(turns, 2);
  } finally {
    await gateway.close();
  }
});

it("blocks native and legacy models, wrong credentials and credential leakage to native endpoints", async () => {
  let upstreamCalls = 0;
  let turns = 0;
  const gateway = new ResponsesGateway({
    port: 0,
    webOnly: { token, models: async () => catalog },
    fetchImpl: async () => {
      upstreamCalls++;
      return new Response("native");
    },
    runWebTurn: async () => {
      turns++;
      return "<codex_text>OK</codex_text>";
    },
  });
  const address = await gateway.start();
  const url = address.baseUrl.replace("/v1", "/web/v1");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  try {
    for (const model of [
      "gpt-reserve",
      "gpt-5.6-luna",
      "gpt-native",
      "chatgpt-web/high",
      "codexgpt-bridge/unknown",
    ]) {
      const response = await fetch(url + "/responses", {
        method: "POST",
        headers,
        body: JSON.stringify({ model, input: "hello" }),
      });
      assert.equal(response.status, 400);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        "web_only_model_required",
      );
    }
    for (const path of ["/usage", "/images/generations", "/responses/other"]) {
      const response = await fetch(url + path, { headers });
      assert.equal(response.status, 404);
      await response.text();
    }
    for (const Authorization of [
      "Bearer native-account-token",
      "Bearer ",
      "",
    ]) {
      const response = await fetch(url + "/models", {
        headers: { Authorization },
      });
      assert.equal(response.status, 401);
      await response.text();
    }
    const leaked = await fetch(address.baseUrl + "/models", { headers });
    assert.equal(leaked.status, 401);
    await leaked.text();
    assert.equal(upstreamCalls, 0);
    assert.equal(turns, 0);
    const native = await fetch(address.baseUrl + "/models", {
      headers: { Authorization: "Bearer real-native-token" },
    });
    await native.text();
    assert.equal(upstreamCalls, 1);
  } finally {
    await gateway.close();
  }
});

it("authenticates Web-only WebSockets and preserves the selected model in streamed output", async () => {
  const gateway = new ResponsesGateway({
    port: 0,
    webOnly: { token, models: async () => catalog },
    runWebTurn: async () => "<codex_text>WS_WEB_OK</codex_text>",
  });
  const address = await gateway.start();
  try {
    const ws = new WebSocket(
      address.baseUrl.replace("http:", "ws:").replace("/v1", "/web/v1") +
        "/responses",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("Web-only WebSocket timeout"));
      }, 5000);
      ws.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ws.on("open", () =>
        ws.send(
          JSON.stringify({
            type: "response.create",
            model: "codexgpt-bridge/pro",
            input: "Hello",
          }),
        ),
      );
      ws.on("message", (data) => {
        const event = JSON.parse(data.toString());
        if (event.type !== "response.completed") return;
        clearTimeout(timer);
        assert.equal(event.response.model, "codexgpt-bridge/pro");
        assert.ok(JSON.stringify(event).includes("WS_WEB_OK"));
        ws.close();
        resolve();
      });
    });
  } finally {
    await gateway.close();
  }
  const result = buildWebOnlyModelsPayload(catalog) as {
    models: { slug: string }[];
  };
  assert.equal(result.models.length, 7);
  assert.deepEqual(buildWebOnlyModelsPayload(result), result);
});
