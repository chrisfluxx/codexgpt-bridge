export interface DownloadedImage {
  readonly bytes: Buffer;
  readonly extension: string;
  readonly mimeType: string;
}

const EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

/** Preserve committed prose on media failure, without disguising cancellation or tool calls. */
export async function withMediaTextFallback<T>(
  text: string,
  transfer: () => Promise<T>,
  signal: AbortSignal,
): Promise<T | string> {
  signal.throwIfAborted();
  try {
    const result = await transfer();
    signal.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    if (!text.trim() || /<\/?codex_tool_calls\b/i.test(text)) throw error;
    return `${text.trim()}\n\n> Bridge 提示：這則回覆的圖片未能傳回 Codex；上方文字已保留。圖片請到對應的 Web ChatGPT 對話查看。`;
  }
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function imageUrl(value: string): URL {
  const url = new URL(value);
  const allowed =
    url.hostname === "chatgpt.com" ||
    url.hostname === "openai.com" ||
    url.hostname.endsWith(".openai.com") ||
    url.hostname === "openaiusercontent.com" ||
    url.hostname.endsWith(".openaiusercontent.com");
  if (url.protocol !== "https:" || !allowed || url.username || url.password) {
    throw new Error(
      "ChatGPT image source is not a supported HTTPS image host.",
    );
  }
  return url;
}

/** One bounded, cancellable transfer stage; never silently drop an unsupported image. */
export async function downloadGeneratedImages(
  urls: readonly string[],
  fetchImage: (url: string, init: RequestInit) => Promise<Response>,
  callerSignal: AbortSignal,
  options: {
    timeoutMs?: number;
    maxImageBytes?: number;
    maxTotalBytes?: number;
  } = {},
): Promise<readonly DownloadedImage[]> {
  const unique = [...new Set(urls)];
  if (unique.length > 10)
    throw new Error("ChatGPT generated more than 10 images in one turn.");
  const signal = AbortSignal.any([
    callerSignal,
    AbortSignal.timeout(options.timeoutMs ?? 60_000),
  ]);
  const maxImageBytes = options.maxImageBytes ?? 20_000_000;
  const maxTotalBytes = options.maxTotalBytes ?? 50_000_000;
  const downloads: DownloadedImage[] = [];
  let totalBytes = 0;
  try {
    for (const value of unique) {
      signal.throwIfAborted();
      let url = imageUrl(value);
      let response: Response | undefined;
      for (let redirects = 0; redirects <= 5; redirects++) {
        response = await abortable(
          fetchImage(url.toString(), {
            credentials: "include",
            signal,
            redirect: "manual",
          }),
          signal,
        );
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        void response.body?.cancel().catch(() => undefined);
        if (!location || redirects === 5)
          throw new Error(
            "ChatGPT image download exceeded its redirect limit.",
          );
        url = imageUrl(new URL(location, url).toString());
      }
      if (!response?.ok || !response.body) {
        void response?.body?.cancel().catch(() => undefined);
        throw new Error(
          `ChatGPT generated image download failed with HTTP ${response?.status ?? "unknown"}.`,
        );
      }
      const reader = response.body.getReader();
      const onAbort = (): void => {
        void reader.cancel(signal.reason).catch(() => undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      let finished = false;
      try {
        signal.throwIfAborted();
        const mimeType = (response.headers.get("content-type") ?? "")
          .split(";", 1)[0]!
          .trim()
          .toLowerCase();
        const extension = EXTENSIONS.get(mimeType);
        if (!extension)
          throw new Error(
            `ChatGPT generated image has unsupported media type: ${mimeType || "unknown"}.`,
          );
        const declared = Number(response.headers.get("content-length") ?? 0);
        if (declared > maxImageBytes || declared + totalBytes > maxTotalBytes)
          throw new Error(
            "ChatGPT generated image exceeds the transfer size limit.",
          );
        const chunks: Uint8Array[] = [];
        let length = 0;
        while (true) {
          signal.throwIfAborted();
          const chunk = await abortable(reader.read(), signal);
          signal.throwIfAborted();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          totalBytes += chunk.value.byteLength;
          if (length > maxImageBytes || totalBytes > maxTotalBytes)
            throw new Error(
              "ChatGPT generated image exceeds the transfer size limit.",
            );
          chunks.push(chunk.value);
        }
        if (length === 0)
          throw new Error("ChatGPT generated image download was empty.");
        finished = true;
        downloads.push({ bytes: Buffer.concat(chunks), extension, mimeType });
      } finally {
        signal.removeEventListener("abort", onAbort);
        if (!finished) void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    return downloads;
  } catch (error) {
    callerSignal.throwIfAborted();
    if (signal.aborted)
      throw new Error(
        "ChatGPT image transfer timed out. The response was not completed; retry the transfer.",
        { cause: error },
      );
    throw error;
  }
}
