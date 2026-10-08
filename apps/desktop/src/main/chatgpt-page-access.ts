export type ChatGptPageBlock =
  "cloudflare-challenge" | "rate-limit" | "pin-limit" | null;
export type ChatGptServerSessionNotice =
  "session-expired" | "subscription-unavailable" | null;

/** A transient blank document is not proof that verification completed. */
export function observeChatGptChallengeReadiness(
  observeBlock: () => ChatGptPageBlock,
): { readonly blocked: ChatGptPageBlock; readonly ready: boolean } {
  const blocked = observeBlock();
  if (blocked === "cloudflare-challenge") return { blocked, ready: false };
  const ready = [
    ...document.querySelectorAll(
      '#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]',
    ),
  ].some((element) => {
    if (
      !element.isConnected ||
      element.matches(':disabled, [aria-disabled="true"]') ||
      element.closest('[inert], [aria-hidden="true"]')
    )
      return false;
    for (
      let ancestor: Element | null = element;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      const style = getComputedStyle(ancestor);
      if (
        ancestor.hasAttribute("hidden") ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      )
        return false;
    }
    return true;
  });
  return { blocked, ready };
}

/** Dismiss only ChatGPT's exact request-frequency dialog. */
export function acknowledgeChatGptRateLimitDialog(): boolean {
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      element.isConnected &&
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      !element.closest(
        '[inert], [aria-hidden="true"], [data-message-author-role], [data-testid^="conversation-turn-"], pre, code',
      )
    );
  };
  const normalize = (value: string | null): string =>
    (value || "").trim().replace(/\s+/g, " ");
  const titlePattern =
    /too many requests|\u592a\u591a(?:\u8981\u6c42|\u8acb\u6c42|\u8bf7\u6c42)|\u8acb\u6c42\u904e\u591a|\u8bf7\u6c42\u8fc7\u591a|\u30ea\u30af\u30a8\u30b9\u30c8\u304c\u591a\u3059\u304e\u307e\u3059/i;
  const explanationPattern =
    /making requests too quickly|(?:\u8981\u6c42|\u8acb\u6c42|\u8bf7\u6c42).{0,16}(?:\u904e\u65bc\u983b\u7e41|\u8fc7\u4e8e\u9891\u7e41)|temporarily limited access to (?:your )?conversations|\u66ab\u6642\u9650\u5236.{0,24}\u5c0d\u8a71\u5b58\u53d6\u6b0a\u9650|\u6682\u65f6\u9650\u5236.{0,24}\u5bf9\u8bdd\u8bbf\u95ee\u6743\u9650|\u30ea\u30af\u30a8\u30b9\u30c8\u306e\u983b\u5ea6\u304c\u9ad8\u3059\u304e\u307e\u3059/i;
  const dialogs = [
    ...document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"]',
    ),
  ].filter(
    (element) =>
      visible(element) &&
      titlePattern.test(normalize(element.textContent)) &&
      explanationPattern.test(normalize(element.textContent)),
  );
  const acknowledgePattern = /^(?:Got it|\u77e5\u9053\u4e86|\u4e86\u89e3)$/i;
  const semanticAction = [...dialogs]
    .reverse()
    .flatMap((dialog) => [
      ...dialog.querySelectorAll('button, [role="button"]'),
    ])
    .filter(visible)
    .find((element) => acknowledgePattern.test(normalize(element.textContent)));
  if (semanticAction instanceof HTMLElement) {
    semanticAction.click();
    return true;
  }

  // ChatGPT has also shipped this modal without dialog semantics. Anchor the
  // fallback on its exact acknowledgement action and require both the title
  // and explanatory copy in one bounded visible ancestor.
  const acknowledge = [...document.querySelectorAll('button, [role="button"]')]
    .filter(visible)
    .filter((element) =>
      acknowledgePattern.test(normalize(element.textContent)),
    )
    .find((element) => {
      let ancestor = element.parentElement;
      for (let depth = 0; ancestor && depth < 8; depth += 1) {
        if (!visible(ancestor)) return false;
        const text = normalize(ancestor.textContent);
        if (
          text.length <= 1_500 &&
          titlePattern.test(text) &&
          explanationPattern.test(text)
        )
          return true;
        if (ancestor === document.body) break;
        ancestor = ancestor.parentElement;
      }
      return false;
    });
  if (!(acknowledge instanceof HTMLElement)) return false;
  acknowledge.click();
  return true;
}

/** Inspect application notices, never quoted messages or screenshot contents. */
export function observeChatGptPageBlock(): ChatGptPageBlock {
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      element.isConnected &&
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  };
  const challengePath = /\/cdn-cgi\/(?:challenge-platform|images\/trace)/i.test(
    location.pathname,
  );
  const challengeTitle =
    /^(?:just a moment|attention required|security verification|performing security verification|請稍候|请稍候)[.!。…\s-]*$/i.test(
      document.title.trim(),
    );
  const challengeMarker = [
    ...document.querySelectorAll(
      '#challenge-running, #challenge-stage, #cf-chl-widget, [id^="cf-chl-widget-"], .cf-challenge, iframe[src*="challenges.cloudflare.com"]',
    ),
  ].some(visible);
  if (challengePath || challengeTitle || challengeMarker)
    return "cloudflare-challenge";

  const notices = [
    ...document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], [role="alert"], [aria-modal="true"]',
    ),
  ]
    .filter((element) => {
      return (
        visible(element) &&
        !element.closest(
          '[inert], [aria-hidden="true"], [data-message-author-role], [data-testid^="conversation-turn-"], pre, code',
        )
      );
    })
    .map((element) => (element.textContent || "").trim().replace(/\s+/g, " "));
  const fallbackNotices = [
    ...document.querySelectorAll('button, [role="button"]'),
  ]
    .filter((element) => {
      return (
        visible(element) &&
        /^(?:Got it|\u77e5\u9053\u4e86|\u4e86\u89e3)$/i.test(
          (element.textContent || "").trim(),
        ) &&
        !element.closest(
          '[inert], [aria-hidden="true"], [data-message-author-role], [data-testid^="conversation-turn-"], pre, code',
        )
      );
    })
    .flatMap((element) => {
      const matches: string[] = [];
      let ancestor = element.parentElement;
      for (let depth = 0; ancestor && depth < 8; depth += 1) {
        if (!visible(ancestor)) break;
        const text = (ancestor.textContent || "").trim().replace(/\s+/g, " ");
        if (text.length <= 1_500) matches.push(text);
        if (ancestor === document.body) break;
        ancestor = ancestor.parentElement;
      }
      return matches;
    });
  if (
    [...notices, ...fallbackNotices].some((text) =>
      /too many requests|rate[ -]?limit|making requests too quickly|temporarily limited access to (?:your )?conversations|\u592a\u591a(?:\u8981\u6c42|\u8acb\u6c42|\u8bf7\u6c42)|(?:\u8981\u6c42|\u8acb\u6c42|\u8bf7\u6c42).{0,12}(?:\u904e\u65bc\u983b\u7e41|\u8fc7\u4e8e\u9891\u7e41)|\u8acb\u6c42\u904e\u591a|\u8bf7\u6c42\u8fc7\u591a|\u8acb\u6c42\u904e\u65bc\u983b\u7e41|\u8bf7\u6c42\u8fc7\u4e8e\u9891\u7e41/i.test(
        text,
      ),
    )
  )
    return "rate-limit";
  if (
    notices.some((text) =>
      /(?:only|maximum|up to|at most).{0,40}(?:pin|pinned)|pin.{0,40}(?:limit|maximum)|\u6700\u591a\u53ea\u80fd\u91d8\u9078|\u6700\u591a\u53ea\u80fd\u9489\u9009/i.test(
        text,
      ),
    )
  )
    return "pin-limit";
  return null;
}

/** Inspect only server-originated application notices, never conversation text. */
export function observeChatGptServerSessionNotice(): ChatGptServerSessionNotice {
  const notices = [
    ...document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], [role="alert"], [aria-modal="true"]',
    ),
  ]
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        element.isConnected &&
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        !element.closest(
          '[inert], [aria-hidden="true"], [data-message-author-role], [data-testid^="conversation-turn-"], pre, code',
        )
      );
    })
    .map((element) => (element.textContent || "").trim().replace(/\s+/g, " "));
  if (
    notices.some((text) =>
      /your session has expired|session expired.{0,40}(?:log|sign) in|工作階段已過期|工作階段已失效|会话已过期|會話已過期|登入階段已過期|登录会话已过期/iu.test(
        text,
      ),
    )
  ) {
    return "session-expired";
  }
  if (
    notices.some((text) =>
      /failed to load (?:your )?subscription|unable to load (?:your )?subscription|無法載入訂閱|无法加载订阅/iu.test(
        text,
      ),
    )
  ) {
    return "subscription-unavailable";
  }
  return null;
}
export class ChatGptVerificationRequiredError extends Error {
  readonly code = "chatgpt_web_verification_required";
  constructor() {
    super(
      "Cloudflare verification requires your action in the existing Chrome tab. Complete it there, then choose Continue in Bridge. Bridge will not open another tab or retry this request automatically.",
    );
    this.name = "ChatGptVerificationRequiredError";
  }
}
