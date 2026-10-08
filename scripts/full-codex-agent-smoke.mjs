import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { setTimeout, clearTimeout } from "node:timers";
import {
  brotliDecompressSync,
  gunzipSync,
  zstdDecompressSync,
} from "node:zlib";
import {
  ResponsesGateway,
  buildStartupModelsPayload,
} from "../packages/responses-gateway/dist/responses-server.js";
import { FullTurnBroker } from "../packages/responses-gateway/dist/full-turn-broker.js";
import { FullNativeRegistry } from "../packages/responses-gateway/dist/full-native-registry.js";
import { inspectNativeAgentResult } from "../packages/responses-gateway/dist/full-native-agent-audit.js";

// All model responses are local fixtures. No real model provider or account is contacted.
const executable = process.argv[2];
assert.ok(
  executable && isAbsolute(executable),
  "Pass an absolute Codex executable.",
);
const protocol = process.argv.includes("--v1") ? "v1" : "v2";
const agentCount = process.argv.includes("--five") ? 5 : 2;
const parallel = process.argv.includes("--parallel");
const followup = process.argv.includes("--followup");
const failFirst = process.argv.includes("--fail-first");
const capacity = process.argv.includes("--capacity");
assert.ok(
  !capacity || (agentCount === 5 && !parallel && !followup && !failFirst),
  "Capacity smoke requires --five and uses a separate case.",
);
assert.ok(
  !failFirst || (!parallel && !followup),
  "Failure replacement is a separate smoke case.",
);
const directory = await mkdtemp(join(tmpdir(), "bridge-full-codex-agents-"));
const codexHome = join(directory, "home");
const workspace = join(directory, "workspace");
const env = {
  ...process.env,
  CODEX_HOME: codexHome,
  BRIDGE_SMOKE_KEY: "local-fixture-only",
};
const broker = new FullTurnBroker();
const native = new FullNativeRegistry(broker);
const models = [];
const toolResults = [];
let rootToken;
let verifiedCompleted = 0;
let child;
let timer;
let gateway;
let releaseChildren;
const allChildrenStarted = new Promise((done) => {
  releaseChildren = done;
});
let activeChildren = 0,
  maximumChildren = 0;

async function releaseCapacityChildren() {
  for (let poll = 0; poll < 100 && models.length < 2; poll++)
    await new Promise((done) => setTimeout(done, 50));
  assert.equal(
    models.length,
    2,
    "Both active child requests must reach the barrier.",
  );
  releaseChildren();
}

function bodyOf(options) {
  const raw = Buffer.from(options.body);
  const encoding = new globalThis.Headers(options.headers).get(
    "content-encoding",
  );
  const bytes =
    encoding === "zstd"
      ? zstdDecompressSync(raw)
      : encoding === "gzip"
        ? gunzipSync(raw)
        : encoding === "br"
          ? brotliDecompressSync(raw)
          : raw;
  return JSON.parse(bytes.toString("utf8"));
}

function finalResponse(model, text) {
  const item = {
    type: "message",
    id: "msg_fixture",
    role: "assistant",
    phase: "final_answer",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const response = {
    id: "resp_fixture",
    object: "response",
    created_at: 1,
    model,
    status: "completed",
    end_turn: true,
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const events = [
    [
      "response.created",
      { response: { ...response, status: "in_progress", output: [] } },
    ],
    [
      "response.output_item.added",
      {
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
    ],
    [
      "response.content_part.added",
      {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
    ],
    [
      "response.output_text.delta",
      { item_id: item.id, output_index: 0, content_index: 0, delta: text },
    ],
    [
      "response.output_text.done",
      { item_id: item.id, output_index: 0, content_index: 0, text },
    ],
    ["response.output_item.done", { output_index: 0, item }],
    ["response.completed", { response }],
  ]
    .map(
      ([type, value], index) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: index, ...value })}\n\n`,
    )
    .join("");
  return new globalThis.Response(events, {
    headers: { "content-type": "text/event-stream" },
  });
}

try {
  await mkdir(codexHome);
  await mkdir(workspace);
  const { stdout: bundled } = await promisify(execFile)(
    executable,
    ["debug", "models", "--bundled"],
    { env, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
  );
  const catalog = buildStartupModelsPayload(JSON.parse(bundled));
  assert.ok(
    catalog.models.some((row) => row.slug === "gpt-6.1-sol"),
    "CLI must have a native 6.1 catalog row.",
  );
  for (const row of catalog.models)
    if (row.slug.startsWith("codexgpt-bridge/"))
      row.multi_agent_version = protocol;
  const catalogPath = join(directory, "models.json");
  await writeFile(catalogPath, JSON.stringify(catalog));
  gateway = new ResponsesGateway({
    port: 0,
    upstreamBaseUrl: "http://127.0.0.1:1/fixture-native/v1",
    fullMcp: {
      broker,
      enabled: () => true,
      connectorName: () => "Local fixture",
    },
    fetchImpl: async (url, options) => {
      assert.equal(
        new globalThis.URL(url).hostname,
        "127.0.0.1",
        "Fixture must never contact a real provider.",
      );
      if (!String(url).includes("responses"))
        return globalThis.Response.json(JSON.parse(bundled));
      const body = bodyOf(options);
      assert.equal(body.model, "gpt-6.1-sol");
      models.push({ model: body.model, effort: body.reasoning?.effort });
      if (failFirst && models.length === 1)
        return new globalThis.Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              message: "LOCAL_CHILD_FAILURE",
              code: "fixture_child_failure",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      activeChildren++;
      maximumChildren = Math.max(maximumChildren, activeChildren);
      if (parallel) {
        if (models.length === agentCount) releaseChildren();
        await allChildrenStarted;
      }
      if (capacity && models.length <= 2) await allChildrenStarted;
      activeChildren--;
      return finalResponse(body.model, "LOCAL_CHILD_OK");
    },
    runWebTurn: async (input) => {
      rootToken = /turn_[A-Za-z0-9_-]{40,}/u.exec(input.contract)[0];
      const inventory = await native.inventory(rootToken);
      const outerSpawn = inventory.tools.find((tool) =>
        /(?:multi_agent_v[12]|collaboration)__spawn_agent$/.test(tool.wireName),
      );
      const outerWait = inventory.tools.find((tool) =>
        /(?:multi_agent_v[12]|collaboration)__wait_agent$/.test(tool.wireName),
      );
      const listAgents = inventory.tools.find(
        (tool) => tool.wireName === "collaboration__list_agents",
      );
      if (outerSpawn?.kind !== "nested" && outerSpawn && outerWait) {
        if (capacity) {
          assert.ok(listAgents);
          for (let index = 0; index < 2; index++) {
            const spawned = await native.invoke(
              rootToken,
              outerSpawn.wireName,
              {
                arguments: {
                  task_name: `fixture_child_${index}`,
                  message: "LOCAL_CHILD fixture",
                  fork_turns: "none",
                  model: "gpt-6.1-sol",
                  reasoning_effort: "max",
                },
              },
            );
            toolResults.push(spawned);
          }
          const rejected = await native.invoke(rootToken, outerSpawn.wireName, {
            arguments: {
              task_name: "fixture_rejected",
              message: "LOCAL_CHILD fixture",
              fork_turns: "none",
              model: "gpt-6.1-sol",
              reasoning_effort: "max",
            },
          });
          toolResults.push(rejected);
          assert.match(
            JSON.stringify(rejected),
            /collab spawn failed: agent thread limit reached/u,
          );
          await releaseCapacityChildren();
          for (let poll = 0; poll < 30; poll++) {
            const listed = await native.invoke(rootToken, listAgents.wireName, {
              arguments: {},
            });
            toolResults.push(listed);
            if (broker.subagentsCompleted(rootToken) === 2) break;
            await new Promise((done) => setTimeout(done, 50));
          }
          assert.equal(broker.subagentsCompleted(rootToken), 2);
        }
        for (
          let index = capacity ? 2 : 0;
          index < agentCount + (failFirst ? 1 : 0);
          index++
        ) {
          const result = await native.invoke(rootToken, outerSpawn.wireName, {
            arguments:
              protocol === "v1"
                ? {
                    message: "LOCAL_CHILD fixture",
                    fork_context: false,
                    model: "gpt-6.1-sol",
                    reasoning_effort: "max",
                  }
                : {
                    task_name: `fixture_child_${index}`,
                    message: "LOCAL_CHILD fixture",
                    fork_turns: "none",
                    model: "gpt-6.1-sol",
                    reasoning_effort: "max",
                  },
          });
          toolResults.push(result);
          if (result.isError) throw new Error(JSON.stringify(result));
          const spawned =
            result.structuredContent ??
            JSON.parse(
              result.content.find((block) => block.type === "text").text,
            );
          if (parallel) continue;
          if (protocol === "v1") {
            const waited = await native.invoke(rootToken, outerWait.wireName, {
              arguments: { targets: [spawned.agent_id], timeout_ms: 30000 },
            });
            toolResults.push(waited);
            if (waited.isError) throw new Error(JSON.stringify(waited));
          } else {
            assert.ok(
              listAgents,
              "V2 completion requires its native list_agents tool.",
            );
            for (let poll = 0; poll < 20; poll++) {
              const listed = await native.invoke(
                rootToken,
                listAgents.wireName,
                { arguments: {} },
              );
              toolResults.push(listed);
              if (failFirst && index === 0) {
                if (
                  inspectNativeAgentResult(listed).failures.includes(
                    spawned.task_name,
                  )
                )
                  break;
              } else if (
                broker.subagentsCompleted(rootToken) ===
                index + 1 - (failFirst ? 1 : 0)
              )
                break;
              await new Promise((done) => setTimeout(done, 50));
            }
            assert.equal(
              broker.subagentsCompleted(rootToken),
              index + 1 - (failFirst ? 1 : 0),
              JSON.stringify(toolResults),
            );
            if (failFirst && index === 0) {
              const stop = inventory.tools.find(
                (tool) => tool.wireName === "collaboration__interrupt_agent",
              );
              assert.ok(stop);
              toolResults.push(
                await native.invoke(rootToken, stop.wireName, {
                  arguments: { target: spawned.task_name },
                }),
              );
            }
          }
        }
        if (parallel) {
          assert.ok(listAgents, "Parallel V2 needs native status discovery.");
          for (let poll = 0; poll < 30; poll++) {
            const listed = await native.invoke(rootToken, listAgents.wireName, {
              arguments: {},
            });
            toolResults.push(listed);
            if (broker.subagentsCompleted(rootToken) === agentCount) break;
            await new Promise((done) => setTimeout(done, 50));
          }
        }
        if (followup) {
          const followupTool = inventory.tools.find(
            (tool) => tool.wireName === "collaboration__followup_task",
          );
          assert.ok(followupTool);
          toolResults.push(
            await native.invoke(rootToken, followupTool.wireName, {
              arguments: {
                target: "fixture_child_0",
                message: "LOCAL_FOLLOWUP fixture",
              },
            }),
          );
          assert.equal(
            broker.subagentsCompleted(rootToken),
            agentCount - 1,
            "Accepted follow-up must invalidate the old completion.",
          );
          for (let poll = 0; poll < 30; poll++) {
            const listed = await native.invoke(rootToken, listAgents.wireName, {
              arguments: {},
            });
            toolResults.push(listed);
            if (broker.subagentsCompleted(rootToken) === agentCount) break;
            await new Promise((done) => setTimeout(done, 50));
          }
        }
        verifiedCompleted = broker.subagentsCompleted(rootToken);
        return "<codex_text>LOCAL_ROOT_OK</codex_text>";
      }
      const agentTools = JSON.stringify(inventory).match(
        /(?:multi_agent_v[12]|collaboration)__spawn_agent/u,
      );
      assert.ok(
        agentTools,
        "Actual native inventory must advertise an agent spawn.",
      );
      const gatewayTool = broker
        .inventory(rootToken)
        .tools.find((tool) => tool.kind === "custom" && tool.name === "exec");
      assert.ok(gatewayTool, "Code-mode gateway must be callable.");
      let initialAgentIds = [];
      if (capacity) {
        const rejected = await native.invoke(rootToken, gatewayTool.wireName, {
          input: `const spawn = ALL_TOOLS.find(tool => /multi_agent_v1__spawn_agent$/.test(tool.name));
            const args = {message:'LOCAL_CHILD fixture',fork_context:false,model:'gpt-6.1-sol',reasoning_effort:'max'};
            for (let index=0;index<2;index++) text(await tools[spawn.name](args));
            try { const result = await tools[spawn.name](args); text('CAPACITY_RETURN_'+typeof result); text(result); } catch (error) { text('CAPACITY_THROWN_'+typeof error); text(String(error)); }`,
        });
        toolResults.push(rejected);
        initialAgentIds = inspectNativeAgentResult(rejected).agentIds;
        assert.equal(initialAgentIds.length, 2, JSON.stringify(rejected));
        assert.match(JSON.stringify(rejected), /thread limit reached/u);
        await releaseCapacityChildren();
      }
      const code = `
        const spawn = ALL_TOOLS.find(tool => /(?:multi_agent_v[12]|collaboration)__spawn_agent$/.test(tool.name));
        const wait = ALL_TOOLS.find(tool => /(?:multi_agent_v[12]|collaboration)__wait_agent$/.test(tool.name));
        if (!spawn || !wait) throw new Error('Native agent tools unavailable: '+JSON.stringify(ALL_TOOLS.filter(tool => /agent|collaboration/.test(JSON.stringify(tool))).map(tool => ({name:tool.name,namespace:tool.namespace}))));
        const v1 = spawn.name.includes('multi_agent_v1');
        const ids = ${JSON.stringify(initialAgentIds)};
        const close = ALL_TOOLS.find(tool => /multi_agent_v1__close_agent$/.test(tool.name));
        for (const id of ids) {
          text(await tools[wait.name]({targets:[id],timeout_ms:30000}));
          if (!close) throw new Error('Native close tool unavailable');
          text(await tools[close.name]({target:id}));
        }
        for (let index=${capacity ? 2 : 0}; index<${agentCount + (failFirst ? 1 : 0)}; index++) {
          const args = v1 ? { message:'LOCAL_CHILD fixture', fork_context:false, model:'gpt-6.1-sol', reasoning_effort:'max' }
            : { task_name:'fixture_child_'+index, message:'LOCAL_CHILD fixture', fork_turns:'none', model:'gpt-6.1-sol', reasoning_effort:'max' };
          const result = await tools[spawn.name](args); text(result);
          ids.push(result.agent_id);
          if (!${parallel}) {
            const waited = await tools[wait.name](v1 ? { targets:[result.agent_id], timeout_ms:30000 } : { timeout_ms:30000 }); text(waited);
            if (${failFirst} && index === 0) {
              if (!waited.status?.[result.agent_id]?.errored) throw new Error('Expected owned terminal child failure');
              const close = ALL_TOOLS.find(tool => /multi_agent_v1__close_agent$/.test(tool.name));
              if (!close) throw new Error('Native close tool unavailable');
              text(await tools[close.name]({target:result.agent_id}));
            }
            if (${capacity}) {
              if (!close) throw new Error('Native close tool unavailable');
              text(await tools[close.name]({target:result.agent_id}));
            }
          }
        }
        if (${parallel}) {
          let pending = ids;
          for (let poll=0; poll<10 && pending.length; poll++) {
            const result = await tools[wait.name]({ targets:pending, timeout_ms:30000 }); text(result);
            pending = pending.filter(id => result.status?.[id]?.completed === undefined);
          }
        }
        if (${followup}) {
          const resume = ALL_TOOLS.find(tool => /multi_agent_v1__send_input$/.test(tool.name));
          if (!resume) throw new Error('Native follow-up tool unavailable');
          text(await tools[resume.name]({target:ids[0],message:'LOCAL_FOLLOWUP fixture',interrupt:true}));
          text(await tools[wait.name]({targets:[ids[0]],timeout_ms:30000}));
        }`;
      const result = await native.invoke(rootToken, gatewayTool.wireName, {
        input: code,
      });
      toolResults.push(result);
      if (result.isError) throw new Error(JSON.stringify(result));
      verifiedCompleted = broker.subagentsCompleted(rootToken);
      return "<codex_text>LOCAL_ROOT_OK</codex_text>";
    },
  });
  const address = await gateway.start();
  await writeFile(
    join(codexHome, "config.toml"),
    [
      'model = "codexgpt-bridge/high"',
      'model_provider = "bridge_fixture"',
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      "[model_providers.bridge_fixture]",
      'name = "Isolated Full agent fixture"',
      `base_url = "${address.baseUrl}"`,
      'env_key = "BRIDGE_SMOKE_KEY"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "[agents]",
      "max_depth = 2",
      `max_threads = ${capacity ? 2 : agentCount + 1}`,
      "[features]",
      "multi_agent = true",
      "plugins = false",
      "remote_plugin = false",
      `multi_agent_v2 = ${protocol === "v2"}`,
      "",
    ].join("\n"),
  );
  child = spawn(
    executable,
    [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-C",
      workspace,
      `Spawn ${agentCount} child agents for the LOCAL_ROOT fixture.`,
    ],
    {
      env,
      cwd: workspace,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = (stdout + chunk).slice(-20000);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-10000);
  });
  const exit = await new Promise((done, reject) => {
    timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `Native fixture timeout: ${stderr}\nModels:${JSON.stringify(models)}\nResults:${JSON.stringify(toolResults)}\nCLI:${stdout}`,
        ),
      );
    }, 45000);
    child.once("error", reject);
    child.once("close", done);
  });
  assert.equal(exit, 0, `${stderr}\n${stdout}\n${JSON.stringify(toolResults)}`);
  assert.match(stdout, /LOCAL_ROOT_OK/u);
  assert.equal(
    models.length,
    agentCount + (followup ? 1 : 0) + (failFirst ? 1 : 0),
    JSON.stringify(models),
  );
  assert.ok(models.every((row) => row.effort === "max"));
  if (parallel) assert.equal(maximumChildren, agentCount);
  if (capacity) assert.equal(maximumChildren, 2);
  assert.equal(verifiedCompleted, agentCount, JSON.stringify(toolResults));
  process.stdout.write(
    `FULL_CODEX_${protocol.toUpperCase()}_AGENTS_OK ${JSON.stringify({ models, completed: verifiedCompleted, maximumChildren, nativeResults: toolResults })}\n`,
  );
} finally {
  clearTimeout(timer);
  releaseChildren();
  if (child && child.exitCode === null) child.kill();
  native.close();
  await gateway?.close();
  broker.close();
  const cleanupPath = resolve(directory);
  const withinTemp = relative(resolve(tmpdir()), cleanupPath);
  assert.ok(
    withinTemp &&
      !isAbsolute(withinTemp) &&
      withinTemp !== ".." &&
      !withinTemp.startsWith(`..${sep}`) &&
      cleanupPath === directory,
  );
  await rm(cleanupPath, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
