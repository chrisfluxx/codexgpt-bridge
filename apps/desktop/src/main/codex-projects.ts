import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeProjectPath } from "./chatgpt-projects.js";

interface ProjectRoot {
  id: string;
  name: string;
  path: string;
}

function projectName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    [...value].some((char) => char.charCodeAt(0) < 32)
  )
    throw new Error("Codex 專案名稱無效，尚未建立 ChatGPT Project。");
  return value.trim();
}

function fromRoots(roots: ProjectRoot[], cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const path = normalizeProjectPath(cwd);
  const matches = roots
    .flatMap((root) => {
      const normalized = normalizeProjectPath(root.path);
      const separator = /^[a-z]:|^\\\\/i.test(normalized) ? "\\" : "/";
      return path === normalized ||
        path.startsWith(
          normalized.endsWith(separator) ? normalized : normalized + separator,
        )
        ? [{ ...root, length: normalized.length }]
        : [];
    })
    .sort((a, b) => b.length - a.length);
  const best = matches[0];
  if (!best) return undefined;
  if (
    matches.some(
      (other) => other.length === best.length && other.id !== best.id,
    )
  )
    throw new Error(
      "同一路徑屬於多個 Codex 專案，無法安全判斷 ChatGPT Project。",
    );
  return projectName(best.name);
}

/** Read only the local sidebar registry, never infer a Project from a folder basename. */
export async function resolveCodexProjectName(
  codexHome: string,
  input: { readonly threadId?: string; readonly cwd?: string },
): Promise<string | undefined> {
  const files = await readdir(codexHome).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const database = files
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))[0];
  let nativeRoots: ProjectRoot[] | undefined;
  let nativeThreadFound = false;
  if (database) {
    const db = new DatabaseSync(join(codexHome, database), { readOnly: true });
    try {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('projects', 'project_roots')",
        )
        .all();
      if (tables.length === 2) {
        if (input.threadId) {
          const thread = db
            .prepare(
              "SELECT t.project_id, p.name FROM threads t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?",
            )
            .get(input.threadId);
          nativeThreadFound = thread !== undefined;
          if (thread && thread.project_id !== null)
            return projectName(thread.name);
          // During desktop migration, project_id can be NULL even when the
          // sidebar still owns an exact thread-project-assignment. Check that
          // registry before declaring this task projectless; do not guess by cwd.
        }
        nativeRoots = db
          .prepare(
            "SELECT p.id, p.name, r.path FROM projects p JOIN project_roots r ON r.project_id = p.id",
          )
          .all() as unknown as ProjectRoot[];
      }
    } finally {
      db.close();
    }
  }
  // Legacy and partially migrated desktops can keep task ownership here even
  // when the SQLite projects/project_roots tables already exist.
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(
      await readFile(join(codexHome, ".codex-global-state.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    state = {};
  }
  const projects = (state["local-projects"] ?? {}) as Record<
    string,
    { name: string; rootPaths: string[] }
  >;
  if (input.threadId) {
    const projectless = state["projectless-thread-ids"];
    if (Array.isArray(projectless) && projectless.includes(input.threadId))
      return undefined;
    const assignments = state["thread-project-assignments"] as
      Record<string, { projectKind: string; projectId: string }> | undefined;
    const assignment = assignments?.[input.threadId];
    if (assignment)
      return assignment.projectKind === "local"
        ? projectName(projects[assignment.projectId]?.name)
        : undefined;
  }
  // No exact sidebar assignment: preserve a known projectless task rather than
  // attaching it to a project merely because its cwd is inside that project.
  if (nativeThreadFound) return undefined;
  if (nativeRoots?.length) return fromRoots(nativeRoots, input.cwd);
  return fromRoots(
    Object.entries(projects).flatMap(([id, project]) =>
      project.rootPaths.map((path) => ({ id, name: project.name, path })),
    ),
    input.cwd,
  );
}
