import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelExecutionReceipt } from "./model-selection.js";
import type { LocalBridgeUsageSummary } from "./model-usage-types.js";
export type { LocalBridgeUsageSummary } from "./model-usage-types.js";

async function readReceipts(file: string): Promise<ModelExecutionReceipt[]> {
  try {
    if ((await stat(file)).size > 1_000_000)
      throw new Error("Model evidence store exceeds its size limit.");
    const data: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(data)) throw new Error("Invalid model evidence store.");
    return data.filter(
      (item): item is ModelExecutionReceipt =>
        item?.version === 1 &&
        typeof item.operationId === "string" &&
        item.backendIdentity === "NOT_OBSERVED",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Bounded local audit evidence, not task history. No prompts, cookies or response bodies. */
export class ModelReceiptStore {
  #tail: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}
  record(receipt: ModelExecutionReceipt): Promise<void> {
    const pending = this.#tail
      .catch(() => undefined)
      .then(async () => {
        let rows = await readReceipts(this.file);
        rows = rows.filter((row) => row.operationId !== receipt.operationId);
        rows.push(receipt);
        const content = JSON.stringify(rows.slice(-200), null, 2);
        if (Buffer.byteLength(content) > 1_000_000)
          throw new Error("Model evidence store exceeds its size limit.");
        await mkdir(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, content, {
            flag: "wx",
            mode: 0o600,
            flush: true,
          });
          await rename(temporary, this.file);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    this.#tail = pending;
    return pending;
  }

  async summary(): Promise<LocalBridgeUsageSummary> {
    await this.#tail.catch(() => undefined);
    const rows = await readReceipts(this.file);
    const byMode: Record<string, { operations: number; completed: number }> =
      {};
    let completedOperations = 0;
    let failedOperations = 0;
    let estimatedBrowserInputTokens = 0;
    let estimatedSourceContextTokens = 0;
    for (const row of rows) {
      const modeUsage = (byMode[row.requestedMode] ??= {
        operations: 0,
        completed: 0,
      });
      modeUsage.operations += 1;
      if (row.phase === "completed") {
        completedOperations += 1;
        modeUsage.completed += 1;
        if (row.execution) {
          const browserTokens = Number.isFinite(row.execution.inputTokens)
            ? row.execution.inputTokens
            : 0;
          const sourceTokens = Number.isFinite(
            row.execution.sourceContextTokens,
          )
            ? row.execution.sourceContextTokens
            : browserTokens;
          estimatedBrowserInputTokens += browserTokens;
          estimatedSourceContextTokens += sourceTokens;
        }
      } else if (row.phase === "failed") {
        failedOperations += 1;
      }
    }
    return {
      retainedOperations: rows.length,
      completedOperations,
      failedOperations,
      pendingOperations: rows.length - completedOperations - failedOperations,
      estimatedBrowserInputTokens,
      estimatedSourceContextTokens,
      byMode,
      retentionLimit: 200,
      officialQuotaObserved: false,
    };
  }
}
