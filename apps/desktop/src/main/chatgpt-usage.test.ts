import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  ChatGptUsageStore,
  classifyChatGptUsageModel,
} from "./chatgpt-usage.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function store(): Promise<{ store: ChatGptUsageStore; file: string }> {
  const directory = await mkdtemp(join(tmpdir(), "codexgpt-usage-"));
  directories.push(directory);
  const file = join(directory, "usage.json");
  return { store: new ChatGptUsageStore(file), file };
}

const account = {
  accountKey: "a".repeat(64),
  plan: "pro_200" as const,
  personal: true,
  needsAttention: false,
};

describe("ChatGPT usage ledger", () => {
  it("calculates account-scoped rolling ratios and excludes future/out-of-window events", async () => {
    const fixture = await store();
    const now = Date.parse("2026-10-03T12:00:00Z");
    const limited = { ...account, plan: "pro_100" as const };
    for (let index = 1; index <= 39; index++) {
      await fixture.store.recordAccepted({
        eventId: index.toString(16).padStart(64, "0"),
        account: limited,
        model: "pro-unknown",
        acceptedAt: new Date(
          index === 38
            ? now + 86400000
            : index === 39
              ? now - 8 * 86400000
              : now - 1000,
        ).toISOString(),
      });
    }
    const below = await fixture.store.summary(limited, now);
    assert.equal(below.windows?.[0]?.accepted, 37);
    assert.equal(below.windows?.[0]?.percent, 74);
    assert.equal(below.windows?.[0]?.nearLimit, false);
    await fixture.store.recordAccepted({
      eventId: "f".repeat(64),
      account: limited,
      model: "gpt-6-pro",
      acceptedAt: new Date(now).toISOString(),
    });
    assert.equal(
      (await fixture.store.summary(limited, now)).windows?.[0]?.nearLimit,
      true,
    );
    assert.equal(
      (
        await fixture.store.summary(
          { ...limited, accountKey: "b".repeat(64) },
          now,
        )
      ).windows?.[0]?.accepted,
      0,
    );
    assert.equal(below.officialRemainingObserved, false);
  });
  it("classifies only verified Pro-mode labels and keeps ambiguity explicit", () => {
    assert.equal(classifyChatGptUsageModel("high", "GPT-6 Pro"), "other");
    assert.equal(classifyChatGptUsageModel("pro", "GPT-6 Astra"), "gpt-6-pro");
    assert.equal(
      classifyChatGptUsageModel("pro", "GPT-5.6 Sol Pro"),
      "gpt-5.6-pro",
    );
    assert.equal(classifyChatGptUsageModel("pro", "Latest"), "pro-unknown");
  });

  it("deduplicates accepted sends and isolates accounts without raw identity", async () => {
    const fixture = await store();
    const now = Date.parse("2026-09-29T12:00:00.000Z");
    await fixture.store.recordAccepted({
      eventId: "1".repeat(64),
      account,
      model: "gpt-6-pro",
      acceptedAt: new Date(now - 60_000).toISOString(),
    });
    await fixture.store.recordAccepted({
      eventId: "1".repeat(64),
      account,
      model: "gpt-6-pro",
      acceptedAt: new Date(now).toISOString(),
    });
    await fixture.store.recordAccepted({
      eventId: "2".repeat(64),
      account: { ...account, accountKey: "b".repeat(64) },
      model: "gpt-5.6-pro",
      acceptedAt: new Date(now).toISOString(),
    });
    const summary = await fixture.store.summary(account, now);
    assert.equal(summary.accepted.retainedEvents, 1);
    assert.equal(summary.accepted.last24Hours, 1);
    assert.equal(summary.accepted.byModel["gpt-6-pro"], 1);
    assert.equal(summary.plan, "pro_200");
    assert.equal(summary.policy.allowances.pro_200?.length, 3);
    assert.deepEqual(
      summary.policy.allowances.pro_200?.map((row) => [
        row.messages,
        row.window,
        row.shared,
      ]),
      [
        [200, "week", false],
        [170, "day", false],
        [200, "day", true],
      ],
    );
    assert.equal(summary.officialRemainingObserved, false);
    assert.equal(summary.resetTimeObserved, false);
    const persisted = await readFile(fixture.file, "utf8");
    assert.equal(persisted.includes("private"), false);
  });

  it("does not expose events until an account has been observed", async () => {
    const fixture = await store();
    await fixture.store.recordAccepted({
      eventId: "3".repeat(64),
      account,
      model: "pro-unknown",
    });
    const summary = await fixture.store.summary(undefined);
    assert.equal(summary.accountObserved, false);
    assert.equal(summary.accepted.retainedEvents, 0);
    assert.equal(summary.supported, false);
  });

  it("recognizes official Business policies without treating them as personal plans", async () => {
    const fixture = await store();
    const summary = await fixture.store.summary({
      ...account,
      plan: "business_premium",
      personal: false,
    });
    assert.equal(summary.supported, true);
    assert.equal(summary.policy.allowances.business_premium?.[0]?.messages, 50);
    assert.equal(
      summary.policy.allowances.business_premium?.[0]?.window,
      "week",
    );
  });
});
