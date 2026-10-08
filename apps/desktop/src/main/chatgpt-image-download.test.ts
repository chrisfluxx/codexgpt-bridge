import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  downloadGeneratedImages,
  withMediaTextFallback,
} from "./chatgpt-image-download.js";

const url = "https://chatgpt.com/backend-api/image/test";
const signal = (): AbortSignal => new AbortController().signal;
const image = (body = "image"): Response =>
  new Response(body, { headers: { "content-type": "image/png" } });

describe("generated image transfer", () => {
  it("preserves formatted prose with a visible warning when an image host is unsupported", async () => {
    let fetched = false;
    const text = "## Research\n\n| Source | Result |\n| --- | --- |\n| A | B |";
    const result = await withMediaTextFallback(
      text,
      () =>
        downloadGeneratedImages(
          ["https://example.org/image.png"],
          async () => {
            fetched = true;
            return image();
          },
          signal(),
        ),
      signal(),
    );
    assert.equal(fetched, false);
    assert.equal(typeof result, "string");
    assert.ok(String(result).startsWith(text + "\n\n"));
    assert.match(String(result), /圖片未能傳回 Codex/);
  });

  it("preserves prose on download failure and unloaded media without claiming image success", async () => {
    for (const error of [
      new Error("HTTP 503"),
      new Error("image did not load"),
    ]) {
      const result = await withMediaTextFallback(
        "Answer",
        async () => {
          throw error;
        },
        signal(),
      );
      assert.match(String(result), /^Answer\n\n> Bridge/);
    }
  });

  it("does not turn empty media-only failures or tool envelopes into successful prose", async () => {
    const error = new Error("transfer failed");
    for (const text of [
      "",
      "  ",
      '<codex_tool_calls>[{"name":"exec_command"}]</codex_tool_calls>',
    ]) {
      await assert.rejects(
        withMediaTextFallback(
          text,
          async () => {
            throw error;
          },
          signal(),
        ),
        error,
      );
    }
  });

  it("never hides cancellation behind completed prose", async () => {
    const controller = new AbortController();
    await assert.rejects(
      withMediaTextFallback(
        "Answer",
        async () => {
          controller.abort();
          throw new Error("transfer failed");
        },
        controller.signal,
      ),
      { name: "AbortError" },
    );
    await assert.rejects(
      withMediaTextFallback("Answer", async () => image(), controller.signal),
      { name: "AbortError" },
    );
  });

  it("returns successful media unchanged", async () => {
    const result = { images: ["image"] };
    assert.equal(
      await withMediaTextFallback("Answer", async () => result, signal()),
      result,
    );
  });
  it("bounds a stalled fetch even if its adapter ignores AbortSignal", async () => {
    const keepAlive = setInterval(() => undefined, 1_000);
    try {
      await assert.rejects(
        downloadGeneratedImages(
          [url],
          () => new Promise<Response>(() => undefined),
          signal(),
          { timeoutMs: 20 },
        ),
        /transfer timed out/,
      );
    } finally {
      clearInterval(keepAlive);
    }
  });
  it("deduplicates image URLs and preserves bytes and type", async () => {
    let calls = 0;
    const results = await downloadGeneratedImages(
      [url, url],
      async (_url, init) => {
        calls++;
        assert.equal(init.credentials, "include");
        assert.equal(init.redirect, "manual");
        return image();
      },
      signal(),
    );
    assert.equal(calls, 1);
    assert.equal(results[0]?.bytes.toString(), "image");
    assert.equal(results[0]?.extension, "png");
  });

  it("rejects unsupported images rather than reporting text-only success", async () => {
    await assert.rejects(
      downloadGeneratedImages(
        ["https://evil.example/image.png"],
        async () => image(),
        signal(),
      ),
      /supported HTTPS/,
    );
    await assert.rejects(
      downloadGeneratedImages(
        [url],
        async () =>
          new Response("login", { headers: { "content-type": "text/html" } }),
        signal(),
      ),
      /unsupported media type/,
    );
    await assert.rejects(
      downloadGeneratedImages([url], async () => image(""), signal()),
      /empty/,
    );
  });

  it("validates redirects before sending authenticated requests", async () => {
    const calls: string[] = [];
    await assert.rejects(
      downloadGeneratedImages(
        [url],
        async (target) => {
          calls.push(target);
          return new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/image" },
          });
        },
        signal(),
      ),
      /supported HTTPS/,
    );
    assert.deepEqual(calls, [url]);
  });

  it("bounds streaming bytes even without content-length", async () => {
    await assert.rejects(
      downloadGeneratedImages([url], async () => image("12345"), signal(), {
        maxImageBytes: 4,
      }),
      /size limit/,
    );
    await assert.rejects(
      downloadGeneratedImages(
        [url, url + "2"],
        async () => image("123"),
        signal(),
        { maxTotalBytes: 5 },
      ),
      /size limit/,
    );
  });

  it("times out a stalled response body", async () => {
    // Keep the test event loop alive; AbortSignal.timeout intentionally uses an unref'd timer.
    const keepAlive = setInterval(() => undefined, 1_000);
    let cancelled = false;
    try {
      await assert.rejects(
        downloadGeneratedImages(
          [url],
          async () =>
            new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
              { headers: { "content-type": "image/png" } },
            ),
          signal(),
          { timeoutMs: 20 },
        ),
        /transfer timed out/,
      );
      assert.equal(cancelled, true);
    } finally {
      clearInterval(keepAlive);
    }
  });

  it("cancels a stalled body without completing the image", async () => {
    const controller = new AbortController();
    const transfer = downloadGeneratedImages(
      [url],
      async () =>
        new Response(new ReadableStream(), {
          headers: { "content-type": "image/png" },
        }),
      controller.signal,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(transfer, { name: "AbortError" });
  });
});
