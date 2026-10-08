import type {
  BridgeExecutionPreflight,
  BridgeWebMode,
} from "@codexgpt-bridge/responses-gateway";

import type {
  ModelUiObservation,
  ModelExecutionReceipt,
} from "./model-selection-types.js";
export type {
  ModelUiObservation,
  ModelExecutionReceipt,
} from "./model-selection-types.js";

export function modelPreference(value: unknown): string {
  if (value === undefined) return "";
  if (
    typeof value !== "string" ||
    value.length > 120 ||
    /[<>]/.test(value) ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error(
      "Model preference must be a model selector label (at most 120 characters).",
    );
  return value.trim();
}

export function modelLabelsEqual(a: string, b: string): boolean {
  const normalize = (label: string): string =>
    label
      .normalize("NFKC")
      .split(/\r?\n/)[0]!
      .replace(/\s*(?:即將|即将|下線|下线|retiring|legacy|deprecated).*$/i, "")
      .trim()
      .replace(/^GPT[-\s]*/i, "")
      .replace(/\s+/g, " ")
      .toLowerCase();
  return normalize(a) === normalize(b);
}

/** Reserved native routes select a family radio; ordinary user labels stay exact. */
export function modelSelectionLabelMatches(
  requested: string,
  observed: string,
): boolean {
  const label = observed.normalize("NFKC").split(/\r?\n/)[0]!.trim();
  if (requested === "bridge-native:5.6")
    return /^GPT[-\s]?5\.6\s+Sol(?:\s+Pro)?$/i.test(label);
  // 6.1 is available in Work/Codex; a generic Chat "Latest" radio is not proof.
  if (requested === "bridge-native:6.1")
    return /^GPT[-\s]?6\.1\s+Sol$/i.test(label);
  if (requested === "bridge-native:6")
    return /^(?:Latest|最新(?:的模型|模型|的)?|최신|GPT[-\s]?6(?:\s+Astra)?(?:\s+Pro)?)$/i.test(
      label,
    );
  const normalize = (value: string): string =>
    value
      .normalize("NFKC")
      .split(/\r?\n/)[0]!
      .replace(/\s*(?:即將|即将|下線|下线|retiring|legacy|deprecated).*$/i, "")
      .trim()
      .replace(/^GPT[-\s]*/i, "")
      .replace(/\s+/g, " ")
      .toLowerCase();
  return normalize(requested) === normalize(observed);
}

export function nativeModelDescriptionsMatch(
  requested: string,
  mode: BridgeWebMode,
  descriptions: readonly string[],
): boolean {
  if (!requested.startsWith("bridge-native:")) return true;
  const family = requested.slice("bridge-native:".length);
  if (family !== "5.6" && family !== "6" && family !== "6.1") return false;
  if (family === "6.1" && mode === "pro") return false;
  // The legacy GPT-6 Pro route uses Latest; lower efforts still require 5.6.
  const expected = family === "6" && mode !== "pro" ? "5.6" : family;
  const states = descriptions.flatMap((text) => {
    const match =
      /^(?:GPT[-\s]?)?(\d+(?:\.\d+)?)(?:\s+(Sol|Astra))?\s+([^,，]+)(?:[,，]|$)/i.exec(
        text.replace(/\s+/g, " ").trim(),
      );
    return match
      ? [
          {
            version: match[1],
            name: match[2]?.toLowerCase(),
            mode: match[3]!.trim(),
          },
        ]
      : [];
  });
  return (
    states.length > 0 &&
    states.every(
      (state) =>
        state.version === expected &&
        (!state.name || state.name === (expected === "6" ? "astra" : "sol")) &&
        (mode === "pro"
          ? /^Pro$/i.test(state.mode)
          : !/^Pro$/i.test(state.mode)),
    )
  );
}

export function verifyModelSelection(
  operationId: string,
  requestedMode: BridgeWebMode,
  requestedModel: string,
  observed: ModelUiObservation,
  execution?: BridgeExecutionPreflight,
): ModelExecutionReceipt {
  const effortMatches =
    observed.mode === requestedMode ||
    (requestedMode === "high" &&
      (observed.mode === null || observed.mode === "high") &&
      !observed.disabled &&
      !observed.ambiguous &&
      observed.surface !== "missing");
  const accepted =
    !observed.ambiguous &&
    !observed.disabled &&
    effortMatches &&
    (!requestedModel.startsWith("bridge-native:") ||
      observed.mode === requestedMode) &&
    nativeModelDescriptionsMatch(
      requestedModel,
      requestedMode,
      observed.modelDescriptions ?? [],
    ) &&
    (!requestedModel ||
      (observed.model !== null &&
        modelSelectionLabelMatches(requestedModel, observed.model)));
  return {
    version: 1,
    operationId,
    requestedRoute: execution?.route ?? `codexgpt-bridge/${requestedMode}`,
    requestedModel: requestedModel || null,
    requestedMode,
    ...(execution ? { execution } : {}),
    observed,
    confidence: !accepted
      ? "REJECTED"
      : observed.model
        ? "UI_VERIFIED"
        : "EFFORT_VERIFIED",
    backendIdentity: "NOT_OBSERVED",
    phase: "before-submit",
    checkedAt: new Date().toISOString(),
  };
}

/** A uniquely observed composer effort is sufficient when no model family was pinned. */
export function isModeOnlySelectionVerified(
  requestedMode: BridgeWebMode,
  requestedModel: string,
  observed: ModelUiObservation,
): boolean {
  return (
    requestedModel.length === 0 &&
    observed.surface !== "missing" &&
    (observed.mode === requestedMode ||
      (requestedMode === "high" &&
        (observed.mode === null || observed.mode === "high"))) &&
    !observed.ambiguous &&
    !observed.disabled
  );
}

/** Injected into the renderer. Only inspect model controls, never assistant prose. */
export function observeModelSelection(
  resolveRoots?: () => readonly Element[],
): ModelUiObservation {
  const visible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      el.isConnected &&
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      !el.closest(
        '[inert], [aria-hidden="true"], aside, nav, [role="navigation"], [data-testid*="sidebar"], [data-message-author-role], pre, code',
      )
    );
  };
  const label = (el: Element): string =>
    (
      (el as HTMLElement).innerText ||
      el.textContent ||
      el.getAttribute("aria-label") ||
      ""
    )
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 160);
  const modeOf = (value: string): BridgeWebMode | null => {
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/[•·]/g, " ")
      .replace(/\s+/g, " ");
    if (
      /(?:^|\b)(?:pro|extended pro|pro extended|pro thinking extended)(?:\b|$)/i.test(
        normalized,
      )
    )
      return "pro";
    if (
      /(?:^|\b)(?:extra[- ]high|xhigh|heavy|thinking heavy|heavy thinking)(?:\b|$)|(?:極高|极高)/i.test(
        normalized,
      )
    )
      return "extra-high";
    if (
      /(?:^|\b)(?:high|extended|thinking extended|extended thinking)(?:\b|$)|高/i.test(
        normalized,
      )
    )
      return "high";
    if (
      /(?:^|\b)(?:medium|standard|thinking standard|standard thinking)(?:\b|$)|(?:中等|中)/i.test(
        normalized,
      )
    )
      return "medium";
    if (
      /(?:^|\b)(?:instant|light|low)(?:\b|$)|(?:即時|即时|低)/i.test(normalized)
    )
      return "instant";
    if (/\bluna\b/i.test(normalized)) return "luna";
    if (/\bthink\b/i.test(normalized)) return "think";
    return null;
  };
  const modelLike = (text: string): boolean =>
    /^(?:GPT[-\s]?\d[^\n\r]*|\d+(?:\.\d+)*(?: [^\n\r]+)?|o\d[^\n\r]*|Latest|最新(?:的模型|模型|的)?)/i.test(
      text.trim(),
    );
  const modes: Array<{
    mode: BridgeWebMode;
    label: string;
    disabled: boolean;
  }> = [];
  const models: string[] = [];
  const availableModels: string[] = [];
  const modelDescriptions = new Set<string>();
  const noteMode = (el: Element, text = label(el)): void => {
    const mode = modeOf(text);
    if (mode)
      modes.push({
        mode,
        label: text,
        disabled:
          el.getAttribute("aria-disabled") === "true" ||
          (el instanceof HTMLButtonElement && el.disabled),
      });
  };
  const all = (selector: string, root: ParentNode = document): Element[] =>
    [...root.querySelectorAll(selector)].filter(visible);
  const dialogs = all(
    '[role="dialog"], [data-testid="model-configure-modal"]',
  ).filter(
    (el) =>
      /Intelligence|智慧|智能/i.test(label(el)) &&
      /Model|模型/i.test(el.textContent || ""),
  );
  const menuRoots = resolveRoots ? [...resolveRoots()] : all('[role="menu"]');
  // Version descriptions belong to the active slider row, never assistant text
  // or unselected family options. Retain every attached description so conflicts fail.
  for (const root of menuRoots) {
    const describers = new Set<Element>(
      all('[role="slider"], input[type="range"]', root).flatMap((slider) =>
        [slider, slider.closest('[role="menuitem"]')].filter(
          (value): value is Element => value !== null,
        ),
      ),
    );
    for (const row of all('[role="menuitem"][aria-describedby]', root)) {
      const keys = (row.getAttribute("aria-keyshortcuts") ?? "").split(/\s+/);
      if (
        row.querySelector('[role="slider"], input[type="range"]') ||
        (keys.includes("ArrowLeft") && keys.includes("ArrowRight"))
      )
        describers.add(row);
    }
    for (const el of describers) {
      for (const id of (el.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter(Boolean)) {
        const text = document.getElementById(id)?.textContent?.trim();
        if (text) modelDescriptions.add(text.slice(0, 512));
      }
    }
  }
  const direct = resolveRoots
    ? menuRoots.filter((root) =>
        root.matches('[data-testid="composer-intelligence-picker-content"]'),
      )
    : all('[data-testid="composer-intelligence-picker-content"]');
  const disabledControl = (el: Element): boolean =>
    el.getAttribute("aria-disabled") === "true" ||
    (el instanceof HTMLButtonElement && el.disabled);
  let disabledModel = false;
  let surface: ModelUiObservation["surface"] = direct.length
    ? "direct"
    : "legacy";
  let ambiguous = dialogs.length > 1 || direct.length > 1;
  if (dialogs.length) {
    surface = "configure";
    const dialog = dialogs[0]!;
    const combos = all('[role="combobox"]', dialog);
    for (const el of combos) {
      const text = label(el);
      if (modelLike(text)) {
        models.push(text);
        disabledModel ||= disabledControl(el);
      }
    }
    const checked = all('[role="radio"][aria-checked="true"]', dialog);
    const selectedMode =
      checked.length === 1 ? label(checked[0]!).toLowerCase() : "";
    const effort = combos
      .map(label)
      .find((text) => /^(Light|Standard|Extended|Heavy)$/i.test(text));
    if (checked.length !== 1) ambiguous = true;
    if (/^pro\b/.test(selectedMode))
      noteMode(checked[0]!, `Pro ${effort ?? "unknown"}`);
    else if (/^instant\b/.test(selectedMode)) noteMode(checked[0]!, "Instant");
    else if (/^thinking\b/.test(selectedMode) && effort)
      noteMode(checked[0]!, `Thinking ${effort}`);
  } else {
    for (const root of direct) {
      // A mounted advanced panel can be inert. Only its checked model is state evidence;
      // unselected hidden options never establish availability or entitlement.
      const selected = [
        ...root.querySelectorAll(
          '[role="menuitemradio"][aria-checked="true"], [role="menuitemcheckbox"][aria-checked="true"], [role="menuitem"][aria-checked="true"], [role="menuitem"][data-state="checked"]',
        ),
      ];
      if (!selected.length) {
        for (const el of all(
          '[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"], [role="option"]',
          root,
        )) {
          if (
            el.querySelector("svg") ||
            el.textContent?.includes("✓") ||
            el.getAttribute("data-state") === "checked"
          ) {
            selected.push(el);
          }
        }
      }
      for (const el of selected) {
        const text = label(el).split(/\r?\n/)[0]!.trim();
        if (modelLike(text)) {
          models.push(text);
          disabledModel ||= disabledControl(el);
        } else if (visible(el)) noteMode(el);
      }
      for (const el of all(
        '[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"], [role="option"]',
        root,
      )) {
        const text = label(el).split(/\r?\n/)[0]!.trim();
        if (modelLike(text) && !disabledControl(el)) availableModels.push(text);
      }
    }
    const composer = all(
      '#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]',
    )[0];
    const controls = new Set(
      all(
        '[data-testid="model-switcher-dropdown-button"], [data-testid="composer-model-picker-button"]',
      ),
    );
    // Some composer pickers expose data-tone instead of a test id. Restrict this
    // fallback to the composer form/geometry; a sidebar High label is not state.
    if (composer) {
      const rect = composer.getBoundingClientRect();
      const form = composer.closest("form");
      const parent =
        composer.closest('[class*="composer"], [class*="input"], main') ||
        document.body;
      for (const el of all(
        'button[aria-haspopup], button[aria-controls], [role="button"][aria-haspopup], [role="button"][aria-controls]',
        parent,
      )) {
        const control = el.getBoundingClientRect();
        const nearByGeometry =
          control.top >= rect.top - 64 &&
          control.bottom <= rect.bottom + 120 &&
          control.left >= rect.left - 64 &&
          control.right <= rect.right + 350;
        if (
          (form?.contains(el) ||
            nearByGeometry ||
            Boolean(
              el.closest('[class*="composer"], [class*="input"], form'),
            )) &&
          modeOf(label(el))
        )
          controls.add(el);
      }
    }
    if (controls.size === 0) {
      for (const el of all(
        'button[aria-haspopup], button[aria-controls], [role="button"][aria-haspopup], [role="button"][aria-controls]',
      )) {
        if (
          !el.closest(
            'aside, nav, [role="navigation"], [data-testid*="sidebar"]',
          ) &&
          modeOf(label(el))
        ) {
          controls.add(el);
        }
      }
    }
    for (const el of controls) {
      const text = label(el);
      const mode = modeOf(text);
      if (mode) noteMode(el, text);
      const suffix =
        /(?:Extra[- ]High|Instant|Medium|High|Pro|XHigh|即時|即时|極高|极高|中等|中|高|低)$/i.exec(
          text,
        )?.[0];
      if (suffix) noteMode(el, suffix);
      if (
        modelLike(text) &&
        !/\b(?:Pro|Thinking|Instant|High|Medium)\b/i.test(text)
      )
        models.push(text);
      // Some versions put model and mode in the same button. Keep the family label intact.
      const combined =
        /^(.*?)\s+(Instant|Medium|High|Extra High|Pro|Thinking (?:Standard|Extended|Heavy))$/i.exec(
          text,
        );
      if (combined && modelLike(combined[1]!)) {
        models.push(combined[1]!);
        noteMode(el, combined[2]!);
      }
    }
    {
      for (const root of menuRoots) {
        for (const el of all(
          '[role="menuitemradio"][aria-checked="true"], [role="option"][aria-selected="true"]',
          root,
        ))
          noteMode(el);
        // Older menus keep the normal-effort slider visible while separate Pro is
        // active. In normal mode, contradictory semantic labels must be rejected.
        if (!modes.some((item) => item.mode === "pro")) {
          for (const el of all('[role="slider"], input[type="range"]', root))
            noteMode(el, el.getAttribute("aria-valuetext") || label(el));
        }
        for (const el of all(
          '[role="menuitem"][aria-expanded], button[aria-haspopup], button[aria-expanded]',
          root,
        )) {
          const text = label(el);
          // The direct model panel has a dedicated current-mode row.
          const suffix =
            /(?:Extra High|Instant|Medium|High|Pro|極高|极高|中等|高)$/.exec(
              text,
            )?.[0];
          if (suffix) noteMode(el, suffix);
        }
      }
    }
    // Free/Go-style ChatGPT accounts do not expose a model picker. Their stable
    // default is Luna, while the exact composer-local Think toggle selects the
    // higher-effort Luna route. Assistant prose and navigation are excluded by
    // visible(), and geometry/form checks keep an unrelated button from becoming
    // execution evidence.
    if (composer && controls.size === 0 && !modes.length && !models.length) {
      const composerRect = composer.getBoundingClientRect();
      const form = composer.closest("form");
      const thinkControls = all('button, [role="button"]').filter((el) => {
        if (label(el).toLowerCase() !== "think") return false;
        const rect = el.getBoundingClientRect();
        const nearByGeometry =
          rect.top >= composerRect.top - 64 &&
          rect.bottom <= composerRect.bottom + 96 &&
          rect.left >= composerRect.left - 32 &&
          rect.right <= composerRect.right + 192;
        return Boolean(form?.contains(el) || nearByGeometry);
      });
      if (thinkControls.length > 1) {
        ambiguous = true;
      } else if (thinkControls.length === 1) {
        const thinkControl = thinkControls[0]!;
        const pressed = thinkControl.getAttribute("aria-pressed");
        if (pressed === "true") noteMode(thinkControl, "Think");
        else if (pressed === "false") noteMode(thinkControl, "Luna");
        else ambiguous = true;
      } else {
        modes.push({ mode: "luna", label: "Luna", disabled: false });
      }
      surface = "legacy";
    }
  }
  const uniqueModels = [...new Set(models)];
  const uniqueModes = [...new Set(modes.map((item) => item.mode))];
  ambiguous ||= uniqueModels.length > 1 || uniqueModes.length > 1;
  if (!modes.length && !models.length) surface = "missing";
  return {
    model: uniqueModels.length === 1 ? uniqueModels[0]! : null,
    mode: uniqueModes.length === 1 ? uniqueModes[0]! : null,
    modeLabel: modes[0]?.label ?? null,
    surface,
    availableModels: [...new Set(availableModels)],
    ambiguous,
    disabled: disabledModel || modes.some((item) => item.disabled),
    modelDescriptions: [...modelDescriptions],
  };
}
