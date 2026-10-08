import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BridgeWebMode } from "@codexgpt-bridge/responses-gateway";
import type { ChatGptUsageAccount } from "./chatgpt-session-probe.js";
import { CHATGPT_USAGE_POLICY } from "./chatgpt-usage-policy.js";
import type {
  ChatGptUsageModel,
  ChatGptUsageSummary,
} from "./chatgpt-usage-types.js";
export type {
  ChatGptAcceptedUsageCounts,
  ChatGptUsageModel,
  ChatGptUsagePolicy,
  ChatGptUsageSummary,
} from "./chatgpt-usage-types.js";

interface AcceptedUsageEvent {
  readonly version: 1;
  readonly eventId: string;
  readonly accountKey: string;
  readonly plan: ChatGptUsageAccount["plan"];
  readonly model: ChatGptUsageModel;
  readonly acceptedAt: string;
}

const MAX_EVENTS = 5_000;
const MAX_FILE_BYTES = 2_000_000;

function isUsageEvent(value: unknown): value is AcceptedUsageEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<AcceptedUsageEvent>;
  return (
    row.version === 1 &&
    typeof row.eventId === "string" &&
    /^[a-f0-9]{64}$/u.test(row.eventId) &&
    typeof row.accountKey === "string" &&
    /^[a-f0-9]{64}$/u.test(row.accountKey) &&
    [
      "pro_100",
      "pro_200",
      "business_standard",
      "business_premium",
      "unsupported",
    ].includes(row.plan ?? "") &&
    ["gpt-6-pro", "gpt-5.6-pro", "pro-unknown", "other"].includes(
      row.model ?? "",
    ) &&
    typeof row.acceptedAt === "string" &&
    Number.isFinite(Date.parse(row.acceptedAt))
  );
}

async function readEvents(file: string): Promise<AcceptedUsageEvent[]> {
  try {
    if ((await stat(file)).size > MAX_FILE_BYTES)
      throw new Error("ChatGPT usage event store exceeds its size limit.");
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length > MAX_EVENTS ||
      parsed.some((row) => !isUsageEvent(row))
    )
      throw new Error("ChatGPT usage event store is invalid.");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function replaceUsageFile(
  temporary: string,
  destination: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        (code !== "EPERM" && code !== "EACCES") ||
        attempt >= 7
      )
        throw error;
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, Math.min(10 * 2 ** attempt, 250)),
      );
    }
  }
}

export function classifyChatGptUsageModel(
  mode: BridgeWebMode,
  modelLabel?: string | null,
): ChatGptUsageModel {
  if (mode !== "pro") return "other";
  const label = modelLabel?.normalize("NFKC") ?? "";
  if (/(?:^|\b)GPT[-\s]?6(?:\s+Astra)?(?:\s+Pro)?(?:\b|$)/iu.test(label))
    return "gpt-6-pro";
  if (/(?:^|\b)GPT[-\s]?5\.6(?:\s+Sol)?(?:\s+Pro)?(?:\b|$)/iu.test(label))
    return "gpt-5.6-pro";
  return "pro-unknown";
}

/** Bounded accepted-send ledger. Stores no prompt, response, cookie, URL, or raw account id. */
export class ChatGptUsageStore {
  #tail: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  recordAccepted(input: {
    readonly eventId: string;
    readonly account: ChatGptUsageAccount;
    readonly model: ChatGptUsageModel;
    readonly acceptedAt?: string;
  }): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(input.eventId))
      return Promise.reject(new Error("Invalid ChatGPT usage event id."));
    const pending = this.#tail
      .catch(() => undefined)
      .then(async () => {
        const rows = await readEvents(this.file);
        if (rows.some((row) => row.eventId === input.eventId)) return;
        const acceptedAt = input.acceptedAt ?? new Date().toISOString();
        if (!Number.isFinite(Date.parse(acceptedAt)))
          throw new Error("Invalid ChatGPT usage event time.");
        const next = [
          ...rows,
          {
            version: 1 as const,
            eventId: input.eventId,
            accountKey: input.account.accountKey,
            plan: input.account.plan,
            model: input.model,
            acceptedAt,
          },
        ].slice(-MAX_EVENTS);
        const content = JSON.stringify(next);
        if (Buffer.byteLength(content) > MAX_FILE_BYTES)
          throw new Error("ChatGPT usage event store exceeds its size limit.");
        await mkdir(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, content, {
            flag: "wx",
            mode: 0o600,
            flush: true,
          });
          await replaceUsageFile(temporary, this.file);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    this.#tail = pending;
    return pending;
  }

  async summary(
    account?: ChatGptUsageAccount,
    now = Date.now(),
  ): Promise<ChatGptUsageSummary> {
    await this.#tail.catch(() => undefined);
    const rows = account
      ? (await readEvents(this.file)).filter(
          (row) => row.accountKey === account.accountKey,
        )
      : [];
    const byModel: Record<ChatGptUsageModel, number> = {
      "gpt-6-pro": 0,
      "gpt-5.6-pro": 0,
      "pro-unknown": 0,
      other: 0,
    };
    for (const row of rows) byModel[row.model] += 1;
    const countSince = (milliseconds: number) =>
      rows.filter(
        (row) =>
          Date.parse(row.acceptedAt) >= now - milliseconds &&
          Date.parse(row.acceptedAt) <= now,
      ).length;
    return {
      windows: (account
        ? (CHATGPT_USAGE_POLICY.allowances[account.plan] ?? [])
        : []
      ).map((allowance) => {
        const days =
          allowance.window === "day" ? 1 : allowance.window === "week" ? 7 : 30;
        const accepted = rows.filter(
          (row) =>
            allowance.models.includes(row.model) &&
            Date.parse(row.acceptedAt) >= now - days * 86400000 &&
            Date.parse(row.acceptedAt) <= now,
        ).length;
        const percent = Math.round((accepted / allowance.messages) * 1000) / 10;
        return {
          id: allowance.id,
          accepted,
          messages: allowance.messages,
          window: allowance.window,
          percent,
          nearLimit: accepted / allowance.messages >= 0.75,
          shared: allowance.shared,
        };
      }),
      accountObserved: account !== undefined,
      ...(account
        ? {
            accountKeyHint: account.accountKey.slice(0, 12),
            plan: account.plan,
          }
        : {}),
      supported: account !== undefined && account.plan !== "unsupported",
      needsAttention: account?.needsAttention === true,
      policy: CHATGPT_USAGE_POLICY,
      accepted: {
        retainedEvents: rows.length,
        last24Hours: countSince(24 * 60 * 60_000),
        last7Days: countSince(7 * 24 * 60 * 60_000),
        last30Days: countSince(30 * 24 * 60 * 60_000),
        byModel,
        ...(rows[0]?.acceptedAt
          ? { oldestRetainedAt: rows[0].acceptedAt }
          : {}),
        ...(rows.at(-1)?.acceptedAt
          ? { newestRetainedAt: rows.at(-1)!.acceptedAt }
          : {}),
      },
      officialRemainingObserved: false,
      resetTimeObserved: false,
      externalChatGptMessagesIncluded: false,
    };
  }
}
