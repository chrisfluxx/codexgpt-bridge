import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { recordModelDiagnostic } from "./model-diagnostics.js";

it("does not inspect the page when structural diagnostics are disabled", async () => {
  assert.equal(
    await recordModelDiagnostic(
      "unused",
      async () => {
        assert.fail("collection must be opt-in");
      },
      false,
    ),
    false,
  );
});

it("keeps only bounded structure and overwrites earlier diagnostic content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-safe-menu-"));
  try {
    const file = join(directory, "menu-debug.json");
    await writeFile(file, "old-sensitive-data");
    assert.equal(
      await recordModelDiagnostic(
        directory,
        async () => ({
          menuState: "closed",
          composerFound: true,
          rootsCount: 3,
          elementsCount: 999_999,
          slidersCount: -1,
          effortsCount: "5",
          modelsCount: NaN,
          text: "private prompt",
          url: "https://chatgpt.com/c/private-id?secret=token",
          error: "Bearer token",
          roots: [{ text: "private title" }],
        }),
        true,
      ),
      true,
    );
    const raw = await readFile(file, "utf8");
    const data = JSON.parse(raw);
    assert.deepEqual(Object.keys(data).sort(), [
      "capturedAt",
      "composerFound",
      "elementsCount",
      "menuState",
      "rootsCount",
      "version",
    ]);
    assert.equal(data.rootsCount, 3);
    assert.equal(data.elementsCount, 100_000);
    assert.doesNotMatch(raw, /private|token|Bearer|old-sensitive|https:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("collector and filesystem failures cannot mask a model failure", async () => {
  assert.equal(
    await recordModelDiagnostic(
      "unused",
      async () => {
        throw new Error("page lost");
      },
      true,
    ),
    false,
  );
  const directory = await mkdtemp(join(tmpdir(), "bridge-menu-failure-"));
  try {
    const occupied = join(directory, "file");
    await writeFile(occupied, "file");
    assert.equal(
      await recordModelDiagnostic(
        occupied,
        async () => ({ menuState: "loading" }),
        true,
      ),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
