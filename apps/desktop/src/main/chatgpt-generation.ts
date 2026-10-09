/** In-memory evidence from the page's own response stream. Never persists response bodies. */
export interface ChatGptGenerationMessage {
  id: string;
  role: string;
  recipient: string;
  channel: string;
  status: string;
  endTurn: boolean;
  text: string;
  finishedAt: number | null;
}

export interface ChatGptGenerationWatch {
  version: 1;
  requestCount: number;
  active: {
    submissionId: string;
    state: string;
    messages: ChatGptGenerationMessage[];
    cancel: Set<() => void>;
    timeoutMs: number;
  } | null;
}

/** Inject before submission. Observes a clone, without replacing the page's response body. */
export function watchChatGptGeneration(
  submissionId: string | null,
  timeoutMs = 15 * 60_000,
): void {
  const host = window as unknown as {
    __cgbGenerationWatch?: ChatGptGenerationWatch;
  };
  let watch = host.__cgbGenerationWatch;
  if (!watch) {
    watch = { version: 1, requestCount: 0, active: null };
    host.__cgbGenerationWatch = watch;
    const owner = watch;
    const originalFetch = window.fetch;
    const record = (value: unknown): Record<string, unknown> | undefined =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    window.fetch = async function (
      ...args: Parameters<typeof fetch>
    ): Promise<Response> {
      const active = owner.active;
      let relevant = false;
      try {
        const request = args[0];
        const url = new URL(
          request instanceof Request ? request.url : String(request),
          location.href,
        );
        const method =
          args[1]?.method ??
          (request instanceof Request ? request.method : "GET");
        relevant =
          method.toUpperCase() === "POST" &&
          url.origin === location.origin &&
          /^\/backend-api\/(?:f\/)?conversation\/?$/.test(url.pathname);
      } catch {
        /* Unrecognized requests are left entirely to the original fetch. */
      }
      if (relevant) owner.requestCount++;
      const response = await Reflect.apply(originalFetch, this, args);
      if (
        !relevant ||
        !active ||
        owner.active !== active ||
        !response.ok ||
        !response.headers.get("content-type")?.includes("text/event-stream")
      )
        return response;
      try {
        const reader = response.clone().body?.getReader();
        if (!reader) return response;
        active.state = "observing";
        let stopped = false;
        const cancel = (): void => {
          stopped = true;
          // Do not await tee cancellation: the original reader may still be active.
          void reader.cancel().catch(() => undefined);
        };
        active.cancel.add(cancel);
        const timer = setTimeout(cancel, active.timeoutMs);
        void (async () => {
          const decoder = new TextDecoder();
          let pending = "";
          let bytes = 0;
          let current: ChatGptGenerationMessage | undefined;
          let lastPath = "";
          let lastOperation = "";
          const publish = (): void => {
            if (!current) return;
            if (current.text.length > 2_000_000) {
              active.messages = [];
              active.state = "limit-reached";
              current = undefined;
              cancel();
              return;
            }
            const terminal =
              current.role === "assistant" &&
              current.recipient === "all" &&
              (current.channel === "" || current.channel === "final") &&
              current.status === "finished_successfully" &&
              current.endTurn;
            current.finishedAt = terminal
              ? (current.finishedAt ?? Date.now())
              : null;
            const index = active.messages.findIndex(
              (message) => message.id === current!.id,
            );
            if (index !== -1) active.messages.splice(index, 1);
            active.messages.push({ ...current });
            if (active.messages.length > 8) active.messages.shift();
          };
          const apply = (value: unknown, depth = 0): void => {
            const event = record(value);
            if (!event) return;
            if (depth > 2) {
              active.messages = [];
              current = undefined;
              return;
            }
            const full =
              record(event.message) ?? record(record(event.v)?.message);
            if (
              full &&
              (typeof full.id !== "string" || !/^[\w-]{1,128}$/.test(full.id))
            ) {
              active.messages = [];
              current = undefined;
              return;
            }
            if (
              full &&
              typeof full.id === "string" &&
              /^[\w-]{1,128}$/.test(full.id)
            ) {
              const author = record(full.author);
              const content = record(full.content);
              // Only complete text message snapshots are understood; other modalities fail closed.
              if (
                content?.content_type !== "text" ||
                !Array.isArray(content.parts) ||
                content.parts.length !== 1 ||
                !content.parts.every((part) => typeof part === "string")
              ) {
                active.messages = [];
                current = undefined;
                return;
              }
              current = {
                id: full.id,
                role: String(author?.role ?? ""),
                recipient:
                  typeof full.recipient === "string" ? full.recipient : "all",
                channel: typeof full.channel === "string" ? full.channel : "",
                status: typeof full.status === "string" ? full.status : "",
                endTurn: full.end_turn === true,
                text: content.parts.join(""),
                finishedAt: null,
              };
              lastPath = "";
              lastOperation = "";
              publish();
              return;
            }
            if (event.o === "patch" && Array.isArray(event.v)) {
              if (event.v.length > 128) {
                active.messages = [];
                current = undefined;
                return;
              }
              for (const patch of event.v) apply(patch, depth + 1);
              return;
            }
            if (!current) return;
            const path = typeof event.p === "string" ? event.p : lastPath;
            const operation =
              typeof event.o === "string" ? event.o : lastOperation;
            lastPath = path;
            lastOperation = operation;
            if (
              path === "/message/content/parts/0" &&
              typeof event.v === "string"
            ) {
              if (operation === "append") current.text += event.v;
              else if (operation === "replace") current.text = event.v;
              else {
                active.messages = [];
                current = undefined;
                return;
              }
            } else if (
              operation === "replace" &&
              path === "/message/status" &&
              typeof event.v === "string"
            )
              current.status = event.v;
            else if (
              operation === "replace" &&
              path === "/message/end_turn" &&
              typeof event.v === "boolean"
            )
              current.endTurn = event.v;
            else if (
              operation === "replace" &&
              path === "/message/recipient" &&
              typeof event.v === "string"
            )
              current.recipient = event.v;
            else if (
              operation === "replace" &&
              path === "/message/channel" &&
              typeof event.v === "string"
            )
              current.channel = event.v;
            else if (
              path.startsWith("/message/content") ||
              path === "/message" ||
              path === "/message/id" ||
              path.startsWith("/message/author") ||
              path === "/message/status" ||
              path === "/message/end_turn" ||
              path === "/message/recipient" ||
              path === "/message/channel"
            ) {
              // Unknown content/identity patches invalidate proof, never guess the final body.
              active.messages = active.messages.filter(
                (message) => message.id !== current!.id,
              );
              current = undefined;
              return;
            } else return;
            publish();
          };
          try {
            while (!stopped && owner.active === active) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              pending += decoder.decode(chunk.value, { stream: true });
              if (bytes > 32_000_000 || pending.length > 2_000_000) {
                active.state = "limit-reached";
                cancel();
                break;
              }
              let end: number;
              while ((end = pending.indexOf("\n")) !== -1) {
                const line = pending.slice(0, end).replace(/\r$/, "");
                pending = pending.slice(end + 1);
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                // EOF and [DONE] alone are never evidence that an assistant turn finished.
                if (!data || data === "[DONE]") continue;
                try {
                  apply(JSON.parse(data) as unknown);
                } catch {
                  active.messages = [];
                  current = undefined;
                }
              }
            }
          } catch {
            // Current ChatGPT can abort the fetch after it has already emitted a
            // successful end_turn. Preserve that completed message as evidence;
            // only an abort before terminal proof is a stream failure.
            if (
              owner.active === active &&
              !active.messages.some((message) => message.finishedAt !== null)
            )
              active.state = "stream-error";
          } finally {
            clearTimeout(timer);
            active.cancel.delete(cancel);
            reader.releaseLock();
          }
        })().catch(() => {
          if (owner.active === active) active.state = "observer-error";
        });
      } catch {
        active.state = "unavailable";
      }
      return response;
    };
  }
  for (const cancel of watch.active?.cancel ?? []) cancel();
  watch.active =
    submissionId === null
      ? null
      : {
          submissionId,
          state: "awaiting-stream",
          messages: [],
          cancel: new Set(),
          timeoutMs,
        };
}

/** Match full text, preserving code whitespace and JSON escapes; only remove an outer fence. */
export function sameCompletedBody(rendered: string, streamed: string): boolean {
  const unwrap = (text: string): string =>
    text
      .replace(/\r\n/g, "\n")
      .trim()
      .replace(/^```(?:text|json)?\n([\s\S]*)\n```$/iu, "$1")
      .trim();
  return !!streamed.trim() && unwrap(rendered) === unwrap(streamed);
}
