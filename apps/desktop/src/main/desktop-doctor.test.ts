import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runDesktopDoctor } from "./desktop-doctor.js";
import { CHATGPT_USAGE_POLICY } from "./chatgpt-usage-policy.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("desktop doctor", () => {
  it("reports integrity failures and redacts absolute home paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "codexgpt-doctor-"));
    directories.push(home);
    const settings = join(home, "desktop-settings.json");
    await writeFile(settings, "{}", "utf8");
    const report = await runDesktopDoctor({
      appVersion: "0.1.64",
      platform: "win32",
      arch: "x64",
      homeDirectory: home,
      secureStorageAvailable: true,
      settingsLoaded: true,
      provider: {
        installed: true,
        repairable: true,
        running: false,
        browserSignedIn: false,
      },
      update: { phase: "unconfigured", currentVersion: "0.1.64" },
      usage: {
        accountObserved: false,
        supported: false,
        needsAttention: false,
        policy: CHATGPT_USAGE_POLICY,
        accepted: {
          retainedEvents: 0,
          last24Hours: 0,
          last7Days: 0,
          last30Days: 0,
          byModel: {
            "gpt-6-pro": 0,
            "gpt-5.6-pro": 0,
            "pro-unknown": 0,
            other: 0,
          },
        },
        officialRemainingObserved: false,
        resetTimeObserved: false,
        externalChatGptMessagesIncluded: false,
      },
      files: [
        {
          id: "settings-file",
          label: "Settings",
          path: settings,
          required: true,
          repairable: false,
        },
        {
          id: "catalog-file",
          label: "Catalog",
          path: join(home, "missing.json"),
          required: true,
          repairable: true,
        },
      ],
    });
    assert.equal(report.overall, "broken");
    assert.equal(
      report.checks.find((check) => check.id === "catalog-file")?.repairable,
      true,
    );
    assert.equal(JSON.stringify(report).includes(home), false);
    assert.equal(report.privacy.credentialsIncluded, false);
    assert.equal(report.privacy.promptsIncluded, false);
  });
});
