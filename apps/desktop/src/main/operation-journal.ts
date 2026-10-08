import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type OperationPhase =
  "preparing" | "submitting" | "accepted" | "result-ready" | "failed";
interface OperationRecord {
  key: string;
  phase: OperationPhase;
  possiblySubmitted: boolean;
  updatedAt: string;
  contextTransfer?: {
    transactionId: string;
    total: number;
    acknowledgements: Array<{ part: number; digest: string }>;
  };
}

function validContextTransfer(
  value: OperationRecord["contextTransfer"],
): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    /^ctx_[a-f0-9]{32}$/.test(value.transactionId) &&
    Number.isSafeInteger(value.total) &&
    value.total >= 2 &&
    value.total <= 6 &&
    Array.isArray(value.acknowledgements) &&
    value.acknowledgements.length < value.total &&
    value.acknowledgements.every(
      (ack, index) =>
        ack && ack.part === index + 1 && /^[a-f0-9]{64}$/.test(ack.digest),
    )
  );
}

export class OperationRecoveryError extends Error {
  readonly code = "bridge_operation_recovery_required";
  constructor() {
    super(
      "原操作可能已送出，但可重播結果已不在記憶體。Bridge 未重新送出；請開啟原 ChatGPT 對話並核對 Codex 工具結果，再決定如何接續。",
    );
  }
}

/** Submission ownership only. Never stores prompts, output, credentials or tool arguments.
 * Persist the intent BEFORE clicking Send. Only the in-memory runner can replay results.
 * Unknown outcomes survive restarts and are never automatically replayed or evicted.
 */
export class OperationJournal {
  #tail: Promise<unknown> = Promise.resolve();
  #rows: Map<string, OperationRecord> | undefined;
  constructor(private readonly file?: string) {}

  begin(key: string): Promise<void> {
    return this.#change(key, "preparing", true);
  }
  mark(key: string, phase: OperationPhase): Promise<void> {
    return this.#change(key, phase, false);
  }
  acknowledgeContextStage(
    key: string,
    transactionId: string,
    part: number,
    total: number,
    digest: string,
  ): Promise<void> {
    return this.#change(key, "accepted", false, {
      transactionId,
      part,
      total,
      digest,
    });
  }
  #change(
    key: string,
    phase: OperationPhase,
    begin: boolean,
    stage?: {
      transactionId: string;
      part: number;
      total: number;
      digest: string;
    },
  ): Promise<void> {
    const pending = this.#tail
      .catch(() => undefined)
      .then(async () => {
        if (!/^[a-f0-9]{64}$/.test(key))
          throw new Error("Invalid operation journal key.");
        if (!this.#rows) {
          let rows: OperationRecord[] = [];
          if (this.file) {
            try {
              const raw = await readFile(this.file, "utf8");
              if (raw.length > 4_000_000)
                throw new Error("Operation journal exceeds its limit.");
              const parsed: unknown = JSON.parse(raw);
              if (
                !Array.isArray(parsed) ||
                parsed.length > 10000 ||
                parsed.some(
                  (row) =>
                    !row ||
                    !/^[a-f0-9]{64}$/.test(row.key) ||
                    ![
                      "preparing",
                      "submitting",
                      "accepted",
                      "result-ready",
                      "failed",
                    ].includes(row.phase) ||
                    typeof row.possiblySubmitted !== "boolean" ||
                    typeof row.updatedAt !== "string" ||
                    !validContextTransfer(row.contextTransfer) ||
                    (["submitting", "accepted", "result-ready"].includes(
                      row.phase,
                    ) &&
                      !row.possiblySubmitted),
                )
              )
                throw new Error(
                  "Invalid operation journal; submission was blocked.",
                );
              rows = parsed;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
          }
          this.#rows = new Map(rows.map((row) => [row.key, row]));
        }
        const previous = this.#rows.get(key);
        if (begin && previous?.possiblySubmitted)
          throw new OperationRecoveryError();
        if (!begin && !previous)
          throw new Error("Operation has no journal owner.");
        if (!previous && this.#rows.size >= 10000)
          throw new Error(
            "Operation journal is full; archive reviewed operation records before starting new work.",
          );
        const next = new Map(this.#rows);
        let contextTransfer = previous?.contextTransfer;
        if (stage) {
          if (
            contextTransfer &&
            (contextTransfer.transactionId !== stage.transactionId ||
              contextTransfer.total !== stage.total)
          )
            throw new Error(
              "Context stage acknowledgement belongs to another transaction.",
            );
          const acknowledgements = [
            ...(contextTransfer?.acknowledgements ?? []),
          ];
          const previousAck = acknowledgements[stage.part - 1];
          if (previousAck) {
            if (previousAck.digest !== stage.digest)
              throw new Error(
                "Context stage acknowledgement changed its digest.",
              );
          } else {
            if (stage.part !== acknowledgements.length + 1)
              throw new Error(
                "Context stage acknowledgements must be recorded in order.",
              );
            acknowledgements.push({ part: stage.part, digest: stage.digest });
          }
          contextTransfer = {
            transactionId: stage.transactionId,
            total: stage.total,
            acknowledgements,
          };
          if (!validContextTransfer(contextTransfer))
            throw new Error("Invalid context stage acknowledgement.");
        }
        next.set(key, {
          key,
          phase,
          possiblySubmitted:
            previous?.possiblySubmitted === true ||
            ["submitting", "accepted", "result-ready"].includes(phase),
          updatedAt: new Date().toISOString(),
          ...(contextTransfer ? { contextTransfer } : {}),
        });
        if (this.file) {
          await mkdir(dirname(this.file), { recursive: true });
          const temporary = `${this.file}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, JSON.stringify([...next.values()]), {
              flag: "wx",
              mode: 0o600,
              flush: true,
            });
            await rename(temporary, this.file);
          } finally {
            await rm(temporary, { force: true });
          }
        }
        this.#rows = next;
      });
    this.#tail = pending;
    return pending;
  }
}
