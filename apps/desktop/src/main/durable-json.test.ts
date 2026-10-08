import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { writeDurableJson } from "./durable-json.js";
import {
  CompletionDiagnosticStore,
  CompletionTrace,
} from "./completion-diagnostics.js";

it("keeps the last valid state when the primary is zero-filled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-durable-json-"));
  try {
    const file = join(directory, "state.json");
    await writeDurableJson(file, '{"generation":1}');
    await writeDurableJson(file, '{"generation":2}');
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      generation: 2,
    });
    assert.deepEqual(JSON.parse(await readFile(`${file}.previous`, "utf8")), {
      generation: 1,
    });
    await writeFile(file, Buffer.alloc(512));
    await assert.rejects(writeDurableJson(file, '{"generation":3}'));
    assert.deepEqual(JSON.parse(await readFile(`${file}.previous`, "utf8")), {
      generation: 1,
    });
    assert.deepEqual((await readdir(directory)).sort(), [
      "state.json",
      "state.json.previous",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("diagnostics retain a valid recovery copy across a restart", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "bridge-durable-diagnostics-"),
  );
  try {
    const file = join(directory, "diagnostics.json");
    await new CompletionDiagnosticStore(file).record(
      new CompletionTrace("first").finish("completed"),
    );
    await new CompletionDiagnosticStore(file).record(
      new CompletionTrace("second").finish("completed"),
    );
    assert.equal(JSON.parse(await readFile(file, "utf8")).length, 2);
    assert.equal(
      JSON.parse(await readFile(`${file}.previous`, "utf8"))[0].operationId,
      "first",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
