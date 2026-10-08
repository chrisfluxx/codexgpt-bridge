import type { ChatGptLimitsPlan } from "./chatgpt-session-probe.js";

export type ChatGptUsageModel =
  "gpt-6-pro" | "gpt-5.6-pro" | "pro-unknown" | "other";

export interface ChatGptUsagePolicyAllowance {
  readonly id: string;
  readonly models: readonly ChatGptUsageModel[];
  readonly messages: number;
  readonly window: "day" | "week" | "month";
  readonly shared: boolean;
}

export interface ChatGptUsagePolicy {
  readonly sourceUrl: string;
  readonly checkedOn: string;
  readonly note: string;
  readonly allowances: Readonly<
    Partial<Record<ChatGptLimitsPlan, readonly ChatGptUsagePolicyAllowance[]>>
  >;
}

export interface ChatGptAcceptedUsageCounts {
  readonly retainedEvents: number;
  readonly last24Hours: number;
  readonly last7Days: number;
  readonly last30Days: number;
  readonly byModel: Readonly<Record<ChatGptUsageModel, number>>;
  readonly oldestRetainedAt?: string;
  readonly newestRetainedAt?: string;
}

export interface ChatGptUsageSummary {
  readonly windows?: readonly {
    readonly id: string;
    readonly accepted: number;
    readonly messages: number;
    readonly window: "day" | "week" | "month";
    readonly percent: number;
    readonly nearLimit: boolean;
    readonly shared: boolean;
  }[];
  readonly accountObserved: boolean;
  readonly accountKeyHint?: string;
  readonly plan?: ChatGptLimitsPlan;
  readonly supported: boolean;
  readonly needsAttention: boolean;
  readonly policy: ChatGptUsagePolicy;
  readonly accepted: ChatGptAcceptedUsageCounts;
  readonly officialRemainingObserved: false;
  readonly resetTimeObserved: false;
  readonly externalChatGptMessagesIncluded: false;
}
