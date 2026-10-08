import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { resolveCodexProjectName } from "./codex-projects.js";

it("uses actual sidebar names and thread assignments, including worktrees and projectless tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-project-registry-"));
  const file = join(dir, "state_5.sqlite");
  try {
    const db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE projects(id TEXT, name TEXT); CREATE TABLE project_roots(project_id TEXT, path TEXT); CREATE TABLE threads(id TEXT, project_id TEXT);",
    );
    db.prepare("INSERT INTO projects VALUES (?, ?)").run(
      "one",
      "側邊欄自訂名稱",
    );
    db.prepare("INSERT INTO projects VALUES (?, ?)").run("two", "Nested");
    db.prepare("INSERT INTO project_roots VALUES (?, ?)").run(
      "one",
      "C:/Code/bridge",
    );
    db.prepare("INSERT INTO project_roots VALUES (?, ?)").run(
      "two",
      "C:/Code/bridge/nested",
    );
    db.prepare("INSERT INTO threads VALUES (?, ?)").run("worktree", "one");
    db.prepare("INSERT INTO threads VALUES (?, ?)").run("projectless", null);
    db.close();
    assert.equal(
      await resolveCodexProjectName(dir, {
        threadId: "worktree",
        cwd: "C:/worktrees/abc",
      }),
      "側邊欄自訂名稱",
    );
    assert.equal(
      await resolveCodexProjectName(dir, {
        threadId: "projectless",
        cwd: "C:/Code/bridge",
      }),
      undefined,
    );
    assert.equal(
      await resolveCodexProjectName(dir, { cwd: "c:\\CODE\\Bridge\\src" }),
      "側邊欄自訂名稱",
    );
    assert.equal(
      await resolveCodexProjectName(dir, { cwd: "C:/Code/bridge/nested/src" }),
      "Nested",
    );
    assert.equal(
      await resolveCodexProjectName(dir, { cwd: "C:/Code/bridge-other" }),
      undefined,
    );
    assert.equal(await resolveCodexProjectName(dir, {}), undefined);
    // Re-read on each new task; do not cache stale names across renames.
    const update = new DatabaseSync(file);
    update
      .prepare("UPDATE projects SET name = ? WHERE id = ?")
      .run("Renamed", "one");
    update.close();
    assert.equal(
      await resolveCodexProjectName(dir, { threadId: "worktree" }),
      "Renamed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("supports legacy registries and refuses ambiguous roots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-project-legacy-"));
  try {
    assert.equal(
      await resolveCodexProjectName(dir, { cwd: "C:/unknown" }),
      undefined,
    );
    await writeFile(
      join(dir, ".codex-global-state.json"),
      JSON.stringify({
        "local-projects": {
          one: { name: "Legacy", rootPaths: ["C:/code"] },
          two: { name: "Duplicate", rootPaths: ["C:/code"] },
        },
        "thread-project-assignments": {
          worktree: { projectKind: "local", projectId: "one" },
        },
        "projectless-thread-ids": ["loose"],
      }),
    );
    assert.equal(
      await resolveCodexProjectName(dir, {
        threadId: "worktree",
        cwd: "C:/worktree",
      }),
      "Legacy",
    );
    assert.equal(
      await resolveCodexProjectName(dir, { threadId: "loose", cwd: "C:/code" }),
      undefined,
    );
    await assert.rejects(
      resolveCodexProjectName(dir, { cwd: "C:/code" }),
      /多個 Codex 專案/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("resolves sidebar-owned tasks when SQLite has migrated tables but a NULL project_id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-project-mixed-"));
  try {
    const db = new DatabaseSync(join(dir, "state_5.sqlite"));
    db.exec(
      "CREATE TABLE projects(id TEXT, name TEXT); CREATE TABLE project_roots(project_id TEXT, path TEXT); CREATE TABLE threads(id TEXT, project_id TEXT);",
    );
    db.prepare("INSERT INTO projects VALUES (?, ?)").run(
      "native",
      "Native name",
    );
    db.prepare("INSERT INTO project_roots VALUES (?, ?)").run(
      "native",
      "C:/Code/bridge",
    );
    for (const id of ["mixed", "worktree", "loose", "unassigned", "broken"])
      db.prepare("INSERT INTO threads VALUES (?, ?)").run(id, null);
    db.prepare("INSERT INTO threads VALUES (?, ?)").run(
      "native-assigned",
      "native",
    );
    db.close();
    await writeFile(
      join(dir, ".codex-global-state.json"),
      JSON.stringify({
        "local-projects": {
          legacy: { name: "Legacy project", rootPaths: ["C:/Code/bridge"] },
        },
        "thread-project-assignments": {
          mixed: { projectKind: "local", projectId: "legacy" },
          worktree: { projectKind: "local", projectId: "legacy" },
          "native-assigned": { projectKind: "local", projectId: "legacy" },
          broken: { projectKind: "local", projectId: "missing" },
        },
        "projectless-thread-ids": ["loose"],
      }),
    );
    assert.equal(
      await resolveCodexProjectName(dir, {
        threadId: "mixed",
        cwd: "\\\\?\\C:\\Code\\bridge",
      }),
      "Legacy project",
    );
    assert.equal(
      await resolveCodexProjectName(dir, { threadId: "mixed" }),
      "Legacy project",
    );
    assert.equal(
      await resolveCodexProjectName(dir, {
        threadId: "worktree",
        cwd: "C:/unrelated-worktree",
      }),
      "Legacy project",
    );
    assert.equal(
      await resolveCodexProjectName(dir, {
        threadId: "loose",
        cwd: "C:/Code/bridge",
      }),
      undefined,
    );
    assert.equal(
      await resolveCodexProjectName(dir, {
        threadId: "unassigned",
        cwd: "C:/Code/bridge",
      }),
      undefined,
    );
    assert.equal(
      await resolveCodexProjectName(dir, { threadId: "native-assigned" }),
      "Native name",
    );
    assert.equal(
      await resolveCodexProjectName(dir, {
        cwd: "\\\\?\\C:\\Code\\bridge\\src",
      }),
      "Native name",
    );
    await assert.rejects(
      resolveCodexProjectName(dir, { threadId: "broken" }),
      /專案名稱無效/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("checks exact sidebar ownership for tasks not yet present in SQLite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-project-new-"));
  try {
    const db = new DatabaseSync(join(dir, "state_5.sqlite"));
    db.exec(
      "CREATE TABLE projects(id TEXT, name TEXT); CREATE TABLE project_roots(project_id TEXT, path TEXT); CREATE TABLE threads(id TEXT, project_id TEXT);",
    );
    db.close();
    await writeFile(
      join(dir, ".codex-global-state.json"),
      JSON.stringify({
        "local-projects": {
          legacy: { name: "Worktree owner", rootPaths: ["C:/source"] },
        },
        "thread-project-assignments": {
          fresh: { projectKind: "local", projectId: "legacy" },
        },
      }),
    );
    assert.equal(
      await resolveCodexProjectName(dir, {
        threadId: "fresh",
        cwd: "C:/worktree",
      }),
      "Worktree owner",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
