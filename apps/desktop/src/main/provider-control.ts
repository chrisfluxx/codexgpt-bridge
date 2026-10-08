import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Readable } from "node:stream";

export interface ProviderControlMetadata {
  readonly version: 1;
  readonly endpoint: string;
  readonly token: string;
  readonly instanceId: string;
}

const TURN_ID = /^[A-Za-z0-9_-]{6,128}$/u;

function validatedMetadata(value: unknown): ProviderControlMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider control metadata is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.endpoint !== "string" ||
    typeof record.token !== "string" ||
    record.token.length < 32 ||
    typeof record.instanceId !== "string"
  ) {
    throw new Error("Provider control metadata is invalid.");
  }
  const endpoint = new URL(record.endpoint);
  if (
    endpoint.protocol !== "http:" ||
    (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "[::1]") ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/"
  ) {
    throw new Error(
      "Provider control endpoint must be a loopback HTTP origin.",
    );
  }
  return {
    version: 1,
    endpoint: endpoint.origin,
    token: record.token,
    instanceId: record.instanceId,
  };
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export class ProviderControlStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  async publish(
    endpoint: string,
    capability: { readonly token: string; readonly instanceId: string } = {
      token: randomBytes(32).toString("hex"),
      instanceId: randomBytes(16).toString("hex"),
    },
  ): Promise<ProviderControlMetadata> {
    const metadata = validatedMetadata({
      version: 1,
      endpoint,
      token: capability.token,
      instanceId: capability.instanceId,
    });
    await atomicWrite(this.#path, `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
  }

  async clear(instanceId?: string): Promise<void> {
    if (instanceId !== undefined) {
      try {
        const current = validatedMetadata(
          JSON.parse(await readFile(this.#path, "utf8")) as unknown,
        );
        if (current.instanceId !== instanceId) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
    await rm(this.#path, { force: true });
  }
}

export async function readInterruptHookInput(
  input: Readable,
  maximumBytes = 32 * 1024,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximumBytes) {
      throw new Error("Codex Interrupt hook payload is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runCodexInterruptHook(
  metadataPath: string,
  input: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(input) as unknown;
  } catch {
    throw new Error("Codex Interrupt hook payload is not valid JSON.");
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new Error("Codex Interrupt hook payload is invalid.");
  }
  const record = payload as Record<string, unknown>;
  const threadId =
    typeof record.session_id === "string" ? record.session_id.trim() : "";
  const turnId =
    typeof record.turn_id === "string" ? record.turn_id.trim() : "";
  if (
    record.hook_event_name !== "Interrupt" ||
    !TURN_ID.test(threadId) ||
    !TURN_ID.test(turnId)
  ) {
    throw new Error(
      "Codex Interrupt hook payload has no valid session_id or turn_id.",
    );
  }
  const metadata = validatedMetadata(
    JSON.parse(await readFile(metadataPath, "utf8")) as unknown,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetchImplementation(
      `${metadata.endpoint}/admin/interrupt-turn`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${metadata.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ thread_id: threadId, turn_id: turnId }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(
        `Provider rejected Interrupt hook with HTTP ${response.status}.`,
      );
    }
    const result = (await response.json()) as Record<string, unknown>;
    if (
      result.status !== "ok" ||
      !Number.isInteger(result.cancelled_http_turns) ||
      !Number.isInteger(result.cancelled_browser_turns)
    ) {
      throw new Error(
        "Provider returned an invalid Interrupt acknowledgement.",
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}
