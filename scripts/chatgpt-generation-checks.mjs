import assert from "node:assert/strict";
import process from "node:process";
import {
  watchChatGptGeneration,
  sameCompletedBody,
} from "../apps/desktop/dist/main/chatgpt-generation.js";
import { observeChatGpt } from "../apps/desktop/dist/main/chatgpt-observation.js";
import { chatGptDomToMarkdown } from "../apps/desktop/dist/main/chatgpt-markdown.js";
import { ChatGptCompletionTracker } from "../apps/desktop/dist/main/chatgpt-completion.js";
import { BRIDGE_FULL_TURN_TIMEOUT_MS } from "../packages/responses-gateway/dist/full-turn-limits.js";

export async function runGenerationChecks(page) {
  await page.route("https://completion.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<main></main>" }),
  );
  await page.goto("https://completion.test/");
  await page.evaluate(() => {
    globalThis.__streams = [];
    globalThis.__originalBodies = [];
    globalThis.__originalErrors = [];
    globalThis.fetch = async () => {
      let controller;
      const stream = new globalThis.ReadableStream({
        start(value) {
          controller = value;
        },
      });
      const response = new globalThis.Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
      globalThis.__streams.push(controller);
      globalThis.__lastOriginal = response;
      return response;
    };
  });
  const start = async (id, timeoutMs = 15 * 60_000) => {
    await page.evaluate(
      `(${watchChatGptGeneration.toString()})(${JSON.stringify(id)}, ${timeoutMs})`,
    );
    await page.evaluate(() => {
      void globalThis
        .fetch("/backend-api/f/conversation", {
          method: "POST",
          body: "unchanged-request",
        })
        .then(async (response) => {
          globalThis.__sameResponse = response === globalThis.__lastOriginal;
          globalThis.__originalBodies.push(await response.text());
        })
        .catch((error) => globalThis.__originalErrors.push(error.name));
    });
  };
  const send = (events, stream = -1) =>
    page.evaluate(
      ({ events, stream }) => {
        for (const value of events)
          globalThis.__streams
            .at(stream)
            .enqueue(
              new globalThis.TextEncoder().encode(
                "data: " +
                  (typeof value === "string" ? value : JSON.stringify(value)) +
                  "\r\n\r\n",
              ),
            );
      },
      { events, stream },
    );
  const message = (
    id,
    text,
    status = "finished_successfully",
    end_turn = true,
  ) => ({
    message: {
      id,
      author: { role: "assistant" },
      recipient: "all",
      channel: "final",
      status,
      end_turn,
      content: { content_type: "text", parts: [text] },
    },
  });
  const observe = () =>
    page.evaluate(
      `(${observeChatGpt.toString()})(${chatGptDomToMarkdown.toString()})`,
    );
  const show = (text, id = "answer-1") =>
    page.setContent(`<main>
    <section data-testid="conversation-turn-0" data-turn-id="old"><div aria-busy="true">old message</div></section>
    <section data-testid="conversation-turn-1" data-turn-id="user-1"><div data-message-author-role="user" data-message-id="user-1">test</div></section>
    <section data-testid="conversation-turn-2" data-turn-id="turn-1"><div data-message-author-role="assistant" data-message-id="${id}">${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</div><button data-testid="copy-turn-button">Copy</button></section>
    <button data-testid="stop-button">Stop</button></main>`);
  await start("submission-1");
  await show("<codex_text>partial</codex_text>");
  await send([
    message(
      "answer-1",
      "<codex_text>partial</codex_text>",
      "in_progress",
      false,
    ),
  ]);
  await page.waitForFunction(
    () => globalThis.__cgbGenerationWatch.active.messages.length === 1,
  );
  let result = await observe();
  assert.deepEqual(result.streamSignal, {
    messageId: "answer-1",
    text: "<codex_text>partial</codex_text>",
  });
  assert.equal(result.terminalSignal, null);
  assert.equal(result.responseBusy, true);
  assert.ok(
    result.busySources.some(
      (source) => source.scope === "earlier-answer" && !source.blocking,
    ),
  );
  const tracker = new ChatGptCompletionTracker(2_000);
  const tracked = () => ({
    ...result,
    text: result.renderedText,
    hasNewAssistant: true,
    terminalConfirmed:
      !!result.terminalSignal &&
      sameCompletedBody(result.renderedText, result.terminalSignal.text),
  });
  assert.equal(tracker.update(tracked(), 0), undefined);
  assert.equal(
    tracker.update(tracked(), 121_000),
    undefined,
    "A long mid-generation pause must not finish the response",
  );
  // Terminal state for another message or a tool recipient cannot finish this one.
  await send([message("unrelated-id", "<codex_text>partial</codex_text>")]);
  await page.waitForFunction(
    () => globalThis.__cgbGenerationWatch.active.messages.length === 2,
  );
  result = await observe();
  assert.equal(result.terminalSignal, null);
  const tool = message("answer-1", "<codex_text>partial</codex_text>");
  tool.message.recipient = "python";
  await send([tool]);
  await page.waitForFunction(
    () =>
      globalThis.__cgbGenerationWatch.active.messages.find(
        (row) => row.id === "answer-1",
      )?.recipient === "python",
  );
  assert.equal((await observe()).terminalSignal, null);
  // Even real terminal state must not settle DOM that contains only a prefix.
  const finalText = "<codex_text>partial plus final</codex_text>";
  await send([message("answer-1", finalText), "[DONE]"]);
  await page.waitForFunction(
    () =>
      globalThis.__cgbGenerationWatch.active.messages.find(
        (row) => row.id === "answer-1",
      )?.finishedAt !== null,
  );
  result = await observe();
  assert.equal(tracked().terminalConfirmed, false);
  assert.equal(tracker.update(tracked(), 122_000), undefined);
  await show(finalText);
  result = await observe();
  assert.equal(tracked().terminalConfirmed, true);
  assert.equal(tracker.update(tracked(), 123_000), undefined);
  assert.equal(tracker.update(tracked(), 123_250), finalText);
  assert.equal(
    result.responseBusy,
    true,
    "Stop control deliberately remains stuck",
  );
  assert.equal(await page.evaluate(() => globalThis.__sameResponse), true);
  await page.evaluate(() => globalThis.__streams[0].close());
  await page.waitForFunction(() => globalThis.__originalBodies.length === 1);
  assert.match(
    await page.evaluate(() => globalThis.__originalBodies[0]),
    /partial plus final/,
  );
  // New submissions cannot reuse a previous terminal message, even with the same ID.
  await start("submission-2");
  assert.equal((await observe()).terminalSignal, null);
  await send(["[DONE]"]);
  assert.equal((await observe()).terminalSignal, null);
  // Supported patches update the same message; unknown content patches revoke proof.
  await send([
    message("answer-1", "<codex_text>", "in_progress", false),
    { p: "/message/content/parts/0", o: "append", v: "patched</codex_text>" },
    {
      o: "patch",
      v: [
        { p: "/message/status", o: "replace", v: "finished_successfully" },
        { p: "/message/end_turn", o: "replace", v: true },
      ],
    },
  ]);
  await page.waitForFunction(() =>
    globalThis.__cgbGenerationWatch.active.messages.some(
      (row) => row.finishedAt !== null,
    ),
  );
  assert.equal(
    (await observe()).terminalSignal.text,
    "<codex_text>patched</codex_text>",
  );
  await send([{ p: "/message/content/parts/1", o: "append", v: "unknown" }]);
  await page.waitForFunction(
    () => globalThis.__cgbGenerationWatch.active.messages.length === 0,
  );
  assert.equal((await observe()).terminalSignal, null);
  await send([message("answer-1", finalText, "finished_successfully", false)]);
  await page.waitForFunction(() =>
    globalThis.__cgbGenerationWatch.active.messages.some(
      (row) => row.status === "finished_successfully" && !row.endTurn,
    ),
  );
  assert.equal(
    (await observe()).terminalSignal,
    null,
    "Successful status alone is not end-of-turn",
  );
  await page.evaluate(`(${watchChatGptGeneration.toString()})(null)`);
  await page.evaluate(() => globalThis.__streams[1].close());
  await page.waitForFunction(() => globalThis.__originalBodies.length === 2);
  assert.equal(
    await page.evaluate(() => globalThis.__streams.length),
    2,
    "The observer must not issue extra requests",
  );
  assert.equal((await observe()).generationState, "unavailable");
  const previousCount = (await observe()).generationRequestCount;
  await page.evaluate(() => {
    void globalThis.fetch("/backend-api/f/conversation", { method: "POST" });
  });
  assert.equal((await observe()).generationRequestCount, previousCount + 1);
  await page.evaluate(() => globalThis.__streams[2].close());
  await start("submission-terminal-abort");
  const abortedFinal = "<codex_text>finished before abort</codex_text>";
  await show(abortedFinal, "answer-terminal-abort");
  await send([message("answer-terminal-abort", abortedFinal)]);
  await page.waitForFunction(() =>
    globalThis.__cgbGenerationWatch.active.messages.some(
      (row) => row.id === "answer-terminal-abort" && row.finishedAt !== null,
    ),
  );
  await page.evaluate(() =>
    globalThis.__streams
      .at(-1)
      .error(
        new globalThis.DOMException("The operation was aborted.", "AbortError"),
      ),
  );
  await page.waitForFunction(() => globalThis.__originalErrors.length === 1);
  assert.equal(
    (await observe()).generationState,
    "observing",
    "An abort after successful end_turn must retain terminal stream proof",
  );
  assert.equal(
    (await observe()).terminalSignal?.messageId,
    "answer-terminal-abort",
  );
  await page.evaluate(`(${watchChatGptGeneration.toString()})(null)`);
  await page.clock.install();
  await start("submission-public-commentary", BRIDGE_FULL_TURN_TIMEOUT_MS);
  await page.clock.fastForward(16 * 60_000);
  const progress = (id, text, overrides = {}) => ({
    message: {
      ...message(id, text, "finished_successfully", false).message,
      channel: "commentary",
      ...overrides,
    },
  });
  await send([
    progress("private-analysis", "Private reasoning", { channel: "analysis" }),
    progress("unfinished-progress", "Still writing", { status: "in_progress" }),
    progress("tool-progress", "Tool payload", { recipient: "python" }),
    progress("public-progress", "Checking the selected files."),
  ]);
  await page.waitForFunction(() =>
    globalThis.__cgbGenerationWatch.active.messages.some(
      (row) => row.id === "public-progress",
    ),
  );
  assert.deepEqual((await observe()).publicCommentary, [
    { messageId: "public-progress", text: "Checking the selected files." },
  ]);
  assert.equal((await observe()).terminalSignal, null);
  assert.equal((await observe()).responseBusy, true);
  await page.evaluate(`(${watchChatGptGeneration.toString()})(null)`);
  await page.evaluate(() => globalThis.__streams.at(-1).close());
  assert.equal((await observe()).publicCommentary, undefined);
  process.stdout.write(
    "Generation evidence checks passed: exact message/body binding, midstream pauses, stale stop, patches, new submission, terminal abort, public commentary after 15 minutes, original stream preservation.\n",
  );
}
