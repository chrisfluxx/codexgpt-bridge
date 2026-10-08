import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  WebOnlyIntegration,
  planWebOnlyConfig,
  restoreWebOnlyConfig,
} from "./web-only-integration.js";

const token = "ab".repeat(32);
const baseUrl = "http://127.0.0.1:7767/web/v1";
const plan = (text: string) =>
  planWebOnlyConfig(text, baseUrl, "C:/fixture/models.json", token);

it("refreshes owned model budgets without changing config, credentials or restore ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-web-only-budget-"));
  try {
    const original = 'model = "native"\n# original settings\n';
    await writeFile(join(directory, "config.toml"), original);
    const integration = new WebOnlyIntegration(directory, directory);
    await integration.enable(baseUrl, {
      models: [
        {
          slug: "codexgpt-bridge/high",
          context_window: 95_000,
          base_instructions: "Preserve instructions",
        },
      ],
    });
    const installed = await readFile(integration.configPath, "utf8");
    const credential = await integration.token();
    const updated = {
      models: [
        {
          slug: "codexgpt-bridge/high",
          context_window: 111_193,
          auto_compact_token_limit: 95_000,
          base_instructions: "Preserve instructions",
        },
      ],
    };
    assert.equal(await integration.refreshModels(() => updated), true);
    assert.equal(await integration.refreshModels(() => updated), false);
    const restarted = new WebOnlyIntegration(directory, directory);
    assert.equal((await restarted.status()).enabled, true);
    assert.deepEqual(await restarted.models(), updated);
    assert.equal(await restarted.token(), credential);
    assert.equal(await readFile(restarted.configPath, "utf8"), installed);
    await restarted.disable();
    assert.equal(await readFile(restarted.configPath, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not overwrite a concurrent user catalog change during an owned refresh", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "bridge-web-only-budget-race-"),
  );
  try {
    const integration = new WebOnlyIntegration(directory, directory);
    await integration.enable(baseUrl, {
      models: [{ slug: "codexgpt-bridge/high" }],
    });
    const installed = await readFile(integration.configPath, "utf8");
    await assert.rejects(
      integration.refreshModels(async () => {
        await writeFile(integration.catalogPath, "User-modified catalog");
        return { models: [] };
      }),
      /changed during catalog refresh/u,
    );
    assert.equal(
      await readFile(integration.catalogPath, "utf8"),
      "User-modified catalog",
    );
    assert.equal(await readFile(integration.configPath, "utf8"), installed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("restores existing managed routes, model defaults, profiles and exact line endings", () => {
  for (const ending of ["\n", "\r\n"]) {
    const original = [
      "# >>> CodexGPT Bridge managed Web provider",
      'openai_base_url = "http://127.0.0.1:7767/v1"',
      'model_catalog_json = "C:/native/models.json" # original',
      "# <<< CodexGPT Bridge managed Web provider",
      '"model" = "gpt-native"',
      "model_provider = 'openai'",
      'model_reasoning_effort = "xhigh"',
      'service_tier = "fast"',
      'profile = "my-profile"',
      "[mcp_servers.example]",
      'command = "unchanged"',
    ].join(ending);
    const result = plan(original);
    assert.match(result.installed, /requires_openai_auth = false/u);
    assert.match(result.installed, /model_provider = "codexgpt_bridge_web"/u);
    assert.equal(restoreWebOnlyConfig(result.installed, result), original);
    const edited = result.installed.replace(
      'command = "unchanged"',
      'command = "user-edit"',
    );
    assert.equal(
      restoreWebOnlyConfig(edited, result),
      original.replace("unchanged", "user-edit"),
    );
    const selection = result.installed
      .replace(
        'model = "codexgpt-bridge/high"',
        'model = "codexgpt-bridge/pro"',
      )
      .replace(
        'model_reasoning_effort = "high"',
        'model_reasoning_effort = "ultra"',
      );
    assert.equal(restoreWebOnlyConfig(selection, result), original);
  }
});

it("does not overwrite conflicting settings or ambiguous TOML", () => {
  for (const source of [
    'model = "a"\nmodel = "b"\n',
    'model = ["a"]',
    'notes = """\n[not-a-table]\n"""\n',
    "[model_providers.codexgpt_bridge_web]\n",
  ]) {
    assert.throws(() => plan(source));
  }
  const result = plan('model = "native"\n');
  for (const changed of [
    result.installed.replace(
      "requires_openai_auth = false",
      "requires_openai_auth = true",
    ),
    result.installed.replace(
      'model = "codexgpt-bridge/high"',
      'model = "gpt-native"',
    ),
    result.installed.replace("# CodexGPT Bridge saved model\n", ""),
  ]) {
    assert.throws(() => restoreWebOnlyConfig(changed, result));
  }
});

it("persists a local credential and survives enable, restart, user edits and restore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-web-only-unit-"));
  try {
    const original = 'model = "native"\n';
    await writeFile(join(directory, "config.toml"), original);
    const integration = new WebOnlyIntegration(
      directory,
      directory,
      "bridge interrupt hook",
    );
    const catalog = { models: [{ slug: "codexgpt-bridge/high" }] };
    await integration.enable(baseUrl, catalog);
    assert.equal((await integration.status()).enabled, true);
    const restarted = new WebOnlyIntegration(
      directory,
      directory,
      "bridge interrupt hook",
    );
    assert.equal(await restarted.token(), await integration.token());
    assert.deepEqual(await restarted.models(), catalog);
    await restarted.enable(baseUrl, catalog);
    assert.equal((await restarted.status()).enabled, true);
    const installed = await readFile(integration.configPath, "utf8");
    assert.match(installed, /CodexGPT Bridge managed Interrupt hook/u);
    await writeFile(
      integration.configPath,
      installed.replace(
        "# CodexGPT Bridge saved model\n",
        "# CodexGPT Bridge saved model\n# user comment\n",
      ),
    );
    await restarted.disable();
    assert.equal(
      await readFile(integration.configPath, "utf8"),
      original + "# user comment\n",
    );
    assert.deepEqual(await restarted.status(), {
      enabled: false,
      managed: false,
    });
    assert.equal(await restarted.token(), await integration.token());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("restores a fresh config to absence and does not delete modified catalogs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-web-only-fresh-"));
  try {
    const integration = new WebOnlyIntegration(directory, directory);
    await integration.enable(baseUrl, { models: [] });
    await writeFile(integration.catalogPath, "user-edited catalog");
    assert.equal((await integration.status()).enabled, false);
    await integration.disable();
    await assert.rejects(readFile(integration.configPath), { code: "ENOENT" });
    assert.equal(
      await readFile(integration.catalogPath, "utf8"),
      "user-edited catalog",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
