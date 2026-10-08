import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const cliPath = fileURLToPath(
  new URL("../../../../apps/cli/dist/main.js", import.meta.url),
);

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CLI doctor", () => {
  it("emits a content-free structured report and writes it privately", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexgpt-cli-doctor-"));
    directories.push(directory);
    const env = {
      ...process.env,
      CODEX_HOME: join(directory, "codex-home"),
      CODEXGPT_BRIDGE_STATE_DB: join(directory, "state.sqlite"),
    };
    const direct = await execFileAsync(process.execPath, [cliPath, "doctor"], {
      env,
      encoding: "utf8",
      windowsHide: true,
    });
    const report = JSON.parse(direct.stdout) as {
      schemaVersion: number;
      status: string;
      checks: readonly { id: string }[];
      privacy: Record<string, boolean>;
    };
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.status, "attention");
    assert.equal(
      report.checks.some((check) => check.id === "node"),
      true,
    );
    assert.deepEqual(report.privacy, {
      promptsIncluded: false,
      responsesIncluded: false,
      credentialsIncluded: false,
      absolutePathsIncluded: false,
    });
    assert.equal(direct.stdout.includes(directory), false);

    const output = join(directory, "doctor.json");
    await execFileAsync(
      process.execPath,
      [cliPath, "doctor", "--output", output],
      { env, encoding: "utf8", windowsHide: true },
    );
    const saved = JSON.parse(await readFile(output, "utf8")) as {
      schemaVersion: number;
    };
    assert.equal(saved.schemaVersion, 1);
  });

  it("rejects unknown doctor arguments", async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "doctor", "--unknown"], {
        encoding: "utf8",
        windowsHide: true,
      }),
      /Unknown doctor argument/u,
    );
  });
});
