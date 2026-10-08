import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { desktopCommand } from "./provider-client.js";

it("management uses a private loopback bearer token and rejects remote control metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-cli-control-"));
  const file = join(directory, "control.json");
  const metadata = {
    version: 1,
    endpoint: "http://127.0.0.1:7767",
    token: "a".repeat(64),
  };
  try {
    await writeFile(file, JSON.stringify(metadata));
    let called = false;
    const fetchImpl: typeof fetch = async (url, options) => {
      called = true;
      assert.equal(url, "http://127.0.0.1:7767/admin/command");
      assert.equal(
        new Headers(options?.headers).get("authorization"),
        `Bearer ${metadata.token}`,
      );
      assert.deepEqual(JSON.parse(String(options?.body)), {
        command: "settings:set-advanced",
        args: [{ freshConversationPerTurn: true }],
      });
      assert.equal(options?.redirect, "error");
      return Response.json({ result: { saved: true } });
    };
    assert.deepEqual(
      await desktopCommand(
        file,
        "settings:set-advanced",
        [{ freshConversationPerTurn: true }],
        fetchImpl,
      ),
      { saved: true },
    );
    assert.equal(called, true);
    for (const endpoint of [
      "https://example.com/",
      "http://localhost.evil/",
      "http://127.0.0.1:7767/?redirect=evil",
      "http://user:pass@127.0.0.1/",
    ]) {
      await writeFile(file, JSON.stringify({ ...metadata, endpoint }));
      await assert.rejects(
        desktopCommand(file, "provider:install", [], async () => {
          throw new Error("Must not send credentials");
        }),
        /loopback/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
