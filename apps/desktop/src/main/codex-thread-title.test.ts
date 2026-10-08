import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { readCodexThreadTitle } from "./codex-thread-title.js";

it("uses the exact sidebar name over SQLite prompt text, follows renames and never mutates state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-title-"));
  try {
    const db = new DatabaseSync(join(dir, "state_5.sqlite"));
    db.exec("CREATE TABLE threads(id TEXT, title TEXT)");
    db.prepare("INSERT INTO threads VALUES (?,?)").run("task-one", "test");
    db.prepare("INSERT INTO threads VALUES (?,?)").run(
      "task-two",
      "Other title",
    );
    db.close();
    assert.equal(await readCodexThreadTitle(dir, "task-one"), "test");
    const index = join(dir, "session_index.jsonl");
    await writeFile(
      index,
      JSON.stringify({ id: "task-one", thread_name: "Test" }) + "\n",
    );
    assert.equal(await readCodexThreadTitle(dir, "task-one"), "Test");
    await appendFile(
      index,
      JSON.stringify({ id: "task-one", thread_name: "新版 中文 🚀 <x>" }) +
        "\n" +
        '{"id":"task-one"',
    );
    const before = await readFile(index, "utf8");
    assert.equal(
      await readCodexThreadTitle(dir, "task-one"),
      "新版 中文 🚀 <x>",
    );
    assert.equal(await readCodexThreadTitle(dir, "task-two"), "Other title");
    assert.equal(await readCodexThreadTitle(dir, "unknown"), undefined);
    assert.equal(await readFile(index, "utf8"), before);
    assert.equal(await readCodexThreadTitle(dir, "../bad"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("skips missing/unsupported registries and does not guess a title", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-title-missing-"));
  try {
    assert.equal(await readCodexThreadTitle(dir, "task-one"), undefined);
    const db = new DatabaseSync(join(dir, "state_5.sqlite"));
    db.exec("CREATE TABLE threads(id TEXT)");
    db.close();
    assert.equal(await readCodexThreadTitle(dir, "task-one"), undefined);
    await writeFile(
      join(dir, "session_index.jsonl"),
      JSON.stringify({ id: "task-one", thread_name: "" }) + "\n",
    );
    assert.equal(await readCodexThreadTitle(dir, "task-one"), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
