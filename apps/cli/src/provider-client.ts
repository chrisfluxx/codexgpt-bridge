import { readFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function defaultControlFile(dev = false): Promise<string> {
  const base =
    process.platform === "win32"
      ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  const candidates = ["CodexGPT Bridge", "codexgpt-bridge"].map((name) =>
    join(base, `${name}${dev ? "-dev" : ""}`, "provider-control.json"),
  );
  const present: string[] = [];
  for (const file of candidates) {
    try {
      await access(file);
      present.push(file);
    } catch {
      /* not installed here */
    }
  }
  if (present.length > 1)
    throw new Error(
      "Multiple Bridge instances found; specify --control-file PATH.",
    );
  return present[0] ?? candidates[0]!;
}

export async function desktopCommand(
  controlFile: string,
  command: string,
  args: readonly unknown[] = [],
  fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
  const raw = await readFile(controlFile, "utf8");
  if (raw.length > 16384) throw new Error("Control metadata is too large.");
  const metadata = JSON.parse(raw) as {
    version?: unknown;
    endpoint?: unknown;
    token?: unknown;
  };
  if (
    metadata.version !== 1 ||
    typeof metadata.endpoint !== "string" ||
    typeof metadata.token !== "string" ||
    metadata.token.length < 32 ||
    !/^[A-Za-z0-9_-]+$/.test(metadata.token)
  )
    throw new Error("Invalid control metadata.");
  const endpoint = new URL(metadata.endpoint);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Control endpoint must be loopback HTTP.");
  const response = await fetchImplementation(
    `${endpoint.origin}/admin/command`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${metadata.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command, args }),
      signal: AbortSignal.timeout(60000),
      redirect: "error",
    },
  );
  const result = (await response.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (!response.ok)
    throw new Error(
      result.error?.message ?? `Desktop command failed (${response.status}).`,
    );
  return result.result;
}
