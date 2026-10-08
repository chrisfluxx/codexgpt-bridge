import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { UpdateReminders } from "./update-reminders.js";
import type { ReleaseUpdateStatus } from "./release-update.js";

const directories: string[] = [];
const reminders: UpdateReminders[] = [];
afterEach(async () => {
  for (const reminder of reminders.splice(0)) reminder.stop();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bridge-update-reminder-"));
  directories.push(directory);
  let status: ReleaseUpdateStatus = {
    phase: "idle",
    currentVersion: "0.1.68",
    manifestPath: join(directory, "release-manifest.json"),
  };
  let version = "0.1.69";
  let checks = 0;
  let offline = false;
  const notified: string[] = [];
  const manager = {
    status: () => status,
    check: async () => {
      checks++;
      if (offline) throw new Error("offline");
      status = {
        ...status,
        phase: "available",
        availableVersion: version,
        checkedAt: new Date().toISOString(),
      };
      return status;
    },
  };
  function create() {
    const reminder = new UpdateReminders(
      manager,
      join(directory, "notified.json"),
      () => undefined,
      (next) => {
        notified.push(next);
        return true;
      },
    );
    reminders.push(reminder);
    return reminder;
  }
  return {
    create,
    notified,
    checks: () => checks,
    setVersion: (next: string) => {
      version = next;
    },
    setStatus: (next: ReleaseUpdateStatus) => {
      status = next;
    },
    status: () => status,
    setOffline: () => {
      offline = true;
    },
  };
}

it("checks at startup, suppresses repeats across restarts, and announces a later version", async () => {
  const test = await fixture();
  const first = test.create();
  await first.start();
  await first.check();
  first.stop();
  const restarted = test.create();
  await restarted.start();
  assert.deepEqual(test.notified, ["0.1.69"]);
  test.setVersion("0.1.70");
  await restarted.check();
  assert.deepEqual(test.notified, ["0.1.69", "0.1.70"]);
  test.setVersion("0.1.69");
  await restarted.check();
  assert.equal(test.notified.length, 2);
});

it("checks the local source again on the background minute timer", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const test = await fixture();
  const reminder = test.create();
  await reminder.start();
  test.setVersion("0.1.70");
  context.mock.timers.tick(60_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(test.checks(), 2);
  assert.deepEqual(test.notified, ["0.1.69", "0.1.70"]);
});

it("preserves a downloaded or installing update and stops checking after shutdown", async () => {
  const test = await fixture();
  const reminder = test.create();
  await reminder.start();
  for (const phase of ["ready", "downloading", "installing"] as const) {
    test.setStatus({ ...test.status(), phase });
    await reminder.check();
    assert.equal(test.checks(), 1);
  }
  reminder.stop();
  test.setStatus({ ...test.status(), phase: "idle" });
  await reminder.check();
  assert.equal(test.checks(), 1);
});

it("limits online checks to six hours while a manual check can refresh immediately", async () => {
  const test = await fixture();
  test.setStatus({
    phase: "idle",
    currentVersion: "0.1.68",
    manifestUrl: "https://updates.example.test/manifest.json",
  });
  const reminder = test.create();
  await reminder.start();
  await reminder.check();
  assert.equal(test.checks(), 1);
  await reminder.check(true);
  assert.equal(test.checks(), 2);
});

it("keeps background failures quiet and never announces an unconfigured source", async () => {
  const test = await fixture();
  const reminder = test.create();
  test.setOffline();
  await reminder.start();
  assert.deepEqual(test.notified, []);
  test.setStatus({ phase: "unconfigured", currentVersion: "0.1.68" });
  await reminder.check();
  assert.equal(test.checks(), 1);
});
