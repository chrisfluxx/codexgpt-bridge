import {
  BRIDGE_TEXT_FRAME_CLOSE,
  BRIDGE_TEXT_FRAME_OPEN,
} from "./tool-protocol.js";

export class BridgeStreamError extends Error {
  readonly code = "bridge_stream_conflict";
}

const TEXT_FRAMES = [
  {
    kind: "markdown",
    open: BRIDGE_TEXT_FRAME_OPEN,
    close: BRIDGE_TEXT_FRAME_CLOSE,
  },
  { kind: "legacy", open: "<codex_text>", close: "</codex_text>" },
] as const;

type TextFrame = (typeof TEXT_FRAMES)[number];

function frameFor(value: string): TextFrame | undefined {
  return TEXT_FRAMES.find((frame) => value.startsWith(frame.open));
}

function isToolEnvelope(value: string): boolean {
  const candidate = value
    .trimStart()
    .replace(/^```(?:json|xml|html|text)?\s*/iu, "")
    .trimStart();
  return /^<codex_tool_calls?>/iu.test(candidate);
}

function couldBeToolEnvelope(value: string): boolean {
  let candidate = value.trimStart();
  if (/^`{1,2}$/u.test(candidate)) return true;
  if (candidate.startsWith("```")) {
    const newline = candidate.indexOf("\n");
    if (newline < 0) return true;
    const language = candidate.slice(3, newline).trim().toLowerCase();
    if (!["", "json", "xml", "html", "text"].includes(language)) return false;
    candidate = candidate.slice(newline + 1).trimStart();
  }
  candidate = candidate.toLowerCase();
  return ["<codex_tool_call>", "<codex_tool_calls>"].some(
    (open) => open.startsWith(candidate) || candidate.startsWith(open),
  );
}

/** Wait for split protocol prefixes before binding or emitting ordinary text. */
export function isBridgeTextStreamCandidate(
  raw: string,
  started = false,
): boolean {
  const text = raw.trimStart();
  if (!text) return false;
  const frame = frameFor(text);
  if (frame) return started || !text.includes(frame.close);
  if (TEXT_FRAMES.some((entry) => entry.open.startsWith(text))) return false;
  return !couldBeToolEnvelope(text);
}

/** Commit mutable plain/DOM text at completion; explicit network frames may stream. */
export class BridgeTextStream {
  #sent: string | undefined;
  #prefix = "";
  #networkFrame: TextFrame["kind"] | "plain" | undefined;
  constructor(private readonly emit: (delta: string) => void) {}
  /** Only the browser's message-bound network observer may call this. Never DOM. */
  updateNetwork(raw: string): void {
    const framed = raw.trimStart();
    const frame = frameFor(framed);
    if (frame === undefined) {
      const candidate = isBridgeTextStreamCandidate(raw);
      if (this.#prefix && (this.#networkFrame !== "plain" || !candidate))
        throw new BridgeStreamError("Streamed answer changed its text frame.");
      if (!candidate) return;
      this.#networkFrame = "plain";
      // Plain message-bound SSE text is still mutable: ChatGPT may later send
      // a replace operation for the same message. Unlike an explicit frame,
      // there is no boundary that proves a plain prefix is committed, so keep
      // it buffered until the browser reports the settled final response.
      return;
    }
    if (
      this.#prefix &&
      this.#networkFrame !== undefined &&
      this.#networkFrame !== frame.kind
    )
      throw new BridgeStreamError("Streamed answer changed its text frame.");
    this.#networkFrame = frame.kind;
    let text = framed.slice(frame.open.length);
    if (frame.kind === "markdown") text = text.trimStart();
    const end = text.indexOf(frame.close);
    // A complete frame can be an interim answer replaced wholesale later.
    // If no prefix was delivered, leave it to final completion validation.
    if (end >= 0 && !this.#prefix) return;
    if (end >= 0) {
      if (text.slice(end + frame.close.length).trim())
        throw new BridgeStreamError(
          "Unexpected content after streamed text frame.",
        );
      text = text.slice(0, end);
      if (frame.kind === "markdown") text = text.trimEnd();
    } else {
      // Keep partial closing tags and UTF-16 surrogate pairs out of visible deltas.
      for (let size = frame.close.length - 1; size > 0; size--)
        if (text.endsWith(frame.close.slice(0, size))) {
          text = text.slice(0, -size);
          break;
        }
      // The parser trims comment-frame padding. The rendered DOM can add more
      // than one blank line around those comments. Hold trailing whitespace
      // until the next snapshot proves it is internal Markdown content.
      if (frame.kind === "markdown") text = text.trimEnd();
    }
    this.#emitNetworkText(text);
  }
  #emitNetworkText(text: string): void {
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    if (!text.startsWith(this.#prefix))
      throw new BridgeStreamError(
        "Network answer rewrote text already delivered.",
      );
    const delta = text.slice(this.#prefix.length);
    this.#prefix = text;
    if (delta) this.emit(delta);
  }
  update(raw: string, final = false): void {
    if (!final) return;
    const framed = raw.trim();
    const frame = frameFor(framed);
    let text: string;
    if (frame === undefined) {
      if (isToolEnvelope(framed)) return;
      if (this.#prefix && this.#networkFrame === "legacy")
        throw new BridgeStreamError(
          "Completed response lost its streamed text frame.",
        );
      // New answers are plain Markdown. Retained comment frames can also
      // disappear from ChatGPT's rendered DOM, leaving the same plain body.
      text = framed;
    } else {
      if (!framed.endsWith(frame.close))
        throw new Error("Incomplete Codex text frame.");
      text = framed.slice(frame.open.length, -frame.close.length);
      if (frame.kind === "markdown") text = text.trim();
    }
    if (!text.startsWith(this.#prefix))
      throw new BridgeStreamError(
        "Completed response disagrees with streamed text.",
      );
    if (this.#sent !== undefined) {
      if (this.#sent !== text)
        throw new Error("Completed response changed after delivery.");
      return;
    }
    this.#sent = text;
    const delta = text.slice(this.#prefix.length);
    this.#prefix = text;
    if (delta) this.emit(delta);
  }
}
