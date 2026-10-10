export type ModelMenuKind =
  | "closed"
  | "loading"
  | "slider"
  | "plain"
  | "configure-entry"
  | "configure"
  | "models";

/** Injected into the page. Classify readiness without clicking or reading messages. */
export function observeModelMenu(
  resolveRoots?: () => readonly Element[],
): ModelMenuKind {
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      element.isConnected &&
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      !element.closest(
        '[inert], [aria-hidden="true"], aside, nav, [role="navigation"], [data-testid*="sidebar"], [data-message-author-role], pre, code',
      )
    );
  };
  const label = (element: Element): string =>
    (element.textContent || element.getAttribute("aria-label") || "")
      .trim()
      .replace(/\s+/g, " ");
  const all = (selector: string): Element[] =>
    [...document.querySelectorAll(selector)].filter(visible);
  if (
    all('[role="dialog"], [data-testid="model-configure-modal"]').some(
      (element) =>
        /Intelligence|智慧|智能/i.test(label(element)) &&
        /Model|模型/i.test(label(element)),
    )
  )
    return "configure";
  const roots = resolveRoots
    ? [...resolveRoots()]
    : all(
        '[role="menu"], [role="listbox"], [data-testid="composer-intelligence-picker-content"]',
      );
  if (!roots.length) return "closed";
  const elements = [
    ...new Set(
      roots.flatMap((root) => [...root.querySelectorAll("*")].filter(visible)),
    ),
  ];
  const ordinalState = (text: string): boolean => {
    const normalized = text.replace(/\s+/gu, " ").trim();
    const match =
      /第\s*(\d+)\s*(?:個|个|項|项)[，,\s]*共\s*(\d+)\s*(?:個|个|項|项)/u.exec(
        normalized,
      ) ??
      /(?:position\s*)?(\d+)\s*(?:of|out of|\/)\s*(\d+)/iu.exec(normalized);
    if (!match) return false;
    const position = Number(match[1]);
    const count = Number(match[2]);
    return (
      Number.isSafeInteger(position) &&
      Number.isSafeInteger(count) &&
      count >= 2 &&
      count <= 5 &&
      position >= 1 &&
      position <= count
    );
  };
  // Hidden numeric state belongs to a visible keyboard proxy. A hidden slider
  // elsewhere, or an arrow-key menu item without slider state, is not evidence.
  if (
    elements.some((element) =>
      element.matches('[role="slider"], input[type="range"]'),
    ) ||
    elements.some((element) => {
      if (
        !(element instanceof HTMLElement) ||
        !element.matches('[role="menuitem"]')
      )
        return false;
      const keys = (element.getAttribute("aria-keyshortcuts") ?? "").split(
        /\s+/,
      );
      return (
        keys.includes("ArrowLeft") &&
        keys.includes("ArrowRight") &&
        // Roving menu items remain programmatically focusable at tabindex=-1.
        (element.tabIndex >= 0 ||
          (element.tabIndex === -1 && element.hasAttribute("tabindex"))) &&
        [
          ...element.querySelectorAll('[role="slider"][aria-hidden="true"]'),
        ].some(
          (slider) =>
            slider.parentElement?.closest('[role="menuitem"]') === element &&
            !slider.closest("[inert]") &&
            ["aria-valuemin", "aria-valuemax", "aria-valuenow"].every(
              (attribute) => slider.hasAttribute(attribute),
            ),
        )
      );
    }) ||
    roots.some((root) => {
      const proxies = [...root.querySelectorAll('[role="menuitem"]')].filter(
        (element) => {
          if (!(element instanceof HTMLElement) || !visible(element))
            return false;
          const keys = (element.getAttribute("aria-keyshortcuts") ?? "").split(
            /\s+/,
          );
          return keys.includes("ArrowLeft") && keys.includes("ArrowRight");
        },
      );
      if (proxies.length !== 1) return false;
      const statuses = [
        ...proxies[0]!.querySelectorAll('[role="status"], [aria-live]'),
        ...root.querySelectorAll('[role="status"], [aria-live]'),
      ];
      return statuses.some((status) => ordinalState(status.textContent ?? ""));
    })
  )
    return "slider";
  if (
    elements.some(
      (element) =>
        element.getAttribute("data-testid") === "model-configure-modal" ||
        /^(?:Configure(?:\.{3}|\u2026)|設定|设置|配置)$/i.test(label(element)),
    )
  )
    return "configure-entry";
  const efforts = elements.filter(
    (element) =>
      element.matches(
        '[role="menuitem"], [role="menuitemradio"], [role="option"]',
      ) &&
      /^(?:Instant|Light|Low|Medium|High|Extra[- ]High|XHigh|Pro|低|中|中等|高|極高|极高)$/i.test(
        label(element),
      ),
  );
  // A lone Pro option can precede a lazily mounted slider; it is not a plain effort menu.
  if (efforts.length >= 2) return "plain";

  const modelItems = elements.filter(
    (element) =>
      element.matches(
        '[role="menuitem"], [role="menuitemradio"], [role="option"]',
      ) &&
      /^(?:GPT[-\s]?\d|\d+(?:\.\d+)*|o\d|Latest|最新(?:的模型|模型|的)?)/i.test(
        label(element),
      ),
  );
  if (modelItems.length >= 1) return "models";

  return "loading";
}
