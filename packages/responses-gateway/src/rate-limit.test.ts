import assert from "node:assert/strict";
import { it } from "node:test";
import { ResponsesGateway } from "./responses-server.js";

it("reports preparation failure as a client error instead of retryable server failure", async () => {
  const gateway = new ResponsesGateway({
    port: 0,
    runWebTurn: async () => {
      throw Object.assign(new Error("Model picker missing"), {
        code: "chatgpt_web_preparation_failed",
      });
    },
  });
  try {
    const address = await gateway.start();
    const response = await fetch(address.baseUrl + "/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer fixture",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "codexgpt-bridge/high", input: "test" }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as {
      error: { type: string; code: string };
    };
    assert.equal(body.error.type, "invalid_request_error");
    assert.equal(body.error.code, "codexgpt_bridge_preparation_failed");
  } finally {
    await gateway.close();
  }
});

for (const stream of [false, true]) {
  it(`reports Web rate limits through ${stream ? "SSE" : "HTTP"} without retrying`, async () => {
    let calls = 0;
    const gateway = new ResponsesGateway({
      port: 0,
      runWebTurn: async () => {
        calls++;
        throw Object.assign(new Error("ChatGPT Web cooldown"), {
          code: "chatgpt_web_rate_limited",
          retryAfterSeconds: 120,
        });
      },
    });
    try {
      const address = await gateway.start();
      const response = await fetch(address.baseUrl + "/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer fixture",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/high",
          input: "test",
          stream,
        }),
      });
      if (stream) {
        assert.equal(response.status, 200);
        const events = (await response.text())
          .split("\n")
          .filter(
            (line) => line.startsWith("data: ") && !line.includes("[DONE]"),
          )
          .map((line) => JSON.parse(line.slice(6)));
        const failure = events.find(
          (event) => event.type === "response.failed",
        );
        assert.equal(failure.response.error.type, "rate_limit_error");
        assert.equal(failure.response.error.code, "rate_limit_exceeded");
        assert.equal(failure.response.error.retry_after_seconds, 120);
      } else {
        assert.equal(response.status, 429);
        assert.equal(response.headers.get("retry-after"), "120");
        const body = (await response.json()) as {
          error: { code: string; retry_after_seconds: number };
        };
        assert.equal(body.error.code, "rate_limit_exceeded");
        assert.equal(body.error.retry_after_seconds, 120);
      }
      assert.equal(calls, 1);
    } finally {
      await gateway.close();
    }
  });
}

it("does not classify a generic error mentioning rate limits as a Web cooldown", async () => {
  const gateway = new ResponsesGateway({
    port: 0,
    runWebTurn: async () => {
      throw new Error("unknown rate limit documentation error");
    },
  });
  try {
    const address = await gateway.start();
    const response = await fetch(address.baseUrl + "/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer fixture",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "codexgpt-bridge/high", input: "test" }),
    });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("retry-after"), null);
  } finally {
    await gateway.close();
  }
});
