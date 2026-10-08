export interface ChatGptCompletionObservation {
  readonly hasNewAssistant: boolean;
  readonly text: string;
  readonly html: string;
  readonly hasRenderableMedia?: boolean;
  readonly busy: boolean;
  readonly responseBusy?: boolean;
  readonly mediaPending?: boolean;
  readonly webNativeToolPending?: boolean;
  readonly webNativeToolPresent?: boolean;
  readonly completionActionVisible: boolean;
  readonly assistantToken?: string;
  readonly userToken?: string;
  /** Same new message ID, successful end_turn, and full streamed body matching the DOM. */
  readonly terminalConfirmed?: boolean;
}

export interface ChatGptConfirmedCompletion {
  readonly userToken: string;
  readonly assistantMessageId: string;
  readonly requestCount: number;
  readonly text: string;
}

export interface ChatGptRecoverableToolFailure {
  readonly userToken: string;
  readonly assistantToken: string;
  readonly assistantMessageId: string;
  readonly requestCount: number;
  readonly error: string;
}

export interface ChatGptTurnLifecycleObservation {
  readonly userCount: number;
  readonly assistantCount: number;
  readonly userToken: string;
  readonly assistantMessageId: string;
  readonly generationRequestCount: number;
  readonly text: string;
  readonly composerText: string;
  readonly responseBusy: boolean;
  readonly busySources: readonly {
    readonly kind: string;
    readonly scope: string;
    readonly owner: string;
    readonly blocking: boolean;
  }[];
}

export interface ChatGptToolFailureObservation extends ChatGptTurnLifecycleObservation {
  readonly assistantToken: string;
  readonly composer: boolean;
  readonly webNativeToolPresent: boolean;
  readonly webNativeToolError: string;
}

/**
 * A page-level Stop control is safe to disregard only when it is the sole
 * blocking marker and the page still matches the exact stream-confirmed turn.
 */
export function isConfirmedStalePageStop(
  observation: ChatGptTurnLifecycleObservation,
  proof: ChatGptConfirmedCompletion,
  completedBodyMatches: boolean,
): boolean {
  if (
    !observation.responseBusy ||
    observation.userToken !== proof.userToken ||
    observation.assistantMessageId !== proof.assistantMessageId ||
    observation.generationRequestCount !== proof.requestCount ||
    observation.composerText.trim().length > 0 ||
    !completedBodyMatches
  ) {
    return false;
  }
  const blockers = observation.busySources.filter((source) => source.blocking);
  return (
    blockers.length > 0 &&
    blockers.every(
      (source) =>
        source.kind === "stop-control" &&
        source.scope === "page" &&
        source.owner === "page",
    )
  );
}

/**
 * A failed ChatGPT-native app/tool may leave its own aria-busy node and the
 * page Stop control mounted after Bridge rejects it. The bounded correction
 * may continue only while the exact failed turn and failure marker remain.
 */
export function isRecoverableToolFailure(
  observation: ChatGptToolFailureObservation,
  proof: ChatGptRecoverableToolFailure,
): boolean {
  if (
    !proof.userToken ||
    !proof.assistantToken ||
    !proof.assistantMessageId ||
    observation.userToken !== proof.userToken ||
    observation.assistantToken !== proof.assistantToken ||
    observation.assistantMessageId !== proof.assistantMessageId ||
    observation.generationRequestCount !== proof.requestCount ||
    !observation.composer ||
    !observation.webNativeToolPresent ||
    (proof.error.length > 0 && observation.webNativeToolError !== proof.error)
  ) {
    return false;
  }
  return observation.busySources
    .filter((source) => source.blocking)
    .every(
      (source) => source.scope === "page" || source.scope === "current-answer",
    );
}

/** Stale global activity is not proof that the new prompt was accepted. */
export function isChatGptSubmissionAcknowledged(
  baseline: ChatGptTurnLifecycleObservation,
  observation: ChatGptTurnLifecycleObservation,
  promptHadText: boolean,
): boolean {
  return (
    observation.generationRequestCount > baseline.generationRequestCount ||
    observation.userCount > baseline.userCount ||
    observation.assistantCount > baseline.assistantCount ||
    (promptHadText && observation.composerText.trim().length === 0)
  );
}

/** Bind response-start liveness to this submission, not a retained Stop node. */
export function hasChatGptResponseStarted(
  baseline: Pick<ChatGptTurnLifecycleObservation, "generationRequestCount">,
  observation: Pick<ChatGptTurnLifecycleObservation, "generationRequestCount">,
  hasNewAssistant: boolean,
): boolean {
  return (
    hasNewAssistant ||
    observation.generationRequestCount > baseline.generationRequestCount
  );
}

export const CHAT_GPT_RICH_OUTPUT_ONLY = Symbol("chat-gpt-rich-output-only");

const CODEX_TOOL_CALL_MARKERS = [
  {
    open: "<codex_tool_calls>",
    close: "</codex_tool_calls>",
  },
  {
    open: "<codex_tool_call>",
    close: "</codex_tool_call>",
  },
] as const;

const INVISIBLE_PROTOCOL_CHARACTERS = /[\u200b-\u200d\u2060\ufeff]/gu;
const CHAT_GPT_TIMING_LINE =
  /^(?:處理時間為|处理时间为|思考了|思考時間為|思考时间为|worked for|thought for)\s+\d[\d\s.:]*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds|小時|小时|分(?:鐘|钟)?|秒)(?:\s+\d[\d\s.:]*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds|小時|小时|分(?:鐘|钟)?|秒))*$/iu;

/** Retry only an image request whose answer explicitly reports an image-tool failure. */
export function shouldRetryTransientImageGeneration(
  prompt: string,
  previousAssistantText: string,
  answer: string,
): boolean {
  const imageFailure =
    /(?:image|picture|photo|illustration|artwork|圖片|图像|圖像|影像|插圖|插图|照片).{0,80}(?:generat|creat|tool|failed|failure|error|unable|couldn|失敗|失败|錯誤|错误|出錯|出错|無法|无法)/isu.test(
      answer,
    ) ||
    /(?:generat|creat|tool|failed|failure|error|unable|couldn|失敗|失败|錯誤|错误|出錯|出错|無法|无法).{0,80}(?:image|picture|photo|illustration|artwork|圖片|图像|圖像|影像|插圖|插图|照片)/isu.test(
      answer,
    );
  if (!imageFailure) return false;

  const asksForImage =
    /(?:generat(?:e|ing|ion)?|creat(?:e|ing|ion)?|make|build|draw|render|design).{0,60}(?:image|picture|photo|illustration|artwork)/isu.test(
      prompt,
    ) ||
    /(?:image|picture|photo|illustration|artwork).{0,60}(?:generat(?:e|ing|ion)?|creat(?:e|ing|ion)?|make|build|draw|render|design)/isu.test(
      prompt,
    ) ||
    /(?:生成|產生|产生|建立|創作|创作|畫|画|繪製|绘制|製作|制作|做).{0,30}(?:圖片|图片|圖像|图像|影像|插圖|插图|照片|海報|海报)/su.test(
      prompt,
    ) ||
    /(?:圖片|图片|圖像|图像|影像|插圖|插图|照片|海報|海报).{0,30}(?:生成|產生|产生|建立|創作|创作|畫|画|繪製|绘制|製作|制作|做)/su.test(
      prompt,
    );
  // In an image-focused conversation users commonly shorten follow-ups to
  // "build <subject>". The answer has already confirmed that ChatGPT attempted
  // its image tool, so one bounded retry is still the intended operation.
  const shortBuildRequest = /^\s*build\s+\S(?:.{0,79})\s*$/isu.test(prompt);
  if (asksForImage || shortBuildRequest) return true;

  const asksToRetry =
    /^\s*(?:again|retry|try again|redo|one more(?: time)?|再一次|再試(?:一次)?|再试(?:一次)?|重試|重试|重新生成|直接生成|再生成一次)[\s.!！。?？]*$/iu.test(
      prompt,
    );
  if (!asksToRetry) return false;
  return (
    /(?:image|picture|photo|illustration|圖片|图片|圖像|图像|影像|插圖|插图|照片).{0,80}(?:failed|failure|error|unable|couldn|失敗|失败|錯誤|错误|無法|无法)/isu.test(
      previousAssistantText,
    ) ||
    /(?:failed|failure|error|unable|couldn|失敗|失败|錯誤|错误|無法|无法).{0,80}(?:image|picture|photo|illustration|圖片|图片|圖像|图像|影像|插圖|插图|照片)/isu.test(
      previousAssistantText,
    )
  );
}

function toolEnvelopeCandidate(text: string): string {
  return text
    .replace(INVISIBLE_PROTOCOL_CHARACTERS, "")
    .trimStart()
    .replace(/^`{3,}(?:json|xml|html|text)?\s*/iu, "")
    .trimStart()
    .toLowerCase();
}

function isCodexToolEnvelopeCandidate(text: string): boolean {
  const candidate = toolEnvelopeCandidate(text);
  if (!candidate.startsWith("<")) return false;
  return CODEX_TOOL_CALL_MARKERS.some(
    (marker) =>
      marker.open.startsWith(candidate) || candidate.startsWith(marker.open),
  );
}

/**
 * Prefer the source text from a rendered Markdown code block for the tagged tool protocol.
 * CommonMark consumes backslashes before quotes in ordinary prose, turning valid JSON such as
 * `\"file.txt\"` into invalid JSON before `innerText` reaches the bridge. Fenced code preserves
 * those escapes.
 */
export function chatGptAssistantText(
  renderedText: string,
  codeTexts: readonly string[],
): string {
  const lines: string[] = [];
  let fence: string | undefined;
  let mathEnd: string | undefined;
  for (const line of renderedText.replace(/\r\n?/gu, "\n").split("\n")) {
    const fenceRun = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      lines.push(line);
      const closingRun = fenceRun?.[1];
      if (
        closingRun &&
        closingRun[0] === fence[0] &&
        closingRun.length >= fence.length &&
        !fenceRun?.[2]?.trim()
      )
        fence = undefined;
      continue;
    }
    if (mathEnd) {
      lines.push(line);
      if (line.trim() === mathEnd) mathEnd = undefined;
      continue;
    }
    if (CHAT_GPT_TIMING_LINE.test(line.trim())) continue;
    if (fenceRun) fence = fenceRun[1];
    if (line.trim() === "\\[") mathEnd = "\\]";
    if (line.trim() === "$$") mathEnd = "$$";
    // Prose spacing can be normalized; code and TeX source must remain literal.
    if (line === "" && lines.at(-1) === "") continue;
    lines.push(line);
  }
  const cleaned = lines.join("\n").trim();
  const protocolCode = codeTexts.find(isCodexToolEnvelopeCandidate);
  if (protocolCode !== undefined) {
    // Some layouts place the language label outside pre. Only remove that
    // known chrome when the remaining answer is the standalone tool block.
    const standalone = cleaned
      .replace(
        /^(?:純文字|纯文本|純文本|plain\s*text|text|json|xml|html)[ \t]*\n\s*/iu,
        "",
      )
      .replace(/^(`{3,})(?:json|xml|html|text)?[ \t]*\n([\s\S]*?)\n\1$/iu, "$2")
      // Some current blocks have neither pre nor a language class, so the
      // DOM renderer preserves their source using inline-code delimiters.
      .replace(/^(`+)[ \t]?([\s\S]*?)[ \t]?\1$/u, "$2")
      .trim();
    const candidate = toolEnvelopeCandidate(standalone);
    if (
      isCodexToolEnvelopeCandidate(standalone) &&
      CODEX_TOOL_CALL_MARKERS.some(
        (marker) =>
          candidate.startsWith(marker.open) &&
          (candidate.indexOf(marker.close) === -1 ||
            candidate.endsWith(marker.close)),
      )
    )
      return protocolCode.trim();
  }
  return cleaned;
}

function hasIncompleteCodexToolEnvelope(text: string): boolean {
  const candidate = toolEnvelopeCandidate(text);
  if (!candidate.startsWith("<")) return false;
  if (
    "<codex_text>".startsWith(candidate) ||
    (candidate.startsWith("<codex_text>") &&
      !candidate.trimEnd().endsWith("</codex_text>"))
  )
    return true;

  for (const marker of CODEX_TOOL_CALL_MARKERS) {
    if (marker.open.startsWith(candidate)) return true;
    if (
      candidate.startsWith(marker.open) &&
      candidate.indexOf(marker.close, marker.open.length) === -1
    ) {
      return true;
    }
  }
  return false;
}

export class ChatGptCompletionTracker {
  reason = "awaiting-answer";
  #candidate:
    | {
        readonly signature: string;
        readonly since: number;
        readonly settleMs: number;
      }
    | undefined;

  constructor(
    private readonly settleMs = 2_000,
    private readonly actionlessSettleMs = 5_000,
  ) {
    if (settleMs < 0 || actionlessSettleMs < settleMs) {
      throw new Error(
        "Completion settle times must be non-negative and the actionless fallback must not be shorter.",
      );
    }
  }

  update(
    observation: ChatGptCompletionObservation,
    now = Date.now(),
  ): string | typeof CHAT_GPT_RICH_OUTPUT_ONLY | undefined {
    const hasText = observation.text.length > 0;
    const hasRenderableMedia = observation.hasRenderableMedia === true;
    const blocker = !observation.hasNewAssistant
      ? "awaiting-new-answer"
      : !hasText && !hasRenderableMedia
        ? "awaiting-content"
        : observation.mediaPending === true
          ? "media-pending"
          : observation.webNativeToolPresent === true ||
              observation.webNativeToolPending === true
            ? "web-tool-pending"
            : hasText && hasIncompleteCodexToolEnvelope(observation.text)
              ? "incomplete-frame"
              : !observation.terminalConfirmed &&
                  observation.responseBusy === true
                ? "generation-busy"
                : !observation.terminalConfirmed &&
                    observation.busy &&
                    !observation.completionActionVisible
                  ? "page-busy"
                  : undefined;
    if (blocker) {
      this.reason = blocker;
      this.#candidate = undefined;
      return undefined;
    }

    // Voice mode and other page-level activity can leave an unrelated busy marker visible after
    // the current answer has committed. ChatGPT's response actions are scoped to the latest turn,
    // so stable content plus a visible completion action is stronger evidence than global busy UI.

    // ChatGPT can expose completion controls before a streamed client-tool
    // envelope has received its closing tag. A stable partial envelope must
    // never be returned to the protocol parser as a prose-only answer.
    const signature = `${observation.userToken ?? ""}\0${observation.assistantToken ?? ""}\0${hasRenderableMedia ? "media" : "text"}\0${observation.text}\0${observation.html}`;
    // A successful, current-message end_turn whose full body matches the DOM
    // needs a second matching observation, not another fixed two-second pause
    // on every Codex tool round. Rich output still needs its render settle time.
    const confirmedText = observation.terminalConfirmed && !hasRenderableMedia;
    const requiredSettleMs = confirmedText
      ? 0
      : observation.completionActionVisible || observation.terminalConfirmed
        ? this.settleMs
        : this.actionlessSettleMs;
    if (
      this.#candidate?.signature !== signature ||
      this.#candidate.settleMs !== requiredSettleMs
    ) {
      this.#candidate = {
        signature,
        since: now,
        settleMs: requiredSettleMs,
      };
      this.reason = observation.terminalConfirmed
        ? "settling-confirmed-message"
        : "settling-dom";
      return undefined;
    }
    if (now - this.#candidate.since < this.#candidate.settleMs) {
      return undefined;
    }
    this.reason = observation.terminalConfirmed
      ? "completed-confirmed-message"
      : "completed-dom";
    return hasText ? observation.text : CHAT_GPT_RICH_OUTPUT_ONLY;
  }
}
