import type { BridgeWebMode, BridgeWebModelRoute } from "./responses-server.js";
import type { BridgeAccountContextProfile } from "./context-budgets.js";
import { resolveBridgeContextBudget } from "./context-budgets.js";

export type BridgeNativeModelFamily = "5.6" | "6" | "6.1";
export type BridgeNativeEffort = "low" | "medium" | "high" | "xhigh" | "max";

const modes: Record<BridgeNativeEffort, BridgeWebMode> = {
  low: "instant",
  medium: "medium",
  high: "high",
  xhigh: "extra-high",
  max: "pro",
};
const solEfforts = ["low", "medium", "high", "xhigh"] as const;
const nativeRoutes: readonly BridgeWebModelRoute[] = [
  {
    slug: "codexgpt-bridge/gpt-6-sol",
    displayName: "GPT-6 Sol · Bridge",
    description:
      "GPT-6 through the ChatGPT model picker with a verified Sol effort.",
    effort: "high",
    mode: "high",
    contextWindow: 95_000,
    supportedEfforts: solEfforts,
    nativeFamily: "6",
  },
  {
    slug: "codexgpt-bridge/gpt-6-sol-instant",
    displayName: "GPT-6 Sol Instant · Bridge",
    description: "GPT-6 Instant through the ChatGPT model picker.",
    effort: "low",
    mode: "instant",
    contextWindow: 95_000,
    supportedEfforts: ["low"],
    nativeFamily: "6",
  },
  {
    slug: "codexgpt-bridge/gpt-6.1-sol",
    displayName: "GPT-6.1 Sol · Bridge",
    description:
      "GPT-6.1 Sol when explicitly available in the ChatGPT model picker.",
    effort: "high",
    mode: "high",
    contextWindow: 95_000,
    supportedEfforts: solEfforts,
    nativeFamily: "6.1",
  },
  {
    slug: "codexgpt-bridge/gpt-6.1-sol-instant",
    displayName: "GPT-6.1 Sol Instant · Bridge",
    description:
      "GPT-6.1 Sol at low effort when explicitly available in the ChatGPT model picker.",
    effort: "low",
    mode: "instant",
    contextWindow: 95_000,
    supportedEfforts: ["low"],
    nativeFamily: "6.1",
  },
  {
    slug: "codexgpt-bridge/gpt-5.6-sol",
    displayName: "GPT-5.6 Sol · Bridge",
    description: "GPT-5.6 Sol through the ChatGPT model picker.",
    effort: "high",
    mode: "high",
    contextWindow: 95_000,
    supportedEfforts: solEfforts,
    nativeFamily: "5.6",
  },
  {
    slug: "codexgpt-bridge/gpt-5.6-sol-instant",
    displayName: "GPT-5.6 Sol Instant · Bridge",
    description: "GPT-5.6 Sol Instant through the ChatGPT model picker.",
    effort: "low",
    mode: "instant",
    contextWindow: 95_000,
    supportedEfforts: ["low"],
    nativeFamily: "5.6",
  },
  {
    slug: "codexgpt-bridge/gpt-5.6-sol-pro",
    displayName: "GPT-5.6 Sol Pro · Bridge",
    description:
      "GPT-5.6 Sol Pro with max effort through the ChatGPT model picker.",
    effort: "max",
    mode: "pro",
    contextWindow: 95_000,
    supportedEfforts: ["max"],
    nativeFamily: "5.6",
  },
  {
    slug: "codexgpt-bridge/gpt-6-pro",
    displayName: "GPT-6 Pro · Bridge",
    description: "GPT-6 Pro with max effort through the ChatGPT model picker.",
    effort: "max",
    mode: "pro",
    contextWindow: 95_000,
    supportedEfforts: ["max"],
    nativeFamily: "6",
  },
  {
    slug: "codexgpt-bridge/luna-native",
    displayName: "Luna · Bridge",
    description:
      "Luna with low or medium effort and private rolling browser checkpoints through the Full Codex harness.",
    effort: "low",
    mode: "luna",
    contextWindow: 1_050_000,
    supportedEfforts: ["low", "medium"],
  },
];
export const BRIDGE_NATIVE_MODEL_ROUTES: readonly BridgeWebModelRoute[] = [
  ...nativeRoutes,
  ...nativeRoutes
    .filter((route) => route.nativeFamily)
    .map((route): BridgeWebModelRoute => ({
      ...route,
      slug: `${route.slug}-3x`,
      displayName: `${route.displayName} · 3× context`,
      description: `${route.description} Ordered Full context transport using at most six browser messages.`,
      contextMultiplier: 3,
    })),
];

export function nativeRouteMode(
  route: BridgeWebModelRoute,
  effort: string,
): BridgeWebMode {
  if (route.slug === "codexgpt-bridge/luna-native")
    return effort === "medium" ? "think" : "luna";
  return modes[effort as BridgeNativeEffort] ?? route.mode;
}

/** A grouped row must never advertise efforts with different transport budgets. */
export function availableNativeModelRoutes(
  availableModes: readonly BridgeWebMode[] | undefined,
  profile: BridgeAccountContextProfile,
  families: readonly BridgeNativeModelFamily[],
  enabled: boolean | "simple" = true,
): readonly BridgeWebModelRoute[] {
  if (!enabled || profile === "compatibility") return [];
  const available = availableModes ? new Set(availableModes) : undefined;
  return BRIDGE_NATIVE_MODEL_ROUTES.flatMap((route) => {
    // Simple can pin an exact browser model, but cannot run the Full-only
    // staged-context transaction or Luna's private checkpoint protocol.
    if (
      enabled === "simple" &&
      (route.contextMultiplier || route.slug === "codexgpt-bridge/luna-native")
    )
      return [];
    if (route.nativeFamily && !families.includes(route.nativeFamily)) return [];
    if (route.mode === "pro" && profile !== "pro") return [];
    if (/-instant(?:-3x)?$/.test(route.slug) && profile === "pro") return [];
    const defaultBudget = resolveBridgeContextBudget(route.mode, profile);
    const efforts = route.supportedEfforts!.filter((effort) => {
      const mode = nativeRouteMode(route, effort);
      if (available && !available.has(mode)) return false;
      const budget = resolveBridgeContextBudget(mode, profile);
      return (
        budget.contextWindow === defaultBudget.contextWindow &&
        budget.hardInputTokenLimit === defaultBudget.hardInputTokenLimit &&
        budget.autoCompactTokenLimit === defaultBudget.autoCompactTokenLimit
      );
    });
    if (!efforts.length) return [];
    const effort =
      route.effort !== "ultra" && efforts.includes(route.effort)
        ? route.effort
        : efforts[0]!;
    return [
      {
        ...route,
        effort,
        mode: nativeRouteMode(route, effort),
        supportedEfforts: efforts,
      },
    ];
  });
}

export function bridgeCatalogNativeFamilies(
  payload: unknown,
): readonly BridgeNativeModelFamily[] {
  const record = payload as {
    bridge_account_capabilities?: {
      version?: number;
      native_families?: unknown;
    };
  } | null;
  const proof = record?.bridge_account_capabilities;
  if (proof?.version !== 1 || !Array.isArray(proof.native_families)) return [];
  return [
    ...new Set(
      proof.native_families.filter(
        (value): value is BridgeNativeModelFamily =>
          value === "5.6" || value === "6" || value === "6.1",
      ),
    ),
  ];
}

/** Read the capability snapshot separately from persistently listed choices. */
export function bridgeCatalogWebModes(
  payload: unknown,
): readonly BridgeWebMode[] {
  const models = (payload as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  const result = new Set<BridgeWebMode>();
  const legacyModes = new Set<BridgeWebMode>([
    "instant",
    "medium",
    "high",
    "extra-high",
    "pro",
    "luna",
    "think",
  ]);
  const proof = (
    payload as {
      bridge_account_capabilities?: {
        version?: number;
        available_modes?: unknown;
      };
    } | null
  )?.bridge_account_capabilities;
  if (proof?.version === 1 && Array.isArray(proof.available_modes)) {
    if (proof.available_modes.some((mode) => !legacyModes.has(mode)))
      throw new Error("Installed ChatGPT capability snapshot is invalid.");
    return [...new Set(proof.available_modes)] as BridgeWebMode[];
  }
  for (const value of models) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (typeof row.slug !== "string") continue;
    const route = BRIDGE_NATIVE_MODEL_ROUTES.find(
      (item) => item.slug === row.slug,
    );
    if (route) {
      if (!Array.isArray(row.supported_reasoning_levels)) continue;
      for (const level of row.supported_reasoning_levels) {
        const effort =
          level && typeof level === "object" ? level.effort : undefined;
        if (route.supportedEfforts?.includes(effort))
          result.add(nativeRouteMode(route, effort));
      }
    } else if (row.slug.startsWith("codexgpt-bridge/")) {
      const mode = row.slug.slice("codexgpt-bridge/".length) as BridgeWebMode;
      if (legacyModes.has(mode)) result.add(mode);
    }
  }
  return [...result];
}

export class BridgeReasoningEffortError extends Error {
  readonly code = "bridge_reasoning_effort_unavailable";
  constructor(route: string, effort: unknown, supported: readonly string[]) {
    super(
      `Unsupported reasoning effort ${JSON.stringify(effort)} for ${route}; choose ${supported.join(", ")}. No prompt was submitted.`,
    );
    this.name = "BridgeReasoningEffortError";
  }
}

export function resolveNativeRouteEffort(
  route: BridgeWebModelRoute,
  requested: unknown,
): BridgeWebModelRoute {
  if (!route.supportedEfforts) return route;
  const effort = requested ?? route.effort;
  if (
    typeof effort !== "string" ||
    !route.supportedEfforts.includes(effort as BridgeNativeEffort)
  ) {
    throw new BridgeReasoningEffortError(
      route.slug,
      effort,
      route.supportedEfforts,
    );
  }
  return {
    ...route,
    effort: effort as BridgeNativeEffort,
    mode: nativeRouteMode(route, effort),
  };
}
