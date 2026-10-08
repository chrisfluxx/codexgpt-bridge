import assert from "node:assert/strict";
import { it } from "node:test";
import {
  availableNativeModelRoutes,
  bridgeCatalogWebModes,
} from "./native-model-routes.js";
import {
  buildStartupModelsPayload,
  buildWebOnlyModelsPayload,
  ResponsesGateway,
  type BridgeWebMode,
} from "./responses-server.js";
import { FullTurnBroker } from "./full-turn-broker.js";

const allModes: BridgeWebMode[] = [
  "instant",
  "medium",
  "high",
  "extra-high",
  "pro",
  "luna",
  "think",
];
const native = {
  slug: "gpt-6.1-sol",
  base_instructions: "Preserve native instructions",
  supports_reasoning_summaries: false,
  supports_parallel_tool_calls: false,
  tool_mode: "function",
  multi_agent_version: "v2",
  context_window: 272_000,
};
const catalog = { models: [native] };

it("keeps native 6.1 intact and exposes Web 6.1 only after explicit browser proof", () => {
  const unproven = buildStartupModelsPayload(catalog, allModes, "pro", [
    "5.6",
    "6",
  ]) as { models: Array<Record<string, unknown>> };
  assert.deepEqual(unproven.models[0], native);
  assert.equal(
    unproven.models.some((row) =>
      String(row.slug).startsWith("codexgpt-bridge/gpt-6.1"),
    ),
    false,
  );
  const proven = availableNativeModelRoutes(allModes, "pro", ["6.1"]);
  assert.deepEqual(
    proven.find((row) => row.slug === "codexgpt-bridge/gpt-6.1-sol")
      ?.supportedEfforts,
    ["low", "medium", "high", "xhigh"],
  );
  assert.equal(
    proven.some((row) => row.slug.includes("6.1") && row.mode === "pro"),
    false,
  );
  assert.deepEqual(
    bridgeCatalogWebModes({
      models: [
        {
          slug: "codexgpt-bridge/gpt-6.1-sol",
          supported_reasoning_levels: [{ effort: "high" }],
        },
      ],
    }),
    ["high"],
  );
});

it("groups only equal-budget native efforts and never invents a GPT-6 Sol route", () => {
  const standard = availableNativeModelRoutes(allModes, "standard", [
    "5.6",
    "6",
  ]);
  assert.deepEqual(
    standard.find((row) => row.slug === "codexgpt-bridge/gpt-5.6-sol")
      ?.supportedEfforts,
    ["medium", "high", "xhigh"],
  );
  assert.deepEqual(
    standard.find((row) => row.slug.endsWith("-instant"))?.supportedEfforts,
    ["low"],
  );
  assert.equal(
    standard.some((row) => row.mode === "pro"),
    false,
  );
  const pro = availableNativeModelRoutes(allModes, "pro", ["5.6", "6"]);
  assert.deepEqual(
    pro.find((row) => row.slug === "codexgpt-bridge/gpt-5.6-sol")
      ?.supportedEfforts,
    ["low", "medium", "high", "xhigh"],
  );
  assert.equal(
    pro.some((row) => row.slug.endsWith("-instant")),
    false,
  );
  assert.equal(
    pro.filter((row) => row.mode === "pro" && !row.contextMultiplier).length,
    2,
  );
  assert.equal(
    pro.some((row) => /gpt-6-sol/.test(row.slug)),
    false,
  );
  assert.deepEqual(availableNativeModelRoutes(["high"], "pro", []), []);
  assert.deepEqual(
    availableNativeModelRoutes(["luna"], "standard", []).at(0)
      ?.supportedEfforts,
    ["low"],
  );
});

it("preserves native rows and compiled instructions through owned native/Web-only refresh", () => {
  const first = buildStartupModelsPayload(catalog, allModes, "pro", [
    "5.6",
    "6",
  ]) as { models: Array<Record<string, unknown>> };
  assert.deepEqual(first.models[0], native);
  const pro = first.models.find(
    (row) => row.slug === "codexgpt-bridge/gpt-6-pro",
  )!;
  assert.equal(pro.default_reasoning_level, "max");
  assert.equal(pro.tool_mode, null);
  assert.equal(pro.multi_agent_version, "v2");
  assert.equal(pro.context_window, 112_193);
  const web = buildWebOnlyModelsPayload(first, allModes, "pro") as typeof first;
  const reopened = buildWebOnlyModelsPayload(
    web,
    allModes,
    "standard",
  ) as typeof first;
  assert.equal(
    reopened.models.some((row) => row.slug === "codexgpt-bridge/gpt-6-pro"),
    false,
  );
  const sol = reopened.models.find(
    (row) => row.slug === "codexgpt-bridge/gpt-5.6-sol",
  )!;
  assert.equal(sol.base_instructions, native.base_instructions);
  assert.equal(sol.context_window, 90_000);
  assert.deepEqual(
    (sol.supported_reasoning_levels as Array<{ effort: string }>).map(
      (level) => level.effort,
    ),
    ["medium", "high", "xhigh"],
  );
  assert.deepEqual(catalog.models[0], native);
});

it("routes native Responses effort to the Full browser and rejects unavailable modes before Send", async () => {
  const broker = new FullTurnBroker();
  const sent: Array<{ mode: string; family: string | undefined }> = [];
  const gateway = new ResponsesGateway({
    port: 0,
    availableWebModes: () => allModes,
    accountContextProfile: () => "pro",
    nativeModelFamilies: () => ["5.6", "6", "6.1"],
    modelFamily: () => "GPT-5.5",
    fullMcp: { broker, enabled: () => true, connectorName: () => "Bridge" },
    runWebTurn: async (input) => {
      assert.equal(input.execution?.toolTransport, "full");
      assert.equal(input.allowWebNativeTools, true);
      sent.push({ mode: input.mode, family: input.modelFamily });
      return "Native Full reply";
    },
  });
  try {
    const address = await gateway.start();
    const post = (model: string, effort: unknown, turn: string) =>
      fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          reasoning: { effort },
          input: "hello",
          metadata: {
            thread_id: "native-full",
            turn_id: `native-turn-${turn}`,
          },
        }),
      });
    for (const [effort, mode] of [
      ["low", "instant"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "extra-high"],
    ]) {
      const response = await post(
        "codexgpt-bridge/gpt-5.6-sol",
        effort,
        effort!,
      );
      assert.equal(response.status, 200, await response.text());
      assert.deepEqual(sent.at(-1), { mode, family: "bridge-native:5.6" });
    }
    const response = await post("codexgpt-bridge/gpt-6-pro", "max", "pro");
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(sent.at(-1), { mode: "pro", family: "bridge-native:6" });
    const sol61 = await post("codexgpt-bridge/gpt-6.1-sol", "high", "sol61");
    assert.equal(sol61.status, 200, await sol61.text());
    assert.deepEqual(sent.at(-1), {
      mode: "high",
      family: "bridge-native:6.1",
    });
    const invalid61 = await post(
      "codexgpt-bridge/gpt-6.1-sol",
      "max",
      "sol61-max",
    );
    assert.equal(invalid61.status, 400);
    for (const effort of ["ultra", "medium", 4]) {
      const invalid = await post(
        "codexgpt-bridge/gpt-6-pro",
        effort,
        `bad-${effort}`,
      );
      assert.equal(invalid.status, 400);
      assert.equal(
        ((await invalid.json()) as { error: { code: string } }).error.code,
        "bridge_reasoning_effort_unavailable",
      );
    }
    assert.equal(sent.length, 6);
    const changed = await post("codexgpt-bridge/gpt-5.6-sol", "medium", "high");
    assert.equal(changed.status, 500);
    assert.match(
      await changed.text(),
      /cannot change its model family or reasoning effort/,
    );
    assert.equal(sent.length, 6);
  } finally {
    await gateway.close();
  }
});
