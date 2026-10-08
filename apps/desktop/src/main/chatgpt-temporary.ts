/** Pure URL and rendered-UI checks. A URL flag alone is not proof of Temporary Chat. */
export function temporaryChatUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!["https:", "http:"].includes(url.protocol))
    throw new Error("Temporary Chat requires a Web origin.");
  return new URL("/?temporary-chat=true", url.origin).href;
}

export function isTemporaryChatUrl(current: string, baseUrl: string): boolean {
  try {
    const url = new URL(current);
    return (
      url.origin === new URL(baseUrl).origin &&
      url.pathname === "/" &&
      url.searchParams.get("temporary-chat") === "true" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/** Injected renderer function: only header controls, never conversation prose. */
export function observeTemporaryChat(): {
  active: boolean;
  inactive: boolean;
  ambiguous: boolean;
  unpersonalized: boolean;
  documentToken: string;
} {
  // A renderer nonce survives SPA navigation but not reloads or replacement.
  // It carries no conversation data and is never persisted by the controller.
  const host = window as Window & {
    __codexgptBridgeTemporaryDocumentToken?: string;
  };
  const documentToken = (host.__codexgptBridgeTemporaryDocumentToken ??=
    crypto.randomUUID());
  const buttons = [
    ...document.querySelectorAll("#page-header button, header button"),
  ].filter((el) => {
    const r = el.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      getComputedStyle(el).visibility !== "hidden" &&
      !el.closest('[inert], [aria-hidden="true"], [data-message-author-role]')
    );
  });
  const label = (el: Element): string =>
    (el.getAttribute("aria-label") || el.textContent || "").trim();
  // Observed ChatGPT header sprites encode the state without translated text.
  // Both sprites stay mounted; the inactive one has opacity: 0. SVGs are
  // aria-hidden for accessibility, so check rendered visibility, not aria-hidden.
  const visibleIcon = (use: Element, button: Element): boolean => {
    const svg = use.closest("svg");
    if (!svg) return false;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let node: Element | null = use; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        style.display === "none" ||
        style.visibility !== "visible" ||
        Number(style.opacity) === 0
      )
        return false;
      if (node === button) return true;
    }
    return false;
  };
  const states = buttons.map((button) => {
    const uses = [...button.querySelectorAll("svg use")];
    const shown = (fragment: string): boolean =>
      uses.some(
        (use) =>
          (
            use.getAttribute("href") ||
            use.getAttribute("xlink:href") ||
            ""
          ).split("#")[1] === fragment && visibleIcon(use, button),
      );
    const on = shown("chat-temp-checked");
    const off = shown("chat-temp");
    if (on || off) return { active: on && !off, inactive: off };
    return {
      active:
        /^(Turn off temporary chat|關閉暫存對話|關閉暫時聊天|關閉臨時聊天|关闭临时聊天)$/i.test(
          label(button),
        ),
      inactive:
        /^(Turn on temporary chat|開啟暫存對話|開啟暫時聊天|开启临时聊天)$/i.test(
          label(button),
        ),
    };
  });
  return {
    active:
      states.filter((state) => state.active).length === 1 &&
      !states.some((state) => state.inactive),
    inactive: states.some((state) => state.inactive),
    ambiguous:
      states.filter((state) => state.active || state.inactive).length > 1,
    unpersonalized: buttons.some((el) =>
      /^(Unpersonalized|非個人化|未個人化|非个性化|未个性化)$/i.test(label(el)),
    ),
    documentToken,
  };
}
