import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { CookiesSetDetails, Session } from "electron";
import { importStartupChatGptSession } from "./startup-session-handoff.js";

test("ordinary startup does not open an authentication session", async () => {
  await importStartupChatGptSession(
    () => {
      throw new Error("unexpected session");
    },
    undefined,
    undefined,
  );
});

for (const permitted of [true, false]) {
  test(
    permitted
      ? "session-only cookies stay session-only and acknowledgement follows flush"
      : "a handoff outside ChatGPT/OpenAI is rejected without installing cookies",
    async () => {
      const installed: CookiesSetDetails[] = [];
      let flushed = false;
      let acknowledged = false;
      const token = "ab".repeat(32);
      const server = createServer((request, response) => {
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        if (request.url === "/session") {
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              cookies: [
                {
                  name: "fixture_session",
                  value: "fixture",
                  domain: permitted ? ".chatgpt.com" : ".unrelated.test",
                  path: "/",
                  secure: true,
                  httpOnly: true,
                  sameSite: "None",
                  expires: -1,
                },
              ],
              origins: [],
            }),
          );
        } else {
          assert.equal(request.method, "POST");
          assert.equal(request.url, "/ready");
          assert.equal(flushed, true);
          acknowledged = true;
          response.writeHead(204).end();
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const owned = {
        cookies: {
          set: async (cookie: CookiesSetDetails) => {
            installed.push(cookie);
          },
          flushStore: async () => {
            flushed = true;
          },
        },
      } as unknown as Session;
      try {
        const run = () =>
          importStartupChatGptSession(() => owned, String(address.port), token);
        if (permitted) {
          await run();
          assert.equal(installed.length, 1);
          assert.equal(installed[0]?.expirationDate, undefined);
          assert.equal(acknowledged, true);
        } else {
          await assert.rejects(run, /session handoff failed/);
          assert.equal(installed.length, 0);
          assert.equal(acknowledged, false);
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
}
