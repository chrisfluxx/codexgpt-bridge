/** Injected into the page. Only a model control may supply a mouse target. */
export function composerModelControlTarget(
  focus = false,
):
  | { readonly x: number; readonly y: number; readonly expanded: boolean }
  | undefined {
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
        '[inert], [aria-hidden="true"], aside, nav, [role="navigation"], [data-testid*="sidebar"], [data-message-author-role], pre, code, [role="menu"], [role="dialog"], [role="alertdialog"]',
      )
    );
  };
  const composer = [
    ...document.querySelectorAll(
      '#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]',
    ),
  ].find(visible);
  if (!composer) return undefined;
  const rect = composer.getBoundingClientRect();
  const form = composer.closest("form");
  const nearComposer = (element: Element): boolean => {
    const control = element.getBoundingClientRect();
    const nearByGeometry =
      control.top >= rect.top - 48 &&
      control.bottom <= rect.bottom + 80 &&
      control.left >= rect.left - 24 &&
      control.right <= rect.right + 160;
    return Boolean(form?.contains(element) || nearByGeometry);
  };
  const modeLabel =
    /^(?:Extended Pro|Pro Extended|Pro|Thinking|Instant|Medium|High|Extra[- ]High|XHigh|Low|Light|Standard|Extended|Heavy|(?:Light|Standard|Extended|Heavy)\s+(?:Pro|Thinking)|(?:Instant|Thinking|Pro)\s*[\u2022\u00b7]?\s*(?:Light|Standard|Extended|Heavy)|(?:GPT[-\s]*)?\d+(?:\.\d+)*(?:\s+(?:Sol|Astra))?\s*(?:Instant|Thinking|Pro|Medium|High|Extra High|即時|即时|低|中等|中|高|極高|极高)(?:\s+(?:Light|Standard|Extended|Heavy))?|\u5373\u6642|\u5373\u65f6|\u4f4e|\u4e2d|\u4e2d\u7b49|\u9ad8|\u6975\u9ad8|\u6781\u9ad8)$/i;
  const buttons = [
    ...document.querySelectorAll<HTMLElement>('button, [role="button"]'),
  ].filter(
    (button) =>
      visible(button) &&
      !(button instanceof HTMLButtonElement && button.disabled) &&
      button.getAttribute("aria-disabled") !== "true" &&
      !/\b(?:pin|unpin)\b|\u91d8\u9078|\u9489\u9009/i.test(
        [
          button.getAttribute("aria-label"),
          button.title,
          button.getAttribute("data-testid"),
        ].join(" "),
      ),
  );
  const dedicated = buttons.filter((button) =>
    /^(?:model-switcher-dropdown-button|composer-model-picker-button)$/.test(
      button.getAttribute("data-testid") || "",
    ),
  );
  const candidates = dedicated.length
    ? dedicated
    : buttons.filter(
        (button) =>
          nearComposer(button) &&
          (["menu", "dialog", "listbox"].includes(
            button.getAttribute("aria-haspopup") || "",
          ) ||
            Boolean(button.getAttribute("aria-controls"))) &&
          (modeLabel.test(
            (button.innerText || button.textContent || "")
              .trim()
              .replace(/\s+/g, " "),
          ) ||
            /^(?:(?:Reasoning|Thinking) (?:effort|strength)|Intelligence|\u63a8\u7406\u5f37\u5ea6|\u63a8\u7406\u5f3a\u5ea6)$/i.test(
              (
                button.innerText ||
                button.textContent ||
                button.getAttribute("aria-label") ||
                ""
              ).trim(),
            )),
      );
  if (candidates.length !== 1) return undefined;
  const target = candidates[0]!;
  const bounds = target.getBoundingClientRect();
  const x = Math.round(bounds.left + bounds.width / 2);
  const y = Math.round(bounds.top + bounds.height / 2);
  const hit = document.elementFromPoint(x, y);
  // An overlay can cover a visible control. Never click whatever occupies its coordinates.
  if (!hit || !target.contains(hit)) return undefined;
  if (focus) {
    if (target.tabIndex < 0) return undefined;
    target.focus({ preventScroll: true });
    if (document.activeElement !== target) return undefined;
  }
  return {
    x,
    y,
    expanded:
      target.getAttribute("aria-expanded") === "true" ||
      target.getAttribute("data-state") === "open",
  };
}
