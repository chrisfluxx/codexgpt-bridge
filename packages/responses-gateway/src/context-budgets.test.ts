import assert from "node:assert/strict";
import { it } from "node:test";
import {
  resolveBridgeContextBudget,
  resolveBridgeRouteContextBudget,
} from "./context-budgets.js";
import {
  availableNativeModelRoutes,
  bridgeCatalogWebModes,
} from "./native-model-routes.js";
import {
  bridgeExecutionLimitProblem,
  buildStartupModelsPayload,
  buildWebOnlyModelsPayload,
  ResponsesGateway,
  synchronizeBridgeExecutionPreflight,
  type BridgeExecutionPreflight,
} from "./responses-server.js";

function execution(
  overrides: Partial<BridgeExecutionPreflight> = {},
): BridgeExecutionPreflight {
  const budget = resolveBridgeContextBudget("high", "pro");
  return {
    version: 1,
    route: "codexgpt-bridge/high",
    mode: "high",
    operationToolTransport: "full",
    toolTransport: "full",
    attempt: "initial",
    toolCount: 0,
    sourceContextTokens: 111_192,
    inputBasis: "full-context",
    inputTokens: 111_192,
    textTokens: 103_000,
    textCharacters: 400_000,
    imageCount: 0,
    imageReserveTokens: 0,
    platformReserveTokens: 8_192,
    contextWindow: budget.contextWindow,
    autoCompactTokenLimit: budget.autoCompactTokenLimit,
    hardInputTokenLimit: budget.hardInputTokenLimit,
    browserMessageTokenLimit: budget.browserMessageTokenLimit!,
    browserComposerCharLimit: budget.browserComposerCharLimit!,
    remainingInputTokens: 1,
    status: "compaction-recommended",
    budgetProfile: budget.profile!,
    ...overrides,
  };
}

it("separates standard account modes, Pro account modes, and the current bounded Luna envelope", () => {
  const instant = resolveBridgeContextBudget("instant", "standard");
  assert.equal(instant.contextWindow, 41_000);
  assert.equal(instant.autoCompactTokenLimit, 32_000);
  assert.equal(instant.browserComposerCharLimit, 211_256);
  for (const mode of ["medium", "high", "extra-high"] as const) {
    const standard = resolveBridgeContextBudget(mode, "standard");
    assert.equal(standard.contextWindow, 90_000);
    assert.equal(standard.autoCompactTokenLimit, 80_000);
    assert.equal(standard.browserComposerCharLimit, 1_048_572);
    const pro = resolveBridgeContextBudget(mode, "pro");
    assert.equal(pro.contextWindow, 111_193);
    assert.equal(pro.autoCompactTokenLimit, 95_000);
    assert.equal(pro.browserMessageTokenLimit, 103_000);
    assert.equal(pro.browserComposerCharLimit, 500_000);
  }
  const proModel = resolveBridgeContextBudget("pro", "pro");
  assert.equal(proModel.contextWindow, 112_193);
  assert.equal(proModel.browserMessageTokenLimit, 104_000);
  assert.equal(proModel.browserComposerCharLimit, 1_635_000);
  assert.equal(
    resolveBridgeContextBudget("instant", "pro").browserComposerCharLimit,
    545_000,
  );
  assert.equal(
    resolveBridgeContextBudget("luna", "standard").hardInputTokenLimit,
    28_000,
  );
  assert.throws(
    () => resolveBridgeContextBudget("pro", "standard"),
    /Pro-capable/u,
  );
});

it("stages verified GPT-5.6 and GPT-6 Full reasoning context while retaining bounded messages and Instant routes", () => {
  const modes = ["instant", "medium", "high", "extra-high", "pro"] as const;
  const full = availableNativeModelRoutes(modes, "pro", ["5.6", "6"]);
  for (const slug of [
    "gpt-6-sol",
    "gpt-6-sol-3x",
    "gpt-5.6-sol",
    "gpt-5.6-sol-3x",
  ]) {
    const route = full.find((row) => row.slug === `codexgpt-bridge/${slug}`)!;
    assert.deepEqual(route.supportedEfforts, ["medium", "high", "xhigh"]);
    const budget = resolveBridgeRouteContextBudget(route, "pro");
    assert.equal(budget.contextWindow, 240_000);
    assert.equal(budget.hardInputTokenLimit, 240_000);
    assert.equal(budget.autoCompactTokenLimit, 220_000);
    assert.equal(budget.browserMessageTokenLimit, 103_000);
    assert.equal(budget.browserComposerCharLimit, 500_000);
    assert.equal(budget.stagedContext, true);
  }
  for (const slug of [
    "gpt-5.6-sol-instant",
    "gpt-6-sol-instant",
    "gpt-6-pro",
  ]) {
    const route = full.find((row) => row.slug === `codexgpt-bridge/${slug}`)!;
    const budget = resolveBridgeRouteContextBudget(route, "pro");
    assert.equal(budget.stagedContext, undefined);
    assert.equal(
      budget.contextWindow,
      slug === "gpt-6-pro" ? 112_193 : 111_193,
    );
  }
  const simple = availableNativeModelRoutes(modes, "pro", ["6"], "simple").find(
    (row) => row.slug === "codexgpt-bridge/gpt-6-sol",
  )!;
  assert.deepEqual(simple.supportedEfforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(
    resolveBridgeRouteContextBudget(simple, "pro").contextWindow,
    111_193,
  );
  const standard = availableNativeModelRoutes(modes, "standard", ["6"]).find(
    (row) => row.slug === "codexgpt-bridge/gpt-6-sol",
  )!;
  assert.equal(
    resolveBridgeRouteContextBudget(standard, "standard").contextWindow,
    90_000,
  );
  assert.equal(standard.stagedContext, undefined);
  const catalog = buildStartupModelsPayload({ models: [] }, modes, "pro", [
    "5.6",
    "6",
  ]) as { models: Array<Record<string, unknown>> };
  const model = catalog.models.find(
    (row) => row.slug === "codexgpt-bridge/gpt-6-sol",
  )!;
  assert.equal(model.context_window, 240_000);
  assert.equal(model.auto_compact_token_limit, 220_000);
  assert.equal(model.effective_context_window_percent, 92);
  const sol56 = catalog.models.find(
    (row) => row.slug === "codexgpt-bridge/gpt-5.6-sol",
  )!;
  const instant56 = catalog.models.find(
    (row) => row.slug === "codexgpt-bridge/gpt-5.6-sol-instant",
  )!;
  assert.equal(sol56.visibility, "list");
  assert.equal(sol56.context_window, 240_000);
  assert.equal(sol56.auto_compact_token_limit, 220_000);
  assert.equal(instant56.visibility, "list");
  assert.equal(instant56.context_window, 111_193);
  assert.equal(instant56.auto_compact_token_limit, 95_000);
});

it("enforces the inclusive single-message token boundary and counts image reserves before Send", () => {
  assert.equal(bridgeExecutionLimitProblem(execution()), undefined);
  assert.match(
    bridgeExecutionLimitProblem(
      execution({ textTokens: 103_001, inputTokens: 111_193 }),
    )!,
    /message.*103,000/u,
  );
  assert.match(
    bridgeExecutionLimitProblem(
      execution({
        textTokens: 100_000,
        imageReserveTokens: 4_096,
        imageCount: 1,
        inputTokens: 110_000,
      }),
    )!,
    /visible tokens/u,
  );
  assert.match(
    bridgeExecutionLimitProblem(execution({ inputTokens: 112_000 }))!,
    /transport limit/u,
  );
});

it("keeps checkpoint messages within token and composer boundaries", () => {
  const checkpoint = execution({
    status: "compaction-bypass",
    inputTokens: 300_000,
  });
  assert.equal(bridgeExecutionLimitProblem(checkpoint), undefined);
  assert.match(
    bridgeExecutionLimitProblem({ ...checkpoint, textTokens: 103_001 })!,
    /message/,
  );
  assert.match(
    bridgeExecutionLimitProblem({ ...checkpoint, textCharacters: 500_001 })!,
    /characters/,
  );
});

it("recalculates message boundaries from the synchronized payload without hiding canonical growth", () => {
  const source = execution({
    sourceContextTokens: 300_000,
    textCharacters: 800_000,
    inputTokens: 300_000,
  });
  const synchronized = synchronizeBridgeExecutionPreflight(source, {
    prompt: "Small incremental message",
    images: [],
  });
  assert.equal(synchronized.sourceContextTokens, 300_000);
  assert.equal(synchronized.browserMessageTokenLimit, 103_000);
  assert.equal(synchronized.browserComposerCharLimit, 500_000);
  assert.equal(bridgeExecutionLimitProblem(synchronized), undefined);
  const tooManyCharacters = synchronizeBridgeExecutionPreflight(source, {
    prompt: "a".repeat(500_001),
    images: [],
  });
  assert.ok(
    tooManyCharacters.inputTokens < tooManyCharacters.hardInputTokenLimit,
  );
  assert.match(
    bridgeExecutionLimitProblem(tooManyCharacters)!,
    /500,001 characters.*500,000/u,
  );
});

it("publishes the selected account budget while preserving native provider rows and Web-only instructions", () => {
  const native = {
    slug: "native-model",
    context_window: 1_000_000,
    base_instructions: "Native instructions",
    custom_field: "preserve",
    supports_reasoning_summaries: false,
    supports_parallel_tool_calls: false,
  };
  const pro = buildStartupModelsPayload(
    { models: [native] },
    ["instant", "high", "pro"],
    "pro",
  ) as { models: Array<Record<string, unknown>> };
  assert.deepEqual(pro.models[0], native);
  const high = pro.models.find((row) => row.slug === "codexgpt-bridge/high")!;
  assert.equal(high.context_window, 111_193);
  assert.equal(high.auto_compact_token_limit, 95_000);
  const standard = buildStartupModelsPayload(
    { models: [native] },
    ["instant", "high", "pro"],
    "standard",
  ) as typeof pro;
  assert.equal(
    standard.models.find((row) => row.slug === "codexgpt-bridge/instant")!
      .context_window,
    41_000,
  );
  assert.equal(
    standard.models.find((row) => row.slug === "codexgpt-bridge/high")!
      .auto_compact_token_limit,
    80_000,
  );
  assert.equal(
    standard.models.some((row) => row.slug === "codexgpt-bridge/pro"),
    true,
  );
  const before = structuredClone(pro);
  const web = buildWebOnlyModelsPayload(
    { models: pro.models.slice(1) },
    undefined,
    "standard",
  ) as typeof pro;
  assert.equal(
    web.models.find((row) => row.slug === "codexgpt-bridge/high")!
      .context_window,
    90_000,
  );
  assert.equal(web.models[0]!.base_instructions, "Native instructions");
  assert.deepEqual(pro, before);
});

it("preserves the probed account budgets through refresh while Pro remains listed", () => {
  const available = ["instant", "medium", "high", "extra-high"] as const;
  const installed = buildStartupModelsPayload(
    { models: [{ slug: "native" }] },
    available,
    "standard",
  ) as { models: Array<Record<string, unknown>> };
  assert.deepEqual(bridgeCatalogWebModes(installed), available);
  const refreshed = buildStartupModelsPayload(
    installed,
    bridgeCatalogWebModes(installed),
    "standard",
  ) as typeof installed;
  assert.deepEqual(bridgeCatalogWebModes(refreshed), available);
  assert.equal(
    refreshed.models.find((row) => row.slug === "codexgpt-bridge/pro")!
      .context_window,
    112_193,
  );
  assert.equal(
    refreshed.models.find((row) => row.slug === "codexgpt-bridge/high")!
      .context_window,
    90_000,
  );
  assert.equal(
    refreshed.models.find((row) => row.slug === "codexgpt-bridge/instant")!
      .context_window,
    41_000,
  );
  const legacyWebOnly = {
    models: installed.models.filter(
      (row) =>
        String(row.slug).startsWith("codexgpt-bridge/") &&
        row.slug !== "codexgpt-bridge/pro",
    ),
  };
  const web = buildWebOnlyModelsPayload(
    legacyWebOnly,
    available,
    "standard",
  ) as typeof installed;
  assert.deepEqual(bridgeCatalogWebModes(web), available);
  assert.ok(web.models.some((row) => row.slug === "codexgpt-bridge/pro"));
});

it("rejects an over-character Pro message even when it fits the token window", async () => {
  let sends = 0;
  const gateway = new ResponsesGateway({
    port: 0,
    accountContextProfile: () => "pro",
    runWebTurn: async () => {
      sends++;
      return "Must not send";
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
        input: "a".repeat(500_001),
        stream: false,
      }),
    });
    assert.equal(response.status, 400);
    const result = (await response.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(result.error.code, "bridge_context_limit_exceeded");
    assert.match(result.error.message, /character message limit/u);
    assert.equal(sends, 0);
  } finally {
    await gateway.close();
  }
});

it("attaches the resolved account budget to the actual Full browser execution receipt", async () => {
  const { FullTurnBroker } = await import("./full-turn-broker.js");
  const broker = new FullTurnBroker();
  const gateway = new ResponsesGateway({
    port: 0,
    accountContextProfile: () => "pro",
    fullMcp: { broker, enabled: () => true, connectorName: () => "Bridge" },
    runWebTurn: async (input) => {
      assert.equal(input.allowWebNativeTools, true);
      assert.equal(input.execution?.contextWindow, 111_193);
      assert.equal(input.execution?.browserMessageTokenLimit, 103_000);
      assert.equal(input.execution?.browserComposerCharLimit, 500_000);
      assert.equal(input.execution?.budgetProfile, "bridge-chatgpt-pro-v1");
      return "Full reply";
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
        metadata: { thread_id: "profile", turn_id: "profile-turn" },
        input: "Hello",
        stream: false,
      }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Full reply/u);
  } finally {
    await gateway.close();
  }
});

it("preserves synchronized browser context limits as client errors in JSON and SSE", async () => {
  const { FullTurnBroker } = await import("./full-turn-broker.js");
  const gateway = new ResponsesGateway({
    port: 0,
    accountContextProfile: () => "pro",
    fullMcp: {
      broker: new FullTurnBroker(),
      enabled: () => true,
      connectorName: () => "Bridge",
    },
    runWebTurn: async () => {
      throw Object.assign(
        new Error(
          "Synchronized context exceeds its limit. No prompt was submitted.",
        ),
        {
          code: "bridge_context_limit_exceeded",
        },
      );
    },
  });
  try {
    const address = await gateway.start();
    for (const stream of [false, true]) {
      const response = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codexgpt-bridge/high",
          input: "Test synchronized preflight",
          stream,
          metadata: {
            thread_id: `context-limit-${stream}`,
            turn_id: `context-limit-${stream}`,
          },
        }),
      });
      let failure: { type: string; code: string; message: string };
      if (stream) {
        assert.equal(response.status, 200);
        const events = (await response.text())
          .split(/\r?\n/)
          .filter(
            (line) => line.startsWith("data: ") && !line.includes("[DONE]"),
          )
          .map((line) => JSON.parse(line.slice(6)));
        const failed = events.find((event) => event.type === "response.failed");
        assert.ok(failed, JSON.stringify(events));
        failure = failed.response.error;
      } else {
        assert.equal(response.status, 400);
        failure = ((await response.json()) as { error: typeof failure }).error;
      }
      assert.equal(failure.code, "bridge_context_limit_exceeded");
      assert.equal(failure.type, "invalid_request_error");
      assert.match(failure.message, /No prompt was submitted/);
    }
  } finally {
    await gateway.close();
  }
});
