import { createHash, randomUUID } from "node:crypto";
import {
  planFullContextTransfer,
  synchronizeBridgeExecutionPreflight,
  bridgeExecutionLimitProblem,
  MANUAL_COMPLETION_TOOL,
  type FullContextMessage,
  type RunWebTurnInput,
  type FullTurnBroker,
} from "@codexgpt-bridge/responses-gateway";
import { planContextSync, type ContextReceipt } from "./context-sync.js";
import { TurnPool } from "./turn-pool.js";

export interface ManualTask {
  readonly id: string;
  readonly threadId: string;
  readonly mode: string;
  readonly modelFamily?: string;
  readonly prompt: string;
  readonly images: RunWebTurnInput["images"];
  readonly sent: boolean;
  readonly retained: boolean;
  readonly part: number;
  readonly total: number;
  readonly acknowledgement?: string;
}
interface Pending {
  task: ManualTask;
  input: RunWebTurnInput;
  receipt: ContextReceipt | undefined;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  completedText?: string;
  readonly frames: readonly FullContextMessage[];
  readonly images: RunWebTurnInput["images"];
}

/** Manual interaction never opens, reads, or writes a ChatGPT page. */
export class ManualTurns {
  readonly #pending = new Map<string, Pending>();
  readonly #receipts = new Map<string, ContextReceipt>();
  readonly pool = new TurnPool(5);
  constructor(
    readonly broker: FullTurnBroker,
    readonly confirmationMs = 60000,
  ) {}
  tasks(): ManualTask[] {
    return [...this.#pending.values()].map(({ task }) => task);
  }
  async runTurn(input: RunWebTurnInput): Promise<string> {
    if (!input.allowWebNativeTools || !input.turnToken)
      throw new Error("Manual turns require an owned Full MCP token.");
    input.onContextStaging?.();
    return this.pool.run(
      input.signal,
      async () => {
        const key = input.threadId ?? input.operationId ?? randomUUID();
        const previous = input.forceNewConversation
          ? undefined
          : this.#receipts.get(key);
        if (input.requireRetainedConversation && !previous)
          throw new Error(
            "The manual source conversation is unavailable. Canonical history was retained.",
          );
        const sync = input.context
          ? planContextSync(
              input.context,
              input.contract ?? "",
              previous,
              input.images,
            )
          : undefined;
        if (input.requireRetainedConversation && sync?.reset)
          throw new Error(
            "The manual source ledger changed. Canonical history was retained.",
          );
        const completionContract = `[Manual Bridge completion: required even for a text-only task]\nBefore returning your final user-facing answer, use codex_tool_inventory with turn_token=${input.turnToken} and query=${JSON.stringify(MANUAL_COMPLETION_TOOL)}. Then call codex_tool_call with the same turn_token, wire_name=${JSON.stringify(MANUAL_COMPLETION_TOOL)}, and arguments={"text":"THE ENTIRE FINAL ANSWER"}. This Bridge transport control sends the answer back to Codex; a plain ChatGPT reply alone does not complete the task. Use this generic route even if the connector does not expose codex_manual_complete. Do not complete while native tools are pending. For a checkpoint, submit its requested checkpoint control instead.`;
        const prompt = [
          `Select ChatGPT mode ${input.mode}${input.modelFamily ? ` in family ${input.modelFamily}` : ""} and the connector named ${JSON.stringify(input.connectorName ?? "CodexGPT Bridge")}.`,
          sync?.text ?? input.contract,
          "[Current request]",
          input.prompt,
          completionContract,
        ]
          .filter(Boolean)
          .join("\n\n");
        const images = [
          ...new Map(
            [...(sync?.images ?? []), ...input.images].map((image) => [
              image.imageUrl,
              image,
            ]),
          ).values(),
        ];
        let frames: readonly FullContextMessage[] = [
          { text: prompt, digest: "" },
        ];
        if (input.execution) {
          const execution = synchronizeBridgeExecutionPreflight(
            input.execution,
            { prompt, images },
          );
          const problem = bridgeExecutionLimitProblem(execution);
          if (problem) {
            if (
              (!execution.stagedContext && execution.contextMultiplier !== 3) ||
              input.requireRetainedConversation ||
              !input.onContextStaging ||
              !input.onContextCommit ||
              execution.browserMessageTokenLimit === undefined ||
              execution.inputTokens > execution.hardInputTokenLimit
            )
              throw new Error(
                `Manual prompt exceeds its context budget: ${problem}`,
              );
            const transfer = planFullContextTransfer(
              [
                sync?.transportText ?? input.conversationHistory,
                "[Current request]",
                input.prompt,
              ]
                .filter(Boolean)
                .join("\n\n"),
              [input.contract, completionContract].filter(Boolean).join("\n\n"),
              createHash("sha256")
                .update(input.operationId ?? prompt)
                .digest("hex"),
              {
                messageTokens: execution.browserMessageTokenLimit,
                ...(execution.browserComposerCharLimit === undefined
                  ? {}
                  : { messageCharacters: execution.browserComposerCharLimit }),
                transactionTokens: execution.hardInputTokenLimit,
                imageTokens: execution.imageReserveTokens,
                platformTokens: execution.platformReserveTokens,
              },
            );
            frames = [...transfer.stages, transfer.commit];
          }
        }
        let owned!: Pending;
        const aborted = () =>
          owned?.reject(new Error("Manual turn cancelled."));
        const result = new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error("Manual turn timed out before Sent confirmation."),
              ),
            this.confirmationMs,
          );
          timer.unref?.();
          owned = {
            task: {
              id: randomUUID(),
              threadId: key,
              mode: input.mode,
              ...(input.modelFamily ? { modelFamily: input.modelFamily } : {}),
              prompt: frames[0]!.text,
              images: frames[0]!.acknowledgement ? [] : images,
              part: 1,
              total: frames.length,
              ...(frames[0]!.acknowledgement
                ? { acknowledgement: frames[0]!.acknowledgement }
                : {}),
              sent: false,
              retained: !!previous && sync?.reset !== true,
            },
            input,
            receipt: sync?.receipt,
            resolve,
            reject,
            timer,
            frames,
            images,
          };
          this.#pending.set(input.turnToken!, owned);
          input.signal.addEventListener("abort", aborted, { once: true });
          if (input.signal.aborted) aborted();
        });
        try {
          const text = await result;
          if (owned.receipt) {
            this.#receipts.delete(key);
            this.#receipts.set(key, owned.receipt);
            if (this.#receipts.size > 500)
              this.#receipts.delete(this.#receipts.keys().next().value!);
          }
          return text;
        } finally {
          clearTimeout(owned.timer);
          input.signal.removeEventListener("abort", aborted);
          this.#pending.delete(input.turnToken!);
        }
      },
      (ahead) => input.onProgress?.(ahead > 0 ? "queued" : "preparing"),
    );
  }
  #byId(id: string): Pending {
    const owned = [...this.#pending.values()].find(
      ({ task }) => task.id === id,
    );
    if (!owned) throw new Error("This manual task has ended.");
    return owned;
  }
  sent(id: string): void {
    const owned = this.#byId(id);
    if (owned.task.sent) return;
    owned.input.signal.throwIfAborted();
    if (!owned.task.acknowledgement) owned.input.onContextCommit?.();
    owned.task = { ...owned.task, sent: true };
    clearTimeout(owned.timer);
    owned.timer = setTimeout(
      () => owned.reject(new Error("Manual Full turn timed out.")),
      4 * 60 * 60 * 1000,
    );
    owned.timer.unref?.();
    owned.input.onProgress?.("generating");
  }
  complete(token: string, text: string): void {
    const owned = this.#pending.get(token);
    if (
      !owned ||
      !owned.task.sent ||
      owned.task.acknowledgement ||
      !this.broker.isActive(token)
    )
      throw new Error("No sent manual turn owns this token.");
    if (
      this.broker.hasPending(token) ||
      this.broker.hasRunningNativePrograms(token)
    )
      throw new Error(
        "Finish pending Codex tools before completing the manual turn.",
      );
    if (
      owned.input.requiredSubagentResults &&
      this.broker.subagentsCompleted(token) !==
        owned.input.requiredSubagentResults
    )
      throw new Error(
        "Wait for the requested successful native agent results before completing the manual turn.",
      );
    if (!text.trim() || text.length > 2000000)
      throw new Error("Manual final answer must contain 1–2000000 characters.");
    if (owned.completedText !== undefined && owned.completedText !== text)
      throw new Error("Manual completion was retried with a different answer.");
    owned.completedText = text;
    owned.resolve(text);
  }
  assertSent(token: string): void {
    const owned = this.#pending.get(token);
    if (owned && (!owned.task.sent || owned.task.acknowledgement))
      throw new Error(
        "Confirm Sent in Bridge before invoking connector tools.",
      );
  }
  completeFromUser(id: string, text: string): void {
    const owned = this.#byId(id);
    if (typeof text !== "string")
      throw new Error("Paste the ChatGPT final answer as text.");
    this.complete(owned.input.turnToken!, text);
  }
  cancel(id: string): void {
    this.#byId(id).reject(new Error("Manual turn cancelled."));
  }
  acknowledge(id: string, acknowledgement: string): void {
    const owned = this.#byId(id);
    if (
      !owned.task.sent ||
      !owned.task.acknowledgement ||
      acknowledgement.trim() !== owned.task.acknowledgement
    )
      throw new Error(
        "Paste the exact acknowledgement from the sent source conversation before continuing.",
      );
    const frame = owned.frames[owned.task.part]!;
    owned.task = {
      id: owned.task.id,
      threadId: owned.task.threadId,
      mode: owned.task.mode,
      ...(owned.task.modelFamily
        ? { modelFamily: owned.task.modelFamily }
        : {}),
      retained: owned.task.retained,
      sent: false,
      part: owned.task.part + 1,
      total: owned.frames.length,
      prompt: frame.text,
      images: frame.acknowledgement ? [] : owned.images,
      ...(frame.acknowledgement
        ? { acknowledgement: frame.acknowledgement }
        : {}),
    };
    clearTimeout(owned.timer);
    owned.timer = setTimeout(
      () =>
        owned.reject(
          new Error("Manual turn timed out before Sent confirmation."),
        ),
      this.confirmationMs,
    );
    owned.timer.unref?.();
  }
  close(): void {
    for (const owned of this.#pending.values())
      owned.reject(new Error("Manual provider closed."));
    this.#receipts.clear();
  }
}
