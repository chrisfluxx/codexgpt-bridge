import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Sidebar names override SQLite's initial-prompt title. Never writes Codex state. */
export async function readCodexThreadTitle(
  codexHome: string,
  threadId: string,
): Promise<string | undefined> {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(threadId)) return undefined;
  const index = join(codexHome, "session_index.jsonl");
  try {
    if ((await stat(index)).size > 32_000_000)
      throw new Error("Codex 標題索引過大，已略過名稱同步。");
    let title: unknown;
    let found = false;
    for (const line of (await readFile(index, "utf8")).split(/\r?\n/)) {
      if (!line.includes(threadId)) continue;
      try {
        const entry = JSON.parse(line) as {
          id?: unknown;
          thread_name?: unknown;
        };
        if (entry.id === threadId) {
          title = entry.thread_name;
          found = true;
        }
      } catch {
        // Appends can be observed mid-write; don't treat a partial line as a name.
      }
    }
    if (found) return typeof title === "string" ? title : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const files = await readdir(codexHome).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const file = files
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))[0];
  if (!file) return undefined;
  const db = new DatabaseSync(join(codexHome, file), { readOnly: true });
  try {
    if (
      !db
        .prepare("PRAGMA table_info(threads)")
        .all()
        .some((column) => column.name === "title")
    )
      return undefined;
    const row = db
      .prepare("SELECT title FROM threads WHERE id = ?")
      .get(threadId);
    return typeof row?.title === "string" ? row.title : undefined;
  } finally {
    db.close();
  }
}
