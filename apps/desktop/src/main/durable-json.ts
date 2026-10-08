import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Callers serialize writes. Flush the new state and retain the previous valid JSON. */
export async function writeDurableJson(
  file: string,
  text: string,
): Promise<void> {
  JSON.parse(text);
  await mkdir(dirname(file), { recursive: true });
  let previous: string | undefined;
  try {
    previous = await readFile(file, "utf8");
    JSON.parse(previous);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  const backup = `${file}.previous`;
  const backupTemporary = `${backup}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    if (previous !== undefined) {
      await writeFile(backupTemporary, previous, {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      await rename(backupTemporary, backup);
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
    await rm(backupTemporary, { force: true });
  }
}
