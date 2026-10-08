import { setTimeout } from "node:timers/promises";

/** Polling must release its abort listener after each completed wait. */
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await setTimeout(ms, undefined, { signal });
}
