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

it("lists four proven models while retaining hidden legacy and experimental IDs across refresh", () => {
  const modes: BridgeWebMode[] = [
    "instant",
    "medium",
    "high",
    "extra-high",
    "pro",
  ];
  const first = buildStartupModelsPayload(catalog, modes, "pro", [
    "5.6",
    "6",
  ]) as { models: Array<Record<string, unknown>> };
  for (const payload of [
    first,
    buildStartupModelsPayload(first, modes, "pro"),
    buildWebOnlyModelsPayload(first, modes, "pro"),
  ]) {
    const rows = (payload as typeof first).models.filter((row) =>
      String(row.slug).startsWith("codexgpt-bridge/"),
    );
    assert.equal(rows.length, 13);
    assert.deepEqual(
      rows
        .filter((row) => row.visibility === "list")
        .map((row) => row.slug)
        .sort(),
      [
        "codexgpt-bridge/gpt-5.6-sol",
        "codexgpt-bridge/gpt-5.6-sol-pro",
        "codexgpt-bridge/gpt-6-pro",
        "codexgpt-bridge/gpt-6-sol",
      ],
    );
    assert.equal(
      rows.find((row) => row.slug === "codexgpt-bridge/high")?.visibility,
      "hide",
    );
    assert.equal(
      rows.find((row) => row.slug === "codexgpt-bridge/gpt-6-sol-3x")
        ?.visibility,
      "hide",
    );
  }
  assert.deepEqual(first.models[0], native);
  const limited = buildStartupModelsPayload(catalog, ["high"], "pro", [
    "6",
  ]) as typeof first;
  assert.deepEqual(
    limited.models
      .filter(
        (row) =>
          String(row.slug).startsWith("codexgpt-bridge/") &&
          row.visibility === "list",
      )
      .map((row) => row.slug),
    ["codexgpt-bridge/gpt-6-sol"],
  );
});

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

it("exposes separately verified GPT-5.6 and GPT-6 Sol routes with equal-budget efforts", () => {
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
    standard.find((row) => row.slug === "codexgpt-bridge/gpt-6-sol")
      ?.supportedEfforts,
    ["medium", "high", "xhigh"],
  );
  assert.deepEqual(
    standard.find((row) => row.slug === "codexgpt-bridge/gpt-6-sol-instant")
      ?.supportedEfforts,
    ["low"],
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
  assert.deepEqual(
    pro.find((row) => row.slug === "codexgpt-bridge/gpt-6-sol")
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
  assert.ok(pro.some((row) => row.slug === "codexgpt-bridge/gpt-6-sol-3x"));
  const simple = availableNativeModelRoutes(
    allModes,
    "pro",
    ["5.6", "6"],
    "simple",
  );
  assert.ok(simple.some((row) => row.slug === "codexgpt-bridge/gpt-6-sol"));
  assert.ok(simple.some((row) => row.slug === "codexgpt-bridge/gpt-5.6-sol"));
  assert.ok(simple.some((row) => row.slug === "codexgpt-bridge/gpt-6-pro"));
  assert.equal(
    simple.some(
      (row) =>
        row.contextMultiplier || row.slug === "codexgpt-bridge/luna-native",
    ),
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
  const sol6 = first.models.find(
    (row) => row.slug === "codexgpt-bridge/gpt-6-sol",
  )!;
  assert.deepEqual(
    (sol6.supported_reasoning_levels as Array<{ effort: string }>).map(
      (row) => row.effort,
    ),
    ["low", "medium", "high", "xhigh"],
  );
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
  const simpleCatalog = buildStartupModelsPayload(
    catalog,
    allModes,
    "pro",
    ["5.6", "6"],
    "simple",
  ) as typeof first;
  assert.ok(
    simpleCatalog.models.some(
      (row) => row.slug === "codexgpt-bridge/gpt-6-sol",
    ),
  );
  assert.ok(
    simpleCatalog.models.some(
      (row) => row.slug === "codexgpt-bridge/gpt-5.6-sol",
    ),
  );
  assert.equal(
    simpleCatalog.models.some((row) => String(row.slug).endsWith("-3x")),
    false,
  );
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
    for (const [effort, mode] of [
      ["low", "instant"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "extra-high"],
    ]) {
      const response = await post(
        "codexgpt-bridge/gpt-6-sol",
        effort,
        `six-${effort}`,
      );
      assert.equal(response.status, 200, await response.text());
      assert.deepEqual(sent.at(-1), { mode, family: "bridge-native:6" });
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
    assert.equal(sent.length, 10);
    const changed = await post("codexgpt-bridge/gpt-5.6-sol", "medium", "high");
    assert.equal(changed.status, 500);
    assert.match(
      await changed.text(),
      /cannot change its model family or reasoning effort/,
    );
    assert.equal(sent.length, 10);
  } finally {
    await gateway.close();
  }
});

it("runs explicit GPT-5.6 and GPT-6 Web routes in Simple without Full MCP", async () => {
  const observed: Array<{
    family: string | undefined;
    transport: string | undefined;
  }> = [];
  const gateway = new ResponsesGateway({
    port: 0,
    availableWebModes: () => allModes,
    accountContextProfile: () => "pro",
    nativeModelFamilies: () => ["5.6", "6"],
    runWebTurn: async (input) => {
      observed.push({
        family: input.modelFamily,
        transport: input.execution?.toolTransport,
      });
      return "Simple response";
    },
  });
  try {
    const address = await gateway.start();
    for (const [version, model] of [
      ["5.6", "gpt-5.6-sol"],
      ["6", "gpt-6-sol"],
    ]) {
      const response = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: `codexgpt-bridge/${model}`,
          reasoning: { effort: "high" },
          input: "test",
          metadata: {
            thread_id: `simple-${version}`,
            turn_id: `simple-turn-${version}`,
          },
        }),
      });
      assert.equal(response.status, 200, await response.text());
    }
    assert.deepEqual(
      observed.map(({ family }) => family),
      ["bridge-native:5.6", "bridge-native:6"],
    );
    assert.ok(observed.every(({ transport }) => transport !== "full"));
    const staged = await fetch(`${address.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codexgpt-bridge/gpt-6-sol-3x",
        input: "test",
      }),
    });
    assert.notEqual(staged.status, 200);
  } finally {
    await gateway.close();
  }
});
