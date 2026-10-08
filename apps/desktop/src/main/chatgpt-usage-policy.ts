import type { ChatGptUsagePolicy } from "./chatgpt-usage-types.js";

/**
 * Human-reviewed policy snapshot. These are policy ceilings, never an account
 * balance. ChatGPT is authoritative for remaining usage and reset timestamps.
 */
export const CHATGPT_USAGE_POLICY: ChatGptUsagePolicy = {
  sourceUrl:
    "https://help.openai.com/en/articles/20001354-gpt-56-and-gpt-6-pro-in-chatgpt",
  checkedOn: "2026-09-29",
  note: "Official Chat policy snapshot. Local counters include only messages accepted through this Bridge; ChatGPT shows authoritative remaining usage and reset times.",
  allowances: {
    pro_200: [
      {
        id: "gpt-6-pro-weekly",
        models: ["gpt-6-pro"],
        messages: 200,
        window: "week",
        shared: false,
      },
      {
        id: "gpt-5.6-sol-pro-daily",
        models: ["gpt-5.6-pro"],
        messages: 170,
        window: "day",
        shared: false,
      },
      {
        id: "combined-pro-daily",
        models: ["gpt-6-pro", "gpt-5.6-pro", "pro-unknown"],
        messages: 200,
        window: "day",
        shared: true,
      },
    ],
    pro_100: [
      {
        id: "combined-pro-weekly",
        models: ["gpt-6-pro", "gpt-5.6-pro", "pro-unknown"],
        messages: 50,
        window: "week",
        shared: true,
      },
    ],
    business_standard: [
      {
        id: "combined-pro-monthly",
        models: ["gpt-6-pro", "gpt-5.6-pro", "pro-unknown"],
        messages: 15,
        window: "month",
        shared: true,
      },
    ],
    business_premium: [
      {
        id: "combined-pro-weekly",
        models: ["gpt-6-pro", "gpt-5.6-pro", "pro-unknown"],
        messages: 50,
        window: "week",
        shared: true,
      },
    ],
  },
};
