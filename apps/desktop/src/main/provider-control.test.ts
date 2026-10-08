import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ProviderControlStore,
  runCodexInterruptHook,
} from "./provider-control.js";

describe("provider control metadata", () => {
  it("publishes a private control capability and clears only its own instance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-control-"));
    const path = join(directory, "provider-control.json");
    const store = new ProviderControlStore(path);
    const first = await store.publish("http://127.0.0.1:43123");
    const second = await store.publish("http://127.0.0.1:43124");
    await store.clear(first.instanceId);
    assert.equal(
      (JSON.parse(await readFile(path, "utf8")) as { instanceId: string })
        .instanceId,
      second.instanceId,
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    await store.clear(second.instanceId);
    await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
  });

  it("forwards only an exact validated Interrupt identity with bearer auth", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-control-"));
    const path = join(directory, "provider-control.json");
    const metadata = await new ProviderControlStore(path).publish(
      "http://127.0.0.1:43123",
    );
    let request: { url: string; init: RequestInit | undefined } | undefined;
    await runCodexInterruptHook(
      path,
      JSON.stringify({
        hook_event_name: "Interrupt",
        session_id: "thread_123456",
        turn_id: "turn_123456",
      }),
      async (input, init) => {
        request = { url: String(input), init };
        return Response.json({
          status: "ok",
          cancelled_http_turns: 1,
          cancelled_browser_turns: 1,
        });
      },
    );
    assert.equal(request?.url, "http://127.0.0.1:43123/admin/interrupt-turn");
    assert.equal(
      (request?.init?.headers as Record<string, string>).authorization,
      `Bearer ${metadata.token}`,
    );
    assert.deepEqual(JSON.parse(String(request?.init?.body)) as unknown, {
      thread_id: "thread_123456",
      turn_id: "turn_123456",
    });
  });

  it("rejects malformed hooks and non-loopback control metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-control-"));
    const path = join(directory, "provider-control.json");
    await new ProviderControlStore(path).publish("http://127.0.0.1:43123");
    await assert.rejects(
      runCodexInterruptHook(
        path,
        JSON.stringify({
          hook_event_name: "Interrupt",
          session_id: "short",
          turn_id: "turn_123456",
        }),
      ),
      /valid session_id/u,
    );
    await assert.rejects(
      new ProviderControlStore(join(directory, "bad.json")).publish(
        "https://example.com",
      ),
      /loopback/u,
    );
  });
});
