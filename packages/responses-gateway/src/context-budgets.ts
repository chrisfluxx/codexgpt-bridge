import { BRIDGE_PLATFORM_RESERVE_TOKENS } from "./input-tokens.js";
import type {
  BridgeContextBudget,
  BridgeWebMode,
  BridgeWebModelRoute,
} from "./responses-server.js";

export type BridgeAccountContextProfile = "compatibility" | "standard" | "pro";

export function resolveBridgeRouteContextBudget(
  route: BridgeWebModelRoute,
  profile: BridgeAccountContextProfile = "compatibility",
): BridgeContextBudget {
  // A listed Pro route can recover while the installed account snapshot is old.
  // Its own transport budget must not promote the account's other model routes.
  const budget = resolveBridgeContextBudget(
    route.mode,
    route.mode === "pro" && profile === "standard" ? "pro" : profile,
  );
  if (
    route.slug === "codexgpt-bridge/luna-native" &&
    profile !== "compatibility"
  )
    return {
      ...budget,
      contextWindow: 1_050_000,
      hardInputTokenLimit: 1_050_000,
      autoCompactTokenLimit: 1_050_000,
      profile: `${budget.profile}-luna-rolling`,
    };
  if (!route.contextMultiplier) return budget;
  if (
    profile === "compatibility" ||
    route.mode === "luna" ||
    route.mode === "think"
  )
    throw new Error(
      "This model does not support the Full multipart context profile.",
    );
  return {
    ...budget,
    contextWindow: budget.contextWindow * 3,
    hardInputTokenLimit: budget.hardInputTokenLimit * 3,
    autoCompactTokenLimit: budget.autoCompactTokenLimit * 3,
    profile: `${budget.profile}-3x`,
  };
}

/** Reference transport boundaries; these are not new measurements of this account. */
export function resolveBridgeContextBudget(
  mode: BridgeWebMode,
  profile: BridgeAccountContextProfile = "compatibility",
): BridgeContextBudget {
  if (!["compatibility", "standard", "pro"].includes(profile))
    throw new Error("Unknown Bridge account context profile.");
  if (profile === "compatibility")
    return {
      contextWindow: 95_000,
      autoCompactTokenLimit: 90_000,
      hardInputTokenLimit: 95_000,
      profile: "bridge-safe-v1",
    };
  const name = `bridge-chatgpt-${profile}-v1`;
  if (mode === "luna" || mode === "think")
    return {
      contextWindow: 28_000,
      autoCompactTokenLimit: 24_000,
      hardInputTokenLimit: 28_000,
      browserMessageTokenLimit: 28_000 - BRIDGE_PLATFORM_RESERVE_TOKENS - 1,
      profile: name,
    };
  if (profile === "pro") {
    const messageTokens = mode === "pro" ? 104_000 : 103_000;
    const contextWindow = messageTokens + BRIDGE_PLATFORM_RESERVE_TOKENS + 1;
    return {
      contextWindow,
      autoCompactTokenLimit: 95_000,
      hardInputTokenLimit: contextWindow,
      browserMessageTokenLimit: messageTokens,
      browserComposerCharLimit:
        mode === "instant" ? 545_000 : mode === "pro" ? 1_635_000 : 500_000,
      profile: name,
    };
  }
  if (mode === "pro")
    throw new Error(
      "ChatGPT Pro mode requires a Pro-capable account context profile.",
    );
  const contextWindow = mode === "instant" ? 41_000 : 90_000;
  return {
    contextWindow,
    autoCompactTokenLimit: mode === "instant" ? 32_000 : 80_000,
    hardInputTokenLimit: contextWindow,
    browserMessageTokenLimit:
      contextWindow - BRIDGE_PLATFORM_RESERVE_TOKENS - 1,
    browserComposerCharLimit: mode === "instant" ? 211_256 : 1_048_572,
    profile: name,
  };
}
