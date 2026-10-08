import type { ChatGptDomNode } from "./chatgpt-markdown.js";
import type { ChatGptGenerationWatch } from "./chatgpt-generation.js";

export interface ChatGptBusySource {
  readonly kind: "stop-control" | "aria-busy" | "streaming-surface";
  readonly scope:
    | "current-answer"
    | "earlier-answer"
    | "page"
    | "auxiliary"
    | "quoted"
    | "inactive";
  readonly owner: string;
  readonly blocking: boolean;
}

export interface ChatGptBrowserObservation {
  readonly assistantCount: number;
  readonly assistantToken: string;
  readonly userCount: number;
  readonly userToken: string;
  readonly logicalTurnIds: readonly string[];
  readonly renderedText: string;
  readonly codeTexts: readonly string[];
  readonly html: string;
  readonly hasRenderableMedia: boolean;
  readonly generatedImageUrls: readonly string[];
  readonly mediaPending: boolean;
  readonly busy: boolean;
  readonly responseBusy: boolean;
  readonly busySources: readonly ChatGptBusySource[];
  readonly assistantMessageId: string;
  readonly generationState: string;
  readonly streamSignal?: {
    readonly messageId: string;
    readonly text: string;
  } | null;
  readonly generationRequestCount: number;
  readonly terminalSignal: {
    readonly messageId: string;
    readonly text: string;
    readonly at: number;
  } | null;
  readonly webNativeToolPending: boolean;
  readonly webNativeToolPresent: boolean;
  readonly webNativeToolError: string;
  readonly completionActionVisible: boolean;
  readonly composer: boolean;
  readonly composerText: string;
  readonly error: string;
}

/** Runs in the renderer. Keep helpers inside so Function#toString is injectable. */
export function observeChatGpt(
  domToMarkdown: (root: ChatGptDomNode) => string,
): ChatGptBrowserObservation {
  const turnSelector =
    '[data-testid^="conversation-turn-"], [data-turn-id][data-message-author-role], [data-chatgpt-search-unit-key], [data-content-search-unit-key], [data-turn-key]';
  const modernUnitSelector =
    "[data-chatgpt-search-unit-key], [data-content-search-unit-key]";
  const entryRoles = new WeakMap<Element, string>();
  const turnRoot = (el: Element): Element => {
    const modern = el.closest(modernUnitSelector);
    if (modern) {
      return modern.closest("[data-chatgpt-search-unit-key]") ?? modern;
    }
    return (
      el.closest('[data-testid^="conversation-turn-"]') ??
      el.closest("[data-turn-id]") ??
      (el.matches("[data-user-message-bubble]")
        ? el
        : el.closest("[data-turn-key]")) ??
      el
    );
  };
  const visible = (element: Element): boolean => {
    if (!element.isConnected) return false;
    // Hidden WebContents may
    // have zero layout width. Ancestor rendering state, rather than geometry,
    // distinguishes a mounted answer from hidden or virtualized history.
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        node.hasAttribute("hidden") ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      )
        return false;
    }
    return true;
  };
  const inOrder = (left: Element, right: Element): number => {
    const position = left.compareDocumentPosition(right);
    return position & Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : position & Node.DOCUMENT_POSITION_PRECEDING
        ? 1
        : 0;
  };
  const after = (element: Element, anchor: Element): boolean =>
    Boolean(
      anchor.compareDocumentPosition(element) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  const entriesForRole = (role: string): Element[] => {
    const entries = new Set<Element>();
    // Canonicalize to the whole turn: images may be siblings of the role-tagged prose.
    for (const element of document.querySelectorAll(
      '[data-message-author-role="' +
        role +
        '"], [data-chatgpt-search-unit-key$=":' +
        role +
        '"], [data-content-search-unit-key$=":' +
        role +
        '"], [data-conversation-role="' +
        role +
        '"], [data-turn="' +
        role +
        '"]' +
        (role === "user"
          ? ", [data-user-message-bubble]"
          : ", [data-chatgpt-agent-turn-start]"),
    )) {
      entries.add(turnRoot(element));
    }
    for (const turn of document.querySelectorAll(turnSelector)) {
      const unitKey =
        turn.getAttribute("data-chatgpt-search-unit-key") ??
        turn.getAttribute("data-content-search-unit-key") ??
        "";
      const declaredRole =
        turn.getAttribute("data-message-author-role") ??
        turn
          .querySelector("[data-message-author-role]")
          ?.getAttribute("data-message-author-role") ??
        unitKey.match(/:([^:]+)$/u)?.[1];
      if (declaredRole && declaredRole !== role) continue;
      const generated =
        role === "assistant" &&
        turn.querySelector(
          '[data-testid^="image-gen-"], [class*="imagegen"], img[alt*="generated image" i], img[alt*="產生圖像"], img[alt*="生成图像"]',
        );
      if (
        declaredRole === role ||
        generated ||
        new RegExp("(?:^|-)" + role + "(?:$|-)", "i").test(
          turn.getAttribute("data-testid") ?? "",
        )
      ) {
        entries.add(turnRoot(turn));
      }
    }
    const ordered = [...entries].filter(visible).sort(inOrder);
    const grouped = new Map<Element, Element>();
    const legacy: Element[] = [];
    for (const entry of ordered) {
      const group = entry.closest("[data-turn-key]");
      if (group) grouped.set(group, entry);
      else legacy.push(entry);
    }
    // Activity commentary and a final answer can share a message id inside
    // one group. The last role-owned search unit is the current answer; two
    // separate groups with the same logical id still fail the ambiguity check.
    const result = [...legacy, ...grouped.values()].sort(inOrder);
    for (const entry of result) entryRoles.set(entry, role);
    return result;
  };
  const assistants = entriesForRole("assistant");
  const users = entriesForRole("user");
  const latestUser = users.at(-1);
  // Never fall back to an old image while the new response has not appeared yet.
  const current = latestUser
    ? assistants.filter(
        (entry) => after(entry, latestUser) || entry.contains(latestUser),
      )
    : assistants.slice(-1);
  // Native tool turns can be siblings of the assistant prose rather than nested in it.
  const currentTurns = latestUser
    ? [...document.querySelectorAll(turnSelector)]
        .filter(visible)
        .filter(
          (entry) => after(entry, latestUser) || entry.contains(latestUser),
        )
        .sort(inOrder)
    : current;
  const last = current.at(-1);
  const tokenWindow = window as unknown as {
    __codexgptBridgeTokens?: { next: number; values: WeakMap<Element, string> };
  };
  const tokens = (tokenWindow.__codexgptBridgeTokens ??= {
    next: 0,
    values: new WeakMap(),
  });
  const messageIdsOf = (element: Element | undefined): string[] => {
    if (!element) return [];
    const ids = new Set<string>();
    const inspect = (candidate: Element): void => {
      if (
        entryRoles.get(element) === "assistant" &&
        (candidate.closest("[data-user-message-bubble]") ||
          candidate.closest(
            '[data-chatgpt-search-unit-key$=":user"], [data-content-search-unit-key$=":user"]',
          ))
      )
        return;
      for (const attribute of [
        "data-message-id",
        "data-chatgpt-selection-message-id",
      ]) {
        const id = candidate.getAttribute(attribute)?.trim();
        if (id) ids.add(id);
      }
      for (const id of (
        candidate.getAttribute("data-chatgpt-search-message-ids") ?? ""
      ).split(/\s+/u)) {
        if (id) ids.add(id);
      }
    };
    inspect(element);
    for (const candidate of element.querySelectorAll(
      "[data-message-id], [data-chatgpt-selection-message-id], [data-chatgpt-search-message-ids]",
    ))
      inspect(candidate);
    return [...ids];
  };
  const tokenOf = (element: Element | undefined): string => {
    if (!element) return "";
    const groupKey = element
      .closest("[data-turn-key]")
      ?.getAttribute("data-turn-key");
    const role = entryRoles.get(element);
    if (groupKey && role) return `group:${role}:${groupKey}`;
    const logicalId =
      element.getAttribute("data-turn-id") ||
      element.closest("[data-turn-id]")?.getAttribute("data-turn-id") ||
      element.querySelector("[data-turn-id]")?.getAttribute("data-turn-id");
    if (logicalId) return "turn:" + logicalId;
    const messageIds = messageIdsOf(element);
    if (messageIds.length === 1) return "message:" + messageIds[0];
    // Display indices may be recycled or renumbered. Without a logical ID, only this
    // particular DOM node is known; never imply durable identity from its position.
    let token = tokens.values.get(element);
    if (!token) {
      token = "node:" + String(++tokens.next);
      tokens.values.set(element, token);
    }
    return token;
  };
  const logicalTurnIds = new Set<string>();
  for (const el of document.querySelectorAll(
    "[data-turn-id], [data-turn-id-container], [data-turn-key], [data-message-id], [data-chatgpt-selection-message-id], [data-chatgpt-search-message-ids]",
  )) {
    if (el.closest("pre, code")) continue;
    for (const attribute of [
      "data-turn-id",
      "data-turn-id-container",
      "data-turn-key",
      "data-message-id",
      "data-chatgpt-selection-message-id",
    ]) {
      const id = el.getAttribute(attribute);
      if (id)
        logicalTurnIds.add(
          (attribute === "data-message-id" ||
          attribute === "data-chatgpt-selection-message-id"
            ? "message:"
            : "turn:") + id,
        );
    }
    for (const id of (
      el.getAttribute("data-chatgpt-search-message-ids") ?? ""
    ).split(/\s+/u)) {
      if (id) logicalTurnIds.add("message:" + id);
    }
  }
  for (const group of document.querySelectorAll("[data-turn-key]")) {
    const key = group.getAttribute("data-turn-key");
    if (key) {
      logicalTurnIds.add(`group:user:${key}`);
      logicalTurnIds.add(`group:assistant:${key}`);
    }
  }
  const duplicateIdentity = [users, assistants].some((entries) => {
    const ids = entries.map(tokenOf).filter((id) => !id.startsWith("node:"));
    return new Set(ids).size !== ids.length;
  });
  const labels = (element: Element): string =>
    [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.textContent,
    ]
      .filter(Boolean)
      .join(" ");
  const buttons = [
    ...new Set(
      current.flatMap((entry) => [
        ...entry.querySelectorAll("button"),
        ...[
          ...(entry
            .closest("[data-turn-key]")
            ?.querySelectorAll(".turn-action-controls button") ?? []),
        ].filter((button) => after(button, entry)),
      ]),
    ),
  ].filter(visible);
  // Failed app surfaces may expose no tool test id, iframe, alert role or Retry
  // button. Find the error text itself, but require card/tool evidence so an
  // assistant explaining the same phrase is not mistaken for a failed app.
  const nativeErrorCards = new Set<Element>();
  const nativeTemplateErrorPattern =
    /Failed to fetch template|載入應用程式時發生錯誤|加载应用程序时发生错误|error (?:while )?loading (?:the )?(?:app|application)/iu;
  const nativeTemplateErrorLinePattern =
    /^(?:Failed to fetch template|載入應用程式時發生錯誤|加载应用程序时发生错误|error (?:while )?loading (?:the )?(?:app|application))[.!。！]?$/iu;
  const nativeTemplateErrorPairPattern =
    /(?:載入應用程式時發生錯誤|加载应用程序时发生错误|error (?:while )?loading (?:the )?(?:app|application))[\s\S]{0,200}Failed to fetch template|Failed to fetch template[\s\S]{0,200}(?:載入應用程式時發生錯誤|加载应用程序时发生错误|error (?:while )?loading (?:the )?(?:app|application))/iu;
  const retryControlPattern = /^(?:retry|try again|重試|重试)$/iu;
  const nativeErrorSurfaceSelector = [
    '[data-message-author-role="tool"]',
    '[data-testid*="tool" i]',
    '[data-testid*="connector" i]',
    '[data-testid*="plugin" i]',
    '[data-testid*="artifact" i]',
    '[data-testid*="canvas" i]',
    "[data-tool-id]",
    "[data-tool-name]",
    "[data-plugin-id]",
    "[data-connector-id]",
    '[role="alert"]',
  ].join(", ");
  const assistantMessageSurfaces = current.flatMap((entry) => [
    ...(entry.matches('[data-message-author-role="assistant"]') ? [entry] : []),
    ...entry.querySelectorAll(
      '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"], .markdown',
    ),
  ]);
  const isRetryControl = (element: Element): boolean =>
    [
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
    ].some((value) => retryControlPattern.test((value ?? "").trim()));
  const inspectNativeErrorCard = (marker: Element): void => {
    const outsideAssistantMessage = !assistantMessageSurfaces.some(
      (surface) => surface === marker || surface.contains(marker),
    );
    for (
      let parent: Element | null = marker, depth = 0;
      parent && depth < 8;
      parent = parent.parentElement, depth++
    ) {
      if (
        parent.matches("main, body") ||
        parent.querySelector("#prompt-textarea")
      )
        break;
      const clone = parent.cloneNode(true) as Element;
      clone
        .querySelectorAll(
          "pre, code, button, [role='button'], [aria-hidden='true']",
        )
        .forEach((element) => element.remove());
      const text = (clone.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text.length > 500) break;
      if (!nativeTemplateErrorPattern.test(text)) {
        if (parent.matches(turnSelector)) break;
        continue;
      }
      const retryControl = [
        ...(parent.matches("button, [role='button']") ? [parent] : []),
        ...parent.querySelectorAll("button, [role='button']"),
      ].some(isRetryControl);
      const nativeSurface = Boolean(
        parent.matches(nativeErrorSurfaceSelector) ||
        parent.closest(nativeErrorSurfaceSelector) ||
        parent.querySelector(nativeErrorSurfaceSelector),
      );
      if (
        retryControl ||
        nativeSurface ||
        (outsideAssistantMessage && nativeTemplateErrorPairPattern.test(text))
      ) {
        nativeErrorCards.add(parent);
        break;
      }
      if (parent.matches(turnSelector)) break;
    }
  };
  // Prefer direct text nodes. This avoids treating a long assistant explanation
  // containing the phrase as a native error while still finding a compact card.
  for (const marker of document.querySelectorAll(
    "strong, p, h1, h2, h3, h4, h5, h6, span, div, [role='alert'], [role='status']",
  )) {
    const directText = [...marker.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const surfaceText = marker.matches("[role='alert'], [role='status']")
      ? (marker.textContent ?? "").replace(/\s+/g, " ").trim()
      : directText;
    if (
      !nativeTemplateErrorLinePattern.test(surfaceText) &&
      !nativeTemplateErrorPairPattern.test(surfaceText)
    )
      continue;
    if (
      !visible(marker) ||
      marker.closest(
        "pre, code, aside, nav, [role='navigation'], [data-message-author-role='user']",
      ) ||
      (latestUser && !after(marker, latestUser))
    )
      continue;
    inspectNativeErrorCard(marker);
  }
  // Retain support for compact error cards whose only structural signal is a
  // Retry control, including controls implemented with role=button.
  for (const button of document.querySelectorAll("button, [role='button']")) {
    if (
      !visible(button) ||
      button.closest("pre, code, aside, nav, [role='navigation']") ||
      (latestUser && !after(button, latestUser)) ||
      !isRetryControl(button)
    )
      continue;
    inspectNativeErrorCard(button);
  }
  const webNativeToolError =
    nativeErrorCards.size > 0
      ? "ChatGPT app/template failed to load; no Codex client tool was executed from that response."
      : "";
  // Code-copy, image-copy and retry-tool buttons are NOT end-of-response signals.
  const completionActionVisible = [
    ...new Set([
      ...(last?.querySelectorAll("button") ?? []),
      ...[
        ...(last
          ?.closest("[data-turn-key]")
          ?.querySelectorAll(".turn-action-controls button") ?? []),
      ].filter((button) => !!last && after(button, last)),
    ]),
  ]
    .filter(visible)
    .some((button) => {
      if (
        button.closest(
          'pre, code, [data-testid^="image-gen-"], [class*="imagegen"]',
        )
      )
        return false;
      const id = button.getAttribute("data-testid") ?? "";
      return (
        /^(?:copy-(?:turn|response)(?:-action)?-button(?:-v\d+)?|(?:good|bad)-response(?:-turn)?-button|read-aloud-button|regenerate-response-button)$/.test(
          id,
        ) ||
        /^(?:copy response|copy message|regenerate response|read aloud|複製回覆|複製回應|复制回复|复制响应|朗讀|朗读)$/i.test(
          button.getAttribute("aria-label") ?? "",
        )
      );
    });
  const generatedImageUrls: string[] = [];
  const isContentImage = (image: HTMLImageElement): boolean => {
    if (!visible(image)) return false;
    // Citation favicons can have 256px intrinsic dimensions while rendered at 16px.
    // Intrinsic size is not evidence that an image belongs to the answer's media.
    if (
      image.closest('[data-testid*="citation"], [data-testid*="favicon"]') ||
      /(?:favicon|\/icon(?:s)?(?:\/|\?))/i.test(image.currentSrc || image.src)
    )
      return false;
    const rect = image.getBoundingClientRect();
    return rect.width >= 128 && rect.height >= 128;
  };
  let mediaPending = false;
  let hasRenderableMedia = false;
  for (const entry of current) {
    for (const image of entry.querySelectorAll("img")) {
      if (!isContentImage(image)) continue;
      hasRenderableMedia = true;
      if (!image.complete || image.naturalWidth === 0) {
        mediaPending = true;
        continue;
      }
      const source = image.currentSrc || image.src;
      if (source) generatedImageUrls.push(source);
      else mediaPending = true;
    }
    if ([...entry.querySelectorAll("video, canvas")].some(visible))
      hasRenderableMedia = true;
    // A generation container with no loaded image must not settle as timing/prose only.
    const containers = [
      ...entry.querySelectorAll(
        '[data-testid^="image-gen-"], [class*="imagegen"]',
      ),
    ].filter(visible);
    if (containers.length > 0) {
      hasRenderableMedia = true;
      if (
        !containers.some((container) =>
          [...container.querySelectorAll("img")].some(
            (img) =>
              isContentImage(img) && img.complete && img.naturalWidth > 0,
          ),
        )
      )
        mediaPending = true;
    }
  }
  hasRenderableMedia ||= buttons.some((button) =>
    /download image|save image|edit image|open image|下載圖片|下载图片|儲存圖片|保存图片|編輯圖片|编辑图片/i.test(
      labels(button),
    ),
  );
  const source = document.createElement("div");
  for (const entry of current) {
    if (entry.matches("[data-turn-key]")) {
      const activity = [
        ...entry.querySelectorAll("[data-chatgpt-agent-turn-start]"),
      ].map((marker) => marker.parentElement);
      const answerSelector =
        '.markdown, [data-markdown-text-style="assistant-message"], .puik-root.not-markdown > [class*="_DilResponseRoot"]';
      const answerRoots = [...entry.querySelectorAll(answerSelector)].filter(
        (root) =>
          !root.parentElement?.closest(answerSelector) &&
          !root.closest(
            '[data-user-message-bubble], [data-streaming-response-status], [data-testid^="cot-v5"]',
          ) &&
          !activity.some((container) => container?.contains(root)),
      );
      if (answerRoots.length) {
        for (const root of answerRoots) source.append(root.cloneNode(true));
        continue;
      }
    }
    source.append(entry.cloneNode(true));
  }
  for (const marker of source.querySelectorAll(
    "[data-chatgpt-agent-turn-start]",
  ))
    marker.parentElement?.remove();
  source
    .querySelectorAll(
      'button, [data-user-message-bubble], [data-streaming-response-status], [data-testid^="cot-v5"], [data-testid^="image-gen-overlay"], .sr-only, [class*="sr-only"], [aria-hidden="true"]',
    )
    .forEach((element) => element.remove());
  const webNativeToolPending =
    /waiting for (?:a )?tool result|waiting for tool|等待工具結果|等待工具结果|正在等待工具/i.test(
      source.textContent ?? "",
    );
  const supportedImageSurface =
    '[data-testid^="image-gen-"], [class*="imagegen"]';
  const nativeToolSurfaceSelector = [
    '[data-message-author-role="tool"]',
    '[data-testid*="tool-call" i]',
    '[data-testid*="tool_call" i]',
    '[data-testid*="tool-result" i]',
    '[data-testid*="tool_result" i]',
    '[data-testid*="connector" i]',
    '[data-testid*="plugin" i]',
    '[data-testid*="artifact" i]',
    '[data-testid*="canvas" i]',
    "[data-tool-id]",
    "[data-tool-name]",
    "[data-plugin-id]",
    "[data-connector-id]",
    "iframe",
    "a[download]",
  ].join(", ");
  const webNativeToolPresent =
    webNativeToolError.length > 0 ||
    webNativeToolPending ||
    currentTurns.some((entry) =>
      [
        ...(entry.matches(nativeToolSurfaceSelector) ? [entry] : []),
        ...entry.querySelectorAll(nativeToolSurfaceSelector),
      ].some(
        (element) =>
          visible(element) &&
          !element.closest(supportedImageSurface) &&
          !element.closest(
            'pre, code, [data-testid*="citation"], [data-testid*="favicon"]',
          ),
      ),
    );
  // Keep the source and message ownership of each busy marker. A whole-page
  // stop control is ambiguous, while a busy marker in an old turn is unrelated.
  const busySources: ChatGptBusySource[] = [];
  const stopSelector =
    '[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"]';
  for (const element of document.querySelectorAll(
    stopSelector +
      ', [aria-busy="true"], [data-testid*="streaming"], [data-is-streaming="true"]',
  )) {
    if (!visible(element)) continue;
    const turn =
      element.closest(turnSelector) ??
      element.closest("[data-message-author-role]");
    const kind: ChatGptBusySource["kind"] = element.matches(stopSelector)
      ? "stop-control"
      : element.getAttribute("aria-busy") === "true"
        ? "aria-busy"
        : "streaming-surface";
    const auxiliary = element.closest(
      '[data-testid*="voice" i], [data-testid*="citation" i], [data-testid*="favicon" i]',
    );
    const scope: ChatGptBusySource["scope"] = element.closest("pre, code")
      ? "quoted"
      : auxiliary
        ? "auxiliary"
        : kind === "streaming-surface" &&
            (element.getAttribute("data-is-streaming") === "false" ||
              element.getAttribute("data-state") === "complete")
          ? "inactive"
          : turn
            ? current.some(
                (entry) =>
                  entry === turn ||
                  entry.contains(turn) ||
                  (entry.closest("[data-turn-key]") &&
                    entry.closest("[data-turn-key]") ===
                      turn.closest("[data-turn-key]")),
              )
              ? "current-answer"
              : "earlier-answer"
            : "page";
    const blocking =
      scope === "current-answer" ||
      (scope === "page" && kind === "stop-control");
    // Identifiers only: do not persist arbitrary labels or content from the page.
    busySources.push({
      kind,
      scope,
      owner: turn ? tokenOf(turn) : "page",
      blocking,
    });
  }
  const responseBusy = busySources.some((source) => source.blocking);
  const messageIds = messageIdsOf(last);
  const assistantMessageId = messageIds.length === 1 ? messageIds[0]! : "";
  const generation = (
    window as unknown as { __cgbGenerationWatch?: ChatGptGenerationWatch }
  ).__cgbGenerationWatch?.active;
  const latestGenerationMessage = generation?.messages.at(-1);
  const terminal =
    generation?.state === "observing" &&
    assistantMessageId &&
    latestGenerationMessage?.id === assistantMessageId &&
    latestGenerationMessage.finishedAt !== null
      ? latestGenerationMessage
      : undefined;
  const composer = document.querySelector(
    '#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]',
  );
  const alerts = [...document.querySelectorAll('[role="alert"]')]
    .filter(visible)
    .filter((entry) => {
      if (entry.closest("pre, code")) return false;
      const turn = entry.closest(turnSelector);
      if (turn && !currentTurns.includes(turn)) return false;
      return ![...nativeErrorCards].some(
        (card) => card.contains(entry) || entry.contains(card),
      );
    })
    .map((entry) => entry.textContent?.trim() ?? "");
  const uniqueUrls = [...new Set(generatedImageUrls)];
  const stableImageUrls = uniqueUrls.map((value) => {
    try {
      const url = new URL(value, location.href);
      const id = url.searchParams.get("id");
      return id
        ? `${url.origin}${url.pathname}?id=${encodeURIComponent(id)}`
        : `${url.origin}${url.pathname}`;
    } catch {
      return value;
    }
  });
  const renderedText = domToMarkdown(source);
  return {
    assistantCount: assistants.length,
    assistantToken: tokenOf(last),
    userCount: users.length,
    userToken: tokenOf(latestUser),
    logicalTurnIds: [...logicalTurnIds],
    renderedText,
    // Modern blocks can omit both pre and language classes. Tagged JSON is
    // also a source candidate, but a mere inline mention of the opening tag
    // must remain prose. The caller requires a standalone answer before use.
    codeTexts: [...source.querySelectorAll("code")]
      .filter(
        (entry) =>
          entry.closest("pre") !== null ||
          entry.closest('[data-markdown-copy="code-block"]') !== null ||
          /[\r\n]/u.test(entry.textContent ?? "") ||
          /(?:^|\s)language-[^\s]+/u.test(entry.className) ||
          /^\s*<codex_tool_calls?>\s*[[{]/u.test(entry.textContent ?? ""),
      )
      .map((entry) => entry.textContent?.trim() ?? "")
      .filter(Boolean),
    // Semantic signature: spinner styles, elapsed-time labels and signed-URL churn in unrelated
    // controls must not indefinitely restart the settle timer.
    html: JSON.stringify({ images: stableImageUrls }),
    hasRenderableMedia,
    generatedImageUrls: uniqueUrls,
    mediaPending,
    busy: responseBusy || webNativeToolPending,
    responseBusy,
    busySources: busySources.slice(0, 32),
    assistantMessageId,
    generationState: generation?.state ?? "unavailable",
    streamSignal:
      generation?.state === "observing" &&
      assistantMessageId &&
      latestGenerationMessage?.id === assistantMessageId &&
      latestGenerationMessage.role === "assistant" &&
      latestGenerationMessage.recipient === "all" &&
      ["", "final"].includes(latestGenerationMessage.channel)
        ? { messageId: assistantMessageId, text: latestGenerationMessage.text }
        : null,
    generationRequestCount:
      (window as unknown as { __cgbGenerationWatch?: ChatGptGenerationWatch })
        .__cgbGenerationWatch?.requestCount ?? 0,
    terminalSignal: terminal
      ? {
          messageId: terminal.id,
          text: terminal.text,
          at: terminal.finishedAt!,
        }
      : null,
    webNativeToolPending,
    webNativeToolPresent,
    webNativeToolError,
    completionActionVisible,
    composer: Boolean(composer),
    composerText:
      composer instanceof HTMLTextAreaElement ||
      composer instanceof HTMLInputElement
        ? composer.value
        : (composer?.textContent ?? ""),
    error: duplicateIdentity
      ? "ChatGPT exposed duplicate logical message identities; response binding is ambiguous."
      : (alerts.find((text) =>
          /error|failed|try again|rate limit|錯誤|失敗|重試|稍後/i.test(text),
        ) ?? ""),
  };
}
