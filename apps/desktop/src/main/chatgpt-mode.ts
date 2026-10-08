import type { RunWebTurnInput } from "@codexgpt-bridge/responses-gateway";

export type SliderBridgeMode = Exclude<
  RunWebTurnInput["mode"],
  "luna" | "think"
>;
export type EffortSliderKey = "LEFT" | "RIGHT";

export const BRIDGE_WEB_MODE_ORDER: readonly SliderBridgeMode[] = [
  "instant",
  "medium",
  "high",
  "extra-high",
  "pro",
];

export interface EffortSliderPlan {
  readonly targetValue: number;
  readonly keys: readonly EffortSliderKey[];
}

const MODE_INDEX: Record<SliderBridgeMode, number> = {
  instant: 0,
  medium: 1,
  high: 2,
  "extra-high": 3,
  pro: 4,
};

export function availableBridgeModesFromSlider(
  min: number,
  max: number,
): readonly SliderBridgeMode[] {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
    throw new Error("ChatGPT effort slider exposed an invalid ARIA range.");
  }
  const count = max - min + 1;
  if (count < 1 || count > BRIDGE_WEB_MODE_ORDER.length) {
    throw new Error(
      `ChatGPT effort slider exposed an unsupported option count (${count}).`,
    );
  }
  return BRIDGE_WEB_MODE_ORDER.slice(0, count);
}

export function availableBridgeModesFromLabels(
  labels: readonly string[],
): readonly SliderBridgeMode[] {
  const found = new Set<SliderBridgeMode>();
  for (const label of labels) {
    const normalized = label
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/[\u2022\u00b7_-]/gu, " ")
      .replace(/\s+/gu, " ");
    if (/^(?:pro|extended pro|pro extended)(?:\s|$)/u.test(normalized)) {
      found.add("pro");
    } else if (
      /^(?:instant|light|low|即時|即时|低)(?:\s|$)/u.test(normalized)
    ) {
      found.add("instant");
    } else if (
      /^(?:medium|standard|thinking standard|standard thinking|中|中等|標準|标准)(?:\s|$)/u.test(
        normalized,
      )
    ) {
      found.add("medium");
    } else if (
      /^(?:high|extended|thinking extended|extended thinking|高|延伸|擴展|扩展)(?:\s|$)/u.test(
        normalized,
      )
    ) {
      found.add("high");
    } else if (
      /^(?:extra high|xhigh|heavy|thinking heavy|heavy thinking|極高|极高|重度)(?:\s|$)/u.test(
        normalized,
      )
    ) {
      found.add("extra-high");
    }
  }
  return BRIDGE_WEB_MODE_ORDER.filter((mode) => found.has(mode));
}

export function planEffortSliderSelection(
  mode: SliderBridgeMode,
  min: number,
  max: number,
  value: number,
): EffortSliderPlan {
  if (
    ![min, max, value].every(Number.isSafeInteger) ||
    min > max ||
    value < min ||
    value > max
  ) {
    throw new Error("ChatGPT effort slider exposed an invalid ARIA range.");
  }

  const targetValue = min + MODE_INDEX[mode];
  if (targetValue > max) {
    throw new Error(
      `ChatGPT effort slider does not expose ${mode} (min=${min}; max=${max}).`,
    );
  }

  const key: EffortSliderKey = targetValue > value ? "RIGHT" : "LEFT";
  return {
    targetValue,
    keys: Array.from({ length: Math.abs(targetValue - value) }, () => key),
  };
}
