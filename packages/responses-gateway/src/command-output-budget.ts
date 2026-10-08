/** Keep command logs from consuming an entire browser context between checkpoints. */
export const DEFAULT_COMMAND_OUTPUT_TOKENS = 3_000;
export const MAX_COMMAND_OUTPUT_TOKENS = 8_000;

export function commandOutputTokenBudget(requested: unknown): number {
  if (requested === undefined) return DEFAULT_COMMAND_OUTPUT_TOKENS;
  if (
    typeof requested !== "number" ||
    !Number.isSafeInteger(requested) ||
    requested < 1
  ) {
    throw new Error("max_output_tokens must be a positive integer.");
  }
  return Math.min(requested, MAX_COMMAND_OUTPUT_TOKENS);
}
