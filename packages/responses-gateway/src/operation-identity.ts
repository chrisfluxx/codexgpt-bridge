import { createHash } from "node:crypto";
import type { CompiledResponsesPrompt } from "./prompt.js";

/** Object property order is transport noise; array order and string contents are not. */
export function canonicalJson(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    if (item !== null && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, ordered(v)]),
      );
    return item;
  };
  return JSON.stringify(ordered(value));
}

function instructionsIdentity(text: string): unknown {
  // Only trailing whitespace on the top-level instruction string is normalized.
  // Embedded commands, message content, tool schemas and user steering remain exact.
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return {
        ...parsed,
        instructions:
          typeof parsed.instructions === "string"
            ? parsed.instructions.trimEnd()
            : parsed.instructions,
      };
  } catch {
    /* Standalone adapters may supply plain instructions. */
  }
  return text.trimEnd();
}

export function responsesOperationId(
  model: string,
  input: CompiledResponsesPrompt,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        version: 1,
        model,
        thread: input.threadId,
        turn: input.turnId,
        contextEpoch: input.contextEpoch,
        // A native turn owns its instructions. Rebuilt instruction metadata on a retry
        // cannot create another operation. User steering is identified by prompt/history;
        // tools and tool results are separate stages. Standalone calls have no such owner.
        instructions: input.turnId
          ? undefined
          : instructionsIdentity(input.context.instructions),
        history: input.context.history.map((item) => {
          try {
            return JSON.parse(item) as unknown;
          } catch {
            return item;
          }
        }),
        prompt: input.prompt,
        results: input.toolResults,
        tools: input.toolDefinitions,
        choice: input.toolChoice,
        parallel: input.parallelToolCalls,
        format: input.textFormat,
        compaction: input.compaction === true,
        images: [...input.context.images, ...input.images],
      }),
    )
    .digest("hex");
}
