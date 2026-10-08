/** Page-local ownership of model popovers, including portal and contents wrappers. */
export function modelPickerRoots(): Element[] {
  const excluded =
    '[inert], [aria-hidden="true"], aside, nav, [role="navigation"], [data-testid*="sidebar"], [data-message-author-role], pre, code';
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      element.isConnected &&
      !element.closest(excluded) &&
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  };
  const rendered = (element: Element): boolean => {
    if (element.closest(excluded)) return false;
    return visible(element) || [...element.querySelectorAll("*")].some(visible);
  };
  const composer = [
    ...document.querySelectorAll(
      '#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [data-composer-markdown][contenteditable="true"]',
    ),
  ].find(visible);
  const form = composer?.closest("form");
  const bounds = composer?.getBoundingClientRect();
  const roots = new Set(
    [
      ...document.querySelectorAll(
        '[role="menu"], [role="listbox"], [data-testid="composer-intelligence-picker-content"]',
      ),
    ].filter(rendered),
  );
  for (const button of document.querySelectorAll(
    'button[aria-controls], [role="button"][aria-controls]',
  )) {
    if (!visible(button)) continue;
    const rect = button.getBoundingClientRect();
    const nearByGeometry =
      bounds &&
      rect.top >= bounds.top - 48 &&
      rect.bottom <= bounds.bottom + 80 &&
      rect.left >= bounds.left - 24 &&
      rect.right <= bounds.right + 160;
    const nearComposer = Boolean(form?.contains(button) || nearByGeometry);
    const dedicated =
      /^(?:model-switcher-dropdown-button|composer-model-picker-button)$/.test(
        button.getAttribute("data-testid") || "",
      );
    const name = (
      button.textContent ||
      button.getAttribute("aria-label") ||
      ""
    ).trim();
    const modelControl =
      /^(?:Instant|Light|Low|Medium|High|Extra[- ]High|XHigh|Pro|Thinking|Reasoning (?:effort|strength)|Intelligence|\u63a8\u7406\u5f37\u5ea6|\u63a8\u7406\u5f3a\u5ea6|\u5373\u6642|\u5373\u65f6|\u4f4e|\u4e2d|\u4e2d\u7b49|\u9ad8|\u6975\u9ad8|\u6781\u9ad8)$/i.test(
        name,
      );
    if (!dedicated && !(nearComposer && modelControl)) continue;
    if (
      /\b(?:pin|unpin)\b|\u91d8\u9078|\u9489\u9009/i.test(
        button.getAttribute("aria-label") || "",
      )
    )
      continue;
    for (const id of (button.getAttribute("aria-controls") || "").split(
      /\s+/,
    )) {
      const root = document.getElementById(id);
      if (root && rendered(root)) roots.add(root);
    }
  }
  return [...roots];
}

/** Reveal the browser's model radios only within its single owned picker. */
export function revealModelFamilyOptions(
  resolveRoots: () => readonly Element[],
): boolean {
  const candidates = resolveRoots();
  const roots = candidates.filter(
    (root) =>
      !candidates.some((other) => other !== root && root.contains(other)),
  );
  if (roots.length !== 1) return false;
  const root = roots[0]!;
  const visible = (element: Element): boolean => {
    if (
      !element.isConnected ||
      element.closest('[inert], [aria-hidden="true"]')
    )
      return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  };
  // Current GPT-6 menus may already expose GPT-6 and GPT-5.6 Sol. Do not
  // toggle that panel closed when its options are already operable.
  if (
    [...root.querySelectorAll('[role="menuitemradio"], [role="option"]')].some(
      (option) =>
        visible(option) &&
        /^(?:GPT[-\s]?\d|\d+(?:\.\d+)*|Latest|最新|최신)/i.test(
          (option.textContent ?? "").trim(),
        ),
    )
  )
    return true;
  const toggles = [
    ...new Set(
      root.querySelectorAll(
        '[data-model-picker-view-toggle="true"], [role="menuitem"][aria-expanded="false"]',
      ),
    ),
  ].filter(visible);
  if (toggles.length !== 1 || !(toggles[0] instanceof HTMLElement))
    return false;
  toggles[0].click();
  return true;
}

export interface ModelSliderState {
  min: number;
  max: number;
  value: number;
  disabled: boolean;
}

/** Read enabled effort labels from the owned picker without changing selection. */
export function availableModelModeLabels(
  roots: () => readonly Element[],
): string[] {
  const excluded =
    '[inert], [aria-hidden="true"], aside, nav, [role="navigation"], [data-testid*="sidebar"], [data-message-author-role], pre, code';
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      element.isConnected &&
      !element.closest(excluded) &&
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  };
  const labels: string[] = [];
  for (const root of roots()) {
    for (const element of [root, ...root.querySelectorAll("*")]) {
      if (
        !visible(element) ||
        !element.matches(
          '[role="menuitem"], [role="menuitemradio"], [role="option"]',
        ) ||
        element.getAttribute("aria-disabled") === "true" ||
        (element instanceof HTMLButtonElement && element.disabled)
      ) {
        continue;
      }
      const label = (
        element.textContent ||
        element.getAttribute("aria-label") ||
        ""
      )
        .trim()
        .replace(/\s+/gu, " ");
      if (label) labels.push(label);
    }
  }
  return [...new Set(labels)];
}

/** Read the owned picker slider, including ChatGPT's accessible keyboard proxy. */
export function readModelSlider(
  roots: () => readonly Element[],
  focus: boolean,
): ModelSliderState | undefined {
  const excluded =
    '[inert], [aria-hidden="true"], aside, nav, [role="navigation"], [data-testid*="sidebar"], [data-message-author-role], pre, code';
  const visible = (element: Element): boolean => {
    if (!element.isConnected || element.closest(excluded)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      style.opacity !== "0"
    );
  };
  const ordinalState = (text: string): ModelSliderState | undefined => {
    const normalized = text.replace(/\s+/gu, " ").trim();
    const match =
      /第\s*(\d+)\s*(?:個|个)[，,\s]*共\s*(\d+)\s*(?:個|个)/u.exec(
        normalized,
      ) ??
      /(?:position\s*)?(\d+)\s*(?:of|out of|\/)\s*(\d+)/iu.exec(normalized);
    if (!match) return undefined;
    const position = Number(match[1]);
    const count = Number(match[2]);
    if (
      !Number.isSafeInteger(position) ||
      !Number.isSafeInteger(count) ||
      count < 2 ||
      count > 5 ||
      position < 1 ||
      position > count
    ) {
      return undefined;
    }
    return {
      min: 0,
      max: count - 1,
      value: position - 1,
      disabled: false,
    };
  };
  const ownedRoots = roots();
  const elements = new Set<Element>();
  for (const root of ownedRoots) {
    for (const element of root.querySelectorAll(
      '[role="slider"], input[type="range"]',
    )) {
      elements.add(element);
    }
  }
  const candidates: Array<{
    element?: HTMLElement;
    control: HTMLElement;
    state?: ModelSliderState;
  }> = [];
  const seenControls = new Set<HTMLElement>();
  for (const element of elements) {
    if (!(element instanceof HTMLElement)) continue;
    if (visible(element)) {
      const row = element.closest('[role="menuitem"]');
      const control =
        row instanceof HTMLElement && visible(row) ? row : element;
      candidates.push({
        element,
        control,
      });
      seenControls.add(control);
      continue;
    }
    // The real picker intentionally hides its numeric thumb from accessibility.
    // Only its visible, owned, keyboard-operable menu item may act as a proxy.
    if (
      element.getAttribute("role") !== "slider" ||
      element.getAttribute("aria-hidden") !== "true" ||
      element.hasAttribute("inert") ||
      element.parentElement?.closest(excluded)
    ) {
      continue;
    }
    // Try the legacy wrapper first, then fall back to a direct ancestor search.
    const wrapper = element.closest("[data-model-reasoning-effort-slider]");
    const control =
      wrapper?.closest('[role="menuitem"][aria-keyshortcuts]') ??
      element.closest('[role="menuitem"][aria-keyshortcuts]');
    if (
      !(control instanceof HTMLElement) ||
      !visible(control) ||
      control.tabIndex < 0 ||
      !ownedRoots.some((root) => root.contains(control))
    ) {
      continue;
    }
    if (wrapper && !visible(wrapper)) continue;
    const keys = (control.getAttribute("aria-keyshortcuts") ?? "").split(/\s+/);
    if (!keys.includes("ArrowLeft") || !keys.includes("ArrowRight")) continue;
    candidates.push({ element, control });
    seenControls.add(control);
  }
  // Current ChatGPT exposes a five-position visual scale with no slider ARIA
  // node. Its visible, focusable menu item owns Left/Right shortcuts while a
  // bounded live-status string reports "3 of 5" (or "第 3 個，共 5 個").
  // Accept only one such proxy inside one owned picker root.
  for (const root of ownedRoots) {
    const proxies = [...root.querySelectorAll('[role="menuitem"]')].filter(
      (element): element is HTMLElement => {
        if (!(element instanceof HTMLElement) || !visible(element))
          return false;
        const keys = (element.getAttribute("aria-keyshortcuts") ?? "").split(
          /\s+/,
        );
        return keys.includes("ArrowLeft") && keys.includes("ArrowRight");
      },
    );
    if (proxies.length !== 1 || seenControls.has(proxies[0]!)) continue;
    const proxy = proxies[0]!;
    const referenced = [
      ...new Set(
        ["aria-describedby", "aria-labelledby"]
          .flatMap((attribute) =>
            (proxy.getAttribute(attribute) ?? "").split(/\s+/),
          )
          .filter(Boolean)
          .map((id) => document.getElementById(id))
          .filter((element): element is HTMLElement => element !== null),
      ),
    ];
    const statuses = [
      ...referenced,
      ...proxy.querySelectorAll('[role="status"], [aria-live]'),
      ...root.querySelectorAll('[role="status"], [aria-live]'),
    ];
    const states = [
      ...new Map(
        statuses
          .map((element) => ordinalState(element.textContent ?? ""))
          .filter((state): state is ModelSliderState => state !== undefined)
          .map((state) => [`${state.value}/${state.max}`, state]),
      ).values(),
    ];
    if (states.length !== 1) continue;
    const disabledSelector =
      '[aria-disabled="true"], [data-locked="true"], [data-disabled="true"], [disabled]';
    candidates.push({
      control: proxy,
      state: {
        ...states[0]!,
        disabled: Boolean(proxy.closest(disabledSelector)),
      },
    });
  }
  if (candidates.length !== 1) return undefined;
  const { element, control } = candidates[0]!;
  const directState = candidates[0]!.state;
  let min: number;
  let max: number;
  let value: number;
  if (directState) {
    ({ min, max, value } = directState);
  } else if (element instanceof HTMLInputElement && element.type === "range") {
    min = Number(element.min || "0");
    max = Number(element.max || "100");
    value = element.valueAsNumber;
  } else if (element) {
    const attributes = ["aria-valuemin", "aria-valuemax", "aria-valuenow"].map(
      (name) => element.getAttribute(name),
    );
    if (
      attributes.some(
        (attribute) => attribute === null || attribute.trim() === "",
      )
    ) {
      return undefined;
    }
    [min, max, value] = attributes.map(Number) as [number, number, number];
  } else {
    return undefined;
  }
  if (
    ![min, max, value].every(Number.isInteger) ||
    max <= min ||
    value < min ||
    value > max
  ) {
    return undefined;
  }
  const disabledSelector =
    '[aria-disabled="true"], [data-locked="true"], [data-disabled="true"], [disabled]';
  const disabled =
    directState?.disabled === true ||
    Boolean(
      element?.closest(disabledSelector) || control.closest(disabledSelector),
    );
  if (focus && !disabled) control.focus({ preventScroll: true });
  return { min, max, value, disabled };
}
