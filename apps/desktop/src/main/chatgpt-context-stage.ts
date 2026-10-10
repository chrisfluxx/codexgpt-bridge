import type { ChatGptBrowserObservation } from "./chatgpt-observation.js";

type ContextStageObservation = Pick<
  ChatGptBrowserObservation,
  | "error"
  | "webNativeToolError"
  | "webNativeToolPending"
  | "webNativeToolPresent"
  | "hasRenderableMedia"
  | "mediaPending"
>;

/** An inert context message must never execute tools or produce rich output. */
export function contextStageAnomaly(
  observation: ContextStageObservation,
): string | undefined {
  if (observation.error) {
    const summary = observation.error
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 180);
    return `ChatGPT reported a page error (${summary}).`;
  }
  if (observation.webNativeToolError)
    return "ChatGPT reported a native App/template error during context staging.";
  if (observation.webNativeToolPending)
    return "ChatGPT attempted to wait for a tool during context staging.";
  if (observation.webNativeToolPresent)
    return "ChatGPT unexpectedly opened an App or tool during context staging.";
  if (observation.mediaPending || observation.hasRenderableMedia)
    return "ChatGPT unexpectedly produced media during context staging.";
  return undefined;
}
