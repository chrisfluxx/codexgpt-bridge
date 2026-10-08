import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { ChatGptConversations } from "./chatgpt-conversations.js";
import {
  OperationJournal,
  OperationRecoveryError,
} from "./operation-journal.js";

it("persists send intent across restart and allows only pre-submit retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-operations-"));
  try {
    const file = join(directory, "operations.json");
    const journal = new OperationJournal(file);
    await journal.begin("a".repeat(64));
    await journal.mark("a".repeat(64), "failed");
    const restarted = new OperationJournal(file);
    await restarted.begin("a".repeat(64));
    await restarted.mark("a".repeat(64), "submitting");
    await assert.rejects(
      new OperationJournal(file).begin("a".repeat(64)),
      OperationRecoveryError,
    );
    await restarted.mark("a".repeat(64), "failed");
    await assert.rejects(
      new OperationJournal(file).begin("a".repeat(64)),
      OperationRecoveryError,
    );
    await restarted.begin("b".repeat(64));
    await restarted.mark("b".repeat(64), "result-ready");
    await assert.rejects(
      new OperationJournal(file).begin("b".repeat(64)),
      OperationRecoveryError,
    );
    const raw = await readFile(file, "utf8");
    assert.doesNotMatch(raw, /prompt|cookie|token|arguments|responseBody/);
    await writeFile(file, "broken");
    await assert.rejects(new OperationJournal(file).begin("c".repeat(64)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("persists ordered multipart acknowledgements without payloads and blocks uncertain restart replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-stage-journal-"));
  try {
    const file = join(directory, "operations.json");
    const key = "d".repeat(64);
    const transaction = `ctx_${"a".repeat(32)}`;
    const journal = new OperationJournal(file);
    await journal.begin(key);
    await journal.mark(key, "submitting");
    await journal.acknowledgeContextStage(
      key,
      transaction,
      1,
      3,
      "b".repeat(64),
    );
    await assert.rejects(
      journal.acknowledgeContextStage(key, transaction, 3, 3, "c".repeat(64)),
      /in order/,
    );
    await journal.acknowledgeContextStage(
      key,
      transaction,
      2,
      3,
      "c".repeat(64),
    );
    await journal.acknowledgeContextStage(
      key,
      transaction,
      2,
      3,
      "c".repeat(64),
    );
    await assert.rejects(
      journal.acknowledgeContextStage(key, transaction, 2, 3, "f".repeat(64)),
      /changed its digest/,
    );
    await assert.rejects(
      journal.acknowledgeContextStage(
        key,
        `ctx_${"e".repeat(32)}`,
        1,
        3,
        "b".repeat(64),
      ),
      /another transaction/,
    );
    const raw = await readFile(file, "utf8");
    const rows = JSON.parse(raw);
    assert.deepEqual(rows[0].contextTransfer, {
      transactionId: transaction,
      total: 3,
      acknowledgements: [
        { part: 1, digest: "b".repeat(64) },
        { part: 2, digest: "c".repeat(64) },
      ],
    });
    assert.doesNotMatch(
      raw,
      /prompt|cookie|turn_token|arguments|responseBody|chunk/,
    );
    await assert.rejects(
      new OperationJournal(file).begin(key),
      OperationRecoveryError,
    );
    rows[0].contextTransfer = null;
    await writeFile(file, JSON.stringify(rows));
    await assert.rejects(
      new OperationJournal(file).begin("f".repeat(64)),
      /Invalid operation journal/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("task-bound ChatGPT conversations", () => {
  it("expires mappings after 90-day-style inactivity and renews them when used", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-retention-"));
    try {
      const file = join(directory, "conversations.json");
      let now = 1_000;
      const options = { now: () => now, mappingTtlMs: 1_000 };
      const store = new ChatGptConversations(
        "https://chatgpt.com/",
        file,
        options,
      );
      await store.remember("task-renew", "https://chatgpt.com/c/renewed");
      now = 1_750;
      assert.equal(
        await store.get("task-renew"),
        "https://chatgpt.com/c/renewed",
      );

      now = 2_500;
      assert.equal(
        await new ChatGptConversations(
          "https://chatgpt.com/",
          file,
          options,
        ).get("task-renew"),
        "https://chatgpt.com/c/renewed",
      );

      now = 3_501;
      assert.equal(
        await new ChatGptConversations(
          "https://chatgpt.com/",
          file,
          options,
        ).get("task-renew"),
        undefined,
      );
      assert.doesNotMatch(await readFile(file, "utf8"), /renewed/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates legacy mappings and prunes least-recently-used tasks near capacity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-lru-"));
    try {
      const file = join(directory, "conversations.json");
      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          conversations: [["legacy-task", "https://chatgpt.com/c/legacy"]],
          receipts: [],
          projects: [],
          temporary: [["legacy-task", false]],
        }),
      );
      let now = 10_000;
      const options = {
        now: () => now,
        mappingTtlMs: 100_000,
        mappingCapacity: 4,
        mappingPruneAt: 3,
        mappingPruneTo: 1,
      };
      const store = new ChatGptConversations(
        "https://chatgpt.com/",
        file,
        options,
      );
      assert.equal(
        await store.get("legacy-task"),
        "https://chatgpt.com/c/legacy",
      );
      assert.match(await readFile(file, "utf8"), /"accessed"/);

      now += 1;
      await store.remember("task-two", "https://chatgpt.com/c/two");
      now += 1;
      await store.remember("task-three", "https://chatgpt.com/c/three");
      now += 1;
      await store.remember("task-four", "https://chatgpt.com/c/four");

      assert.equal(await store.get("legacy-task"), undefined);
      assert.equal(await store.get("task-two"), undefined);
      assert.equal(
        await store.get("task-three"),
        "https://chatgpt.com/c/three",
      );
      assert.equal(await store.get("task-four"), "https://chatgpt.com/c/four");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("pins temporary mode across restart without persisting URLs or receipts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-temporary-modes-"));
    try {
      const file = join(directory, "conversations.json");
      const store = new ChatGptConversations("https://chatgpt.com/", file);
      await store.remember("legacy-task", "https://chatgpt.com/c/legacy-id");
      assert.equal(await store.selectTemporaryMode("legacy-task", true), false);
      assert.equal(await store.selectTemporaryMode("temp-task", true), true);
      await store.remember(
        "temp-task",
        "https://chatgpt.com/c/temporary-canary",
        {
          ledger: [],
          instructions: "private-receipt",
          contract: "private-contract",
          generation: 1,
        },
      );
      assert.equal(await store.get("temp-task"), undefined);
      assert.equal(await store.receipt("temp-task"), undefined);
      assert.doesNotMatch(
        await readFile(file, "utf8"),
        /temporary-canary|private-receipt|private-contract/,
      );
      assert.equal(
        await store.selectTemporaryMode("standard-task", false),
        false,
      );
      const restarted = new ChatGptConversations("https://chatgpt.com/", file);
      assert.equal(
        await restarted.selectTemporaryMode("temp-task", false),
        true,
      );
      assert.equal(
        await restarted.selectTemporaryMode("standard-task", true),
        false,
      );
      assert.equal(
        await restarted.selectTemporaryMode("new-task", false),
        false,
      );
      await restarted.remember("new-task", "https://chatgpt.com/c/new-chat");
      assert.equal(
        await new ChatGptConversations(
          "https://chatgpt.com/",
          file,
        ).selectTemporaryMode("temp-task", false),
        true,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("restores project chats and their rebuild destination across restart without changing legacy chats", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-projects-"));
    try {
      const file = join(directory, "conversations.json");
      const project = "https://chatgpt.com/g/g-p-fixture/project";
      const store = new ChatGptConversations("https://chatgpt.com/", file);
      await store.remember(
        "task-project",
        project.replace("/project", "/c/chat-123"),
        undefined,
        project,
      );
      await store.remember(
        "task-canonical",
        "https://chatgpt.com/c/chat-456",
        undefined,
        project,
      );
      await store.remember("task-legacy", "https://chatgpt.com/c/chat-789");
      const restarted = new ChatGptConversations("https://chatgpt.com/", file);
      assert.equal(
        await restarted.get("task-project"),
        project.replace("/project", "/c/chat-123"),
      );
      assert.equal(await restarted.projectUrl("task-project"), project);
      assert.equal(await restarted.projectUrl("task-canonical"), project);
      assert.equal(await restarted.projectUrl("task-legacy"), undefined);
      const inferred = new ChatGptConversations("https://chatgpt.com/");
      await inferred.remember(
        "task-inferred",
        project.replace("/project", "/c/chat-222"),
      );
      assert.equal(await inferred.projectUrl("task-inferred"), project);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("keeps two tasks isolated across a provider restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-conversations-"));
    try {
      const file = join(directory, "conversations.json");
      const store = new ChatGptConversations("https://chatgpt.com/", file);
      await store.remember(
        "task-aaa",
        "https://chatgpt.com/c/aaaa-1111?tracking=discard",
      );
      await store.remember("task-bbb", "https://chatgpt.com/c/bbbb-2222");
      assert.equal(
        await store.get("task-aaa"),
        "https://chatgpt.com/c/aaaa-1111",
      );
      const restarted = new ChatGptConversations("https://chatgpt.com/", file);
      assert.equal(
        await restarted.get("task-bbb"),
        "https://chatgpt.com/c/bbbb-2222",
      );
      assert.equal(
        await restarted.get("task-aaa"),
        "https://chatgpt.com/c/aaaa-1111",
      );
      assert.equal(await restarted.get("task-new"), undefined);
      assert.doesNotMatch(await readFile(file, "utf8"), /tracking/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not remember login, foreign, or malformed conversation URLs", async () => {
    const store = new ChatGptConversations("https://chatgpt.com/");
    for (const url of [
      "https://chatgpt.com/auth/login",
      "https://evil.example/c/chat",
      "https://chatgpt.com/",
      "https://user:password@chatgpt.com/c/chat",
    ]) {
      await store.remember("task-aaa", url);
    }
    assert.equal(await store.get("task-aaa"), undefined);
  });

  it("fails closed on a corrupt mapping rather than merging task contexts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-conversations-"));
    try {
      const file = join(directory, "conversations.json");
      await writeFile(file, "broken json");
      await assert.rejects(
        new ChatGptConversations("https://chatgpt.com/", file).get("task-aaa"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("retries a repaired zero-filled mapping in the same process", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "bridge-conversations-repair-"),
    );
    try {
      const file = join(directory, "conversations.json");
      const original = new ChatGptConversations("https://chatgpt.com/", file);
      await original.remember(
        "task-aaa",
        "https://chatgpt.com/c/retained-chat",
      );
      await original.selectTemporaryMode("temp-task", true);
      const valid = await readFile(file, "utf8");
      await writeFile(file, Buffer.alloc(1024));
      const store = new ChatGptConversations("https://chatgpt.com/", file);
      await assert.rejects(store.get("task-aaa"));
      await writeFile(file, valid);
      assert.equal(
        await store.get("task-aaa"),
        "https://chatgpt.com/c/retained-chat",
      );
      assert.equal(await store.selectTemporaryMode("temp-task", false), true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
