import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverCodexCliExecutables } from "./codex-cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Codex CLI discovery", () => {
  it("prefers the explicitly supplied Desktop CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexgpt-cli-"));
    temporaryDirectories.push(root);
    const explicit = join(root, "current", "codex.exe");
    const installed = join(root, "OpenAI", "Codex", "bin", "old", "codex.exe");
    await mkdir(join(root, "OpenAI", "Codex", "bin", "old"), {
      recursive: true,
    });
    await writeFile(installed, "old");

    const candidates = await discoverCodexCliExecutables({
      env: { CODEX_CLI_PATH: explicit, LOCALAPPDATA: root },
      platform: "win32",
    });

    assert.deepEqual(candidates, [resolve(explicit), installed]);
  });

  it("orders Desktop-managed binaries from newest to oldest", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexgpt-cli-"));
    temporaryDirectories.push(root);
    const binRoot = join(root, "OpenAI", "Codex", "bin");
    const older = join(binRoot, "older", "codex.exe");
    const newer = join(binRoot, "newer", "codex.exe");
    await mkdir(join(binRoot, "older"), { recursive: true });
    await mkdir(join(binRoot, "newer"), { recursive: true });
    await writeFile(older, "old");
    await writeFile(newer, "new");
    await utimes(older, new Date(1_000), new Date(1_000));
    await utimes(newer, new Date(2_000), new Date(2_000));

    const candidates = await discoverCodexCliExecutables({
      env: { LOCALAPPDATA: root },
      platform: "win32",
    });

    assert.deepEqual(candidates, [newer, older]);
  });
});
