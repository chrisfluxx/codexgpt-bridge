import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

interface CodexCliDiscoveryOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

interface CodexCliExecutable {
  readonly path: string;
  readonly modifiedAt: number;
}

export async function discoverCodexCliExecutables(
  options: CodexCliDiscoveryOptions = {},
): Promise<readonly string[]> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const discovered: string[] = [];
  const seen = new Set<string>();
  const add = (path: string): void => {
    const normalized = platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    discovered.push(path);
  };

  const explicit = env.CODEX_CLI_PATH?.trim();
  if (explicit) add(resolve(explicit));
  if (platform !== "win32") return discovered;

  const localAppData = env.LOCALAPPDATA?.trim();
  if (!localAppData) return discovered;
  const binRoot = join(localAppData, "OpenAI", "Codex", "bin");
  let entries;
  try {
    entries = await readdir(binRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return discovered;
    throw error;
  }

  const executables = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry): Promise<CodexCliExecutable | undefined> => {
          const path = join(binRoot, entry.name, "codex.exe");
          try {
            const metadata = await stat(path);
            return metadata.isFile()
              ? { path, modifiedAt: metadata.mtimeMs }
              : undefined;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              return undefined;
            throw error;
          }
        }),
    )
  )
    .filter(
      (executable): executable is CodexCliExecutable =>
        executable !== undefined,
    )
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const executable of executables) add(executable.path);
  return discovered;
}
