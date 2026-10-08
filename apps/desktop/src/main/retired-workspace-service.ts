import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const START = "# >>> CodexGPT Bridge managed MCP";
const END = "# <<< CodexGPT Bridge managed MCP";
const hash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

interface RetirementOptions {
  readonly userDataDirectory: string;
  readonly configPath: string;
  readonly decryptToken: (encrypted: Buffer) => string;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function replaceText(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function retireSettings(directory: string): Promise<void> {
  const path = join(directory, "desktop-settings.json");
  const text = await readOptional(path);
  if (text === undefined) return;
  const settings = JSON.parse(text) as Record<string, unknown>;
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("Invalid desktop settings.");
  const keys = ["allowedRoots", "permission", "backgroundRuntime"];
  if (!keys.some((key) => Object.hasOwn(settings, key))) return;
  for (const key of keys) delete settings[key];
  await replaceText(path, `${JSON.stringify(settings, null, 2)}\n`);
}

async function retireRegistration(options: RetirementOptions): Promise<void> {
  const journalPath = join(options.userDataDirectory, "codex-integration.json");
  const journalText = await readOptional(journalPath);
  if (journalText === undefined) return;
  const journal = JSON.parse(journalText) as Record<string, unknown>;
  if (
    journal.version !== 1 ||
    typeof journal.configPath !== "string" ||
    typeof journal.blockHash !== "string" ||
    typeof journal.originalHash !== "string" ||
    typeof journal.separator !== "string" ||
    typeof journal.createdConfig !== "boolean"
  )
    throw new Error("Invalid legacy MCP journal.");
  const normalize = (path: string): string =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  if (normalize(journal.configPath) !== normalize(options.configPath))
    throw new Error("Legacy MCP registration belongs to another Codex home.");
  const text = await readOptional(options.configPath);
  if (text === undefined || !text.includes(START)) {
    await rm(journalPath, { force: true });
    return;
  }
  const start = text.indexOf(START);
  const markerEnd = text.indexOf(END);
  if (
    (start > 0 && text[start - 1] !== "\n") ||
    markerEnd < start ||
    text.indexOf(START, start + START.length) !== -1 ||
    text.indexOf(END, markerEnd + END.length) !== -1
  )
    throw new Error("Ambiguous legacy MCP registration.");
  let end = markerEnd + END.length;
  if (text.slice(end, end + 2) === "\r\n") end += 2;
  else if (text[end] === "\n") end += 1;
  if (hash(text.slice(start, end)) !== journal.blockHash)
    throw new Error("Legacy MCP registration was edited by the user.");
  const separatorStart = start - journal.separator.length;
  const prefix = text.slice(0, separatorStart);
  const suffix = text.slice(end);
  const restored =
    separatorStart >= 0 &&
    text.slice(separatorStart, start) === journal.separator &&
    hash(prefix) === journal.originalHash &&
    suffix.length === 0
      ? prefix
      : text.slice(0, start) + suffix;
  // Preserve a recoverable copy before removing only the proven owned block.
  await writeFile(
    join(options.userDataDirectory, `retired-mcp-config-${randomUUID()}.toml`),
    text,
    { encoding: "utf8", mode: 0o600 },
  );
  if ((await readOptional(options.configPath)) !== text)
    throw new Error("Codex config changed during legacy MCP cleanup.");
  if (journal.createdConfig && restored.length === 0)
    await rm(options.configPath, { force: true });
  else await replaceText(options.configPath, restored);
  await rm(journalPath, { force: true });
}

async function retireDaemon(options: RetirementOptions): Promise<void> {
  const metadataPath = join(
    options.userDataDirectory,
    "runtime-connection.json",
  );
  const tokenPath = join(options.userDataDirectory, "runtime-token.bin");
  const text = await readOptional(metadataPath);
  if (text !== undefined) {
    const metadata = JSON.parse(text) as Record<string, unknown>;
    if (
      metadata.version !== 1 ||
      typeof metadata.endpoint !== "string" ||
      !/^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/u.test(metadata.endpoint)
    )
      throw new Error("Invalid legacy daemon endpoint.");
    const url = new URL(metadata.endpoint);
    const token = options.decryptToken(await readFile(tokenPath));
    if (token.length < 16) throw new Error("Invalid legacy daemon credential.");
    const requestOptions = {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error" as const,
      signal: AbortSignal.timeout(1_500),
    };
    try {
      const response = await fetch(
        `${url.origin}/admin/status`,
        requestOptions,
      );
      if (!response.ok) throw new Error("Legacy daemon could not be verified.");
      const status = (await response.json()) as Record<string, unknown>;
      if (
        !Number.isInteger(status.transportSessions) ||
        !Array.isArray(status.workspaces) ||
        !Array.isArray(status.processes) ||
        !Array.isArray(status.pendingApprovals)
      )
        throw new Error("Endpoint is not a legacy workspace daemon.");
      const stopped = await fetch(`${url.origin}/admin/shutdown`, {
        ...requestOptions,
        method: "POST",
        signal: AbortSignal.timeout(1_500),
      });
      if (!stopped.ok) throw new Error("Legacy daemon shutdown failed.");
    } catch (error) {
      // An unreachable service is already stopped. Authentication errors and
      // timeouts retain its metadata so a later startup can retry safely.
      if (
        (error as { cause?: NodeJS.ErrnoException }).cause?.code !==
        "ECONNREFUSED"
      )
        throw error;
    }
  }
  await rm(metadataPath, { force: true });
  await rm(tokenPath, { force: true });
}

/** Upgrade-only cleanup; never starts or exposes a workspace tool service. */
export async function retireWorkspaceService(
  options: RetirementOptions,
): Promise<readonly string[]> {
  const warnings: string[] = [];
  for (const [step, action] of [
    ["settings", () => retireSettings(options.userDataDirectory)],
    ["MCP registration", () => retireRegistration(options)],
    ["daemon", () => retireDaemon(options)],
  ] as const) {
    try {
      await action();
    } catch {
      warnings.push(
        `Legacy workspace ${step} cleanup could not be completed; existing data was preserved.`,
      );
    }
  }
  return warnings;
}
