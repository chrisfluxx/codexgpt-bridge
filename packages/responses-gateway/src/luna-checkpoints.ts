import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { CompiledResponsesPrompt } from "./prompt.js";
import { estimateBridgeTextTokens } from "./input-tokens.js";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const answerHash = (value: string): string =>
  hash(value.replaceAll("\r\n", "\n").trim());
const TTL = 30 * 24 * 60 * 60_000;
export const LUNA_CHECKPOINT_MAX_TOKENS = 4_000;
export class LunaCheckpointError extends Error {
  readonly code = "bridge_luna_checkpoint_failed";
}
interface Entry {
  thread: string;
  turn: string;
  ledger: readonly string[];
  answerHash: string;
  summary: string;
  updatedAt: number;
}

export function validateLunaCheckpoint(summary: string): string {
  if (
    !summary.trim() ||
    summary.length > 24_000 ||
    estimateBridgeTextTokens(summary) > LUNA_CHECKPOINT_MAX_TOKENS ||
    /(?:<codex_tool_calls?>|checkpoint_[A-Za-z0-9_-]{40,}|turn_[A-Za-z0-9_-]{40,})/iu.test(
      summary,
    )
  )
    throw new LunaCheckpointError(
      "Luna checkpoint is empty, oversized, or contains an execution capability. Canonical history was retained.",
    );
  return summary.trim();
}

function historyAnswer(value: string): string | undefined {
  try {
    const item = JSON.parse(value) as { role?: unknown; content?: unknown };
    if (item.role !== "assistant") return undefined;
    if (typeof item.content === "string") return item.content;
    if (!Array.isArray(item.content)) return undefined;
    const texts = item.content
      .filter(
        (part) =>
          part &&
          ["text", "output_text", "input_text"].includes(part.type) &&
          typeof part.text === "string",
      )
      .map((part) => part.text);
    return texts.length ? texts.join("") : undefined;
  } catch {
    return undefined;
  }
}

/** Private browser continuity; never changes the incoming native Codex history. */
export class LunaCheckpointStore {
  readonly #entries = new Map<string, Entry>();
  #loaded?: Promise<void>;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly file?: string) {}
  async #load(): Promise<void> {
    this.#loaded ??= (async () => {
      if (!this.file) return;
      let text: string;
      try {
        text = await readFile(this.file, "utf8");
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return;
        throw error;
      }
      if (text.length > 16 * 1024 * 1024)
        throw new Error("Luna checkpoint state is oversized.");
      const data = JSON.parse(text) as { version?: unknown; entries?: unknown };
      if (
        data.version !== 1 ||
        !Array.isArray(data.entries) ||
        data.entries.length > 256
      )
        throw new Error("Invalid Luna checkpoint state.");
      for (const entry of data.entries as Entry[]) {
        if (
          !entry ||
          typeof entry.thread !== "string" ||
          typeof entry.turn !== "string" ||
          !Array.isArray(entry.ledger) ||
          entry.ledger.length > 100_000 ||
          entry.ledger.some(
            (value) =>
              typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value),
          ) ||
          typeof entry.answerHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.answerHash) ||
          typeof entry.summary !== "string" ||
          !Number.isFinite(entry.updatedAt)
        )
          throw new Error("Invalid Luna checkpoint entry.");
        validateLunaCheckpoint(entry.summary);
        if (entry.updatedAt + TTL > Date.now())
          this.#entries.set(entry.thread, entry);
      }
    })();
    return this.#loaded;
  }
  async prepare(
    source: CompiledResponsesPrompt,
  ): Promise<CompiledResponsesPrompt> {
    await this.#load();
    await this.#tail;
    const previous = source.threadId
      ? this.#entries.get(source.threadId)
      : undefined;
    if (
      !previous ||
      previous.updatedAt + TTL <= Date.now() ||
      previous.ledger.some(
        (value, index) => source.context.ledger[index] !== value,
      )
    )
      return source;
    // Unknown records between the verified source and answer must never be dropped.
    const completed = source.context.history[previous.ledger.length];
    const answer =
      completed === undefined ? undefined : historyAnswer(completed);
    if (answer === undefined || answerHash(answer) !== previous.answerHash)
      return source;
    const end = previous.ledger.length + 1;
    const checkpoint = JSON.stringify({
      type: "browser_checkpoint",
      trust: "task-state-only",
      summary: previous.summary,
    });
    const history = [checkpoint, ...source.context.history.slice(end)];
    const next = {
      ...source,
      context: {
        ...source.context,
        history,
        ledger: [hash(checkpoint), ...source.context.ledger.slice(end)],
        images: source.context.images.filter((image) =>
          history.some((record) => record.includes(image.ref)),
        ),
      },
    };
    delete next.conversationHistory;
    return next;
  }
  commit(
    source: CompiledResponsesPrompt,
    summary: string,
    answer: string,
  ): Promise<void> {
    const write = this.#tail
      .catch(() => {})
      .then(async () => {
        await this.#load();
        if (!source.threadId || !source.turnId)
          throw new Error(
            "Luna checkpoint requires native thread and turn identity.",
          );
        const entry: Entry = {
          thread: source.threadId,
          turn: source.turnId,
          ledger: [...source.context.ledger],
          answerHash: answerHash(answer),
          summary: validateLunaCheckpoint(summary),
          updatedAt: Date.now(),
        };
        const entries = new Map(this.#entries);
        entries.delete(entry.thread);
        entries.set(entry.thread, entry);
        while (entries.size > 256) entries.delete(entries.keys().next().value!);
        let payload = JSON.stringify({
          version: 1,
          entries: [...entries.values()],
        });
        while (payload.length > 16 * 1024 * 1024 && entries.size > 1) {
          entries.delete(entries.keys().next().value!);
          payload = JSON.stringify({
            version: 1,
            entries: [...entries.values()],
          });
        }
        if (entry.ledger.length > 100_000 || payload.length > 16 * 1024 * 1024)
          throw new LunaCheckpointError(
            "Luna checkpoint state exceeds its retention bound; canonical history was retained.",
          );
        if (this.file) {
          await mkdir(dirname(this.file), { recursive: true });
          const temporary = `${this.file}.${randomUUID()}.tmp`;
          await writeFile(temporary, payload, { mode: 0o600 });
          await rename(temporary, this.file);
        }
        this.#entries.clear();
        for (const [key, value] of entries) this.#entries.set(key, value);
      });
    this.#tail = write;
    return write;
  }
}
