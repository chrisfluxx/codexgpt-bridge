/* global document */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { runGenerationChecks } from "./chatgpt-generation-checks.mjs";
import { observeChatGpt } from "../apps/desktop/dist/main/chatgpt-observation.js";
import { chatGptDomToMarkdown } from "../apps/desktop/dist/main/chatgpt-markdown.js";
import { observeModelSelection } from "../apps/desktop/dist/main/model-selection.js";
import {
  chatGptAssistantText,
  ChatGptCompletionTracker,
} from "../apps/desktop/dist/main/chatgpt-completion.js";
import {
  compileResponsesPrompt,
  prepareBridgeWebTurn,
  parseBridgeWebTurnResult,
} from "../packages/responses-gateway/dist/index.js";
import { BridgeTextStream } from "../packages/responses-gateway/dist/text-stream.js";

export async function runChatGptDomChecks(app) {
  process.stdout.write("ChatGPT DOM checks: creating isolated renderer\n");
  const [page] = await Promise.all([
    app.waitForEvent("window"),
    app.evaluate(({ BrowserWindow }) => {
      const window = new BrowserWindow({ show: false });
      void window.loadURL("about:blank");
    }),
  ]);
  const setHtml = (html) =>
    page.setContent(html, { waitUntil: "domcontentloaded" });
  const observe = () =>
    page.evaluate(
      `(${observeChatGpt.toString()})(${chatGptDomToMarkdown.toString()})`,
    );
  const user = (id) =>
    `<div data-testid="conversation-turn-${id}" data-turn-id="logical-${id}"><div data-message-author-role="user">question ${id}</div></div>`;
  const reply = (id, body) =>
    `<div data-testid="conversation-turn-${id}" data-turn-id="logical-${id}"><div data-message-author-role="assistant">${body}</div><button data-testid="copy-turn-button">Copy</button></div>`;
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const image = `<img src="${png}" width="256" height="256">`;
  const settleImages = () =>
    page.evaluate(async () => {
      await Promise.all(
        [...document.images].map((img) => img.decode().catch(() => undefined)),
      );
    });
  try {
    page.setDefaultTimeout(5_000);
    process.stdout.write("ChatGPT DOM checks: model selection evidence\n");
    const observeModel = () =>
      page.evaluate(`(${observeModelSelection.toString()})()`);
    await setHtml(
      '<main><button data-testid="model-switcher-dropdown-button">High</button><div data-message-author-role="assistant">GPT-6 Pro</div></main>',
    );
    let selection = await observeModel();
    assert.equal(selection.mode, "high");
    assert.equal(selection.model, null);
    await setHtml(
      '<button data-testid="model-switcher-dropdown-button">Pro</button><div data-testid="composer-intelligence-picker-content"><button role="menuitem">Pro</button><div inert style="display:none"><button role="menuitemradio" aria-checked="true">GPT-5.6 Sol</button><button role="menuitemradio" aria-checked="false">GPT-5.5</button></div></div>',
    );
    selection = await observeModel();
    assert.equal(selection.model, "GPT-5.6 Sol");
    assert.equal(selection.mode, "pro");
    assert.deepEqual(selection.availableModels, []);
    await setHtml(
      '<div role="dialog">Intelligence Model<button role="combobox">GPT-6 Astra</button><button role="radio" aria-checked="true">Thinking</button><button role="combobox">Extended</button></div>',
    );
    selection = await observeModel();
    assert.equal(selection.model, "GPT-6 Astra");
    assert.equal(selection.mode, "high");
    await setHtml(
      '<div role="dialog">Intelligence Model<button role="combobox">5.6</button><button role="radio" aria-checked="true">Pro</button><button role="combobox">Standard</button></div>',
    );
    assert.equal((await observeModel()).mode, "pro");
    await setHtml(
      '<button data-testid="model-switcher-dropdown-button">High</button><button data-testid="composer-model-picker-button">Medium</button>',
    );
    assert.equal((await observeModel()).ambiguous, true);
    await setHtml(
      '<button data-testid="model-switcher-dropdown-button" aria-disabled="true">Pro</button>',
    );
    assert.equal((await observeModel()).disabled, true);
    await setHtml(
      '<button data-testid="model-switcher-dropdown-button">High</button><div role="menu"><span role="slider" aria-valuetext="Medium">Medium</span></div>',
    );
    assert.equal((await observeModel()).ambiguous, true);
    await setHtml(
      '<button data-testid="model-switcher-dropdown-button">High</button><div data-testid="composer-intelligence-picker-content"><button role="menuitemradio" aria-checked="true" aria-disabled="true">GPT-5.6 Sol</button></div>',
    );
    assert.equal((await observeModel()).disabled, true);
    await setHtml(
      '<main><div data-message-author-role="assistant">High GPT-5.6 Sol</div></main>',
    );
    assert.equal((await observeModel()).surface, "missing");
    await setHtml(
      user(0) +
        reply(1, "answer") +
        '<div data-turn-id-container="virtualized-old-turn" style="display:none"></div>',
    );
    const beforeRenumber = await observe();
    await page.evaluate(() => {
      const item = document.querySelector('[data-turn-id="logical-1"]');
      item.setAttribute("data-testid", "conversation-turn-99");
      item.replaceWith(item.cloneNode(true));
    });
    const afterRenumber = await observe();
    assert.equal(afterRenumber.assistantToken, beforeRenumber.assistantToken);
    assert.ok(
      afterRenumber.logicalTurnIds.includes("turn:virtualized-old-turn"),
    );
    await setHtml(user(0) + reply(1, "one") + reply(1, "duplicate"));
    assert.match((await observe()).error, /duplicate logical/);
    process.stdout.write("ChatGPT DOM checks: current search-unit turns\n");
    const modernUserId = "11111111-1111-4111-8111-111111111111";
    const modernAssistantId = "22222222-2222-4222-8222-222222222222";
    await setHtml(`<main>
      <div data-turn-key="${modernUserId}" data-content-search-turn-key="fallback-turn-0">
        <div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="${modernUserId}">
          <div data-user-message-bubble="true"><div data-content-search-unit-key="fallback-turn-0:0:user">modern question</div></div>
        </div>
        <div data-chatgpt-search-unit-key="fallback-turn-0:2:assistant" data-chatgpt-search-message-ids="${modernAssistantId} ${modernAssistantId}">
          <div data-chatgpt-selection-message-id="${modernAssistantId}"><div data-markdown-text-style="assistant-message"><p>modern answer</p></div></div>
        </div>
        <button aria-label="Regenerate response">Regenerate</button>
      </div>
      <form><div contenteditable="true"></div><button data-testid="send-button">Send</button></form>
    </main>`);
    await page.evaluate(
      ({ modernAssistantId }) => {
        globalThis.__cgbGenerationWatch = {
          version: 1,
          requestCount: 1,
          active: {
            submissionId: "modern-submission",
            state: "observing",
            cancel: new Set(),
            messages: [
              {
                id: modernAssistantId,
                role: "assistant",
                recipient: "all",
                channel: "final",
                status: "finished_successfully",
                endTurn: true,
                text: "modern answer",
                finishedAt: Date.now(),
              },
            ],
          },
        };
      },
      { modernAssistantId },
    );
    const modern = await observe();
    assert.equal(modern.userCount, 1);
    assert.equal(modern.assistantCount, 1);
    assert.equal(modern.userToken, `group:user:${modernUserId}`);
    assert.equal(modern.assistantToken, `group:assistant:${modernUserId}`);
    assert.equal(modern.assistantMessageId, modernAssistantId);
    assert.equal(modern.renderedText, "modern answer");
    assert.equal(modern.terminalSignal?.messageId, modernAssistantId);
    assert.equal(modern.terminalSignal?.text, "modern answer");
    assert.ok(modern.logicalTurnIds.includes(`turn:${modernUserId}`));
    assert.ok(modern.logicalTurnIds.includes(`message:${modernAssistantId}`));
    await setHtml(
      user(0) +
        reply(
          1,
          '<p><strong>測試正常</strong> <span data-markdown-copy="inline-code">exec_command</span> <span data-markdown-copy="inline-code">apply_patch</span> 😀</p>',
        ),
    );
    const inlineMarkdown = "**測試正常** `exec_command` `apply_patch` 😀";
    const inlineObservation = await observe();
    assert.equal(inlineObservation.renderedText, inlineMarkdown);
    const inlineDeltas = [];
    const inlineStream = new BridgeTextStream((delta) =>
      inlineDeltas.push(delta),
    );
    inlineStream.updateNetwork(inlineMarkdown.slice(0, 20));
    assert.deepEqual(inlineDeltas, []);
    inlineStream.update(inlineObservation.renderedText, true);
    assert.deepEqual(inlineDeltas, [inlineMarkdown]);
    process.stdout.write(
      "ChatGPT DOM checks: current inline-code spans preserve Markdown and complete once\n",
    );
    const formula = "dip = 1 - \\frac{盤中截至目前最低價}{昨收}";
    const plainCode =
      "先漲至少 +1%\n↓\n從該高點回檔 1%～3%\n\n\n    沒有把整個上漲結構完全跌破";
    const mathHtml = (tex, display = false) => {
      const katex = `<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>duplicated MathML</mi></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">duplicated visual formula</span></span>`;
      return display ? `<span class="katex-display">${katex}</span>` : katex;
    };
    await setHtml(
      user(0) +
        reply(
          1,
          `<p>公式就是：</p>${mathHtml(formula, true)}<p>要求：${mathHtml("dip \\ge 1\\%")}</p><div data-markdown-copy="code-block"><div>純文字<button>複製程式碼</button></div><div><code>${plainCode}</code></div></div>`,
        ),
    );
    const richObservation = await observe();
    const expectedRichMarkdown = `公式就是：\n\n\\[\n${formula}\n\\]\n\n要求：\\(dip \\ge 1\\%\\)\n\n\`\`\`\n${plainCode}\n\`\`\``;
    assert.equal(richObservation.renderedText, expectedRichMarkdown);
    assert.deepEqual(richObservation.codeTexts, [plainCode]);
    const richDeltas = [];
    const richStream = new BridgeTextStream((delta) => richDeltas.push(delta));
    richStream.update(
      chatGptAssistantText(
        richObservation.renderedText,
        richObservation.codeTexts,
      ),
      true,
    );
    assert.deepEqual(richDeltas, [expectedRichMarkdown]);
    // Visual hydration and toolbar changes cannot duplicate or rewrite source.
    await page.evaluate(() => {
      for (const visual of document.querySelectorAll(".katex-html"))
        visual.textContent = "hydrated visual formula";
      document
        .querySelector('[data-markdown-copy="code-block"] > div')
        .remove();
    });
    assert.equal((await observe()).renderedText, expectedRichMarkdown);
    process.stdout.write(
      "ChatGPT DOM checks: KaTeX formulas and modern plain-text blocks preserve source through Responses\n",
    );
    process.stdout.write(
      "ChatGPT DOM checks: grouped Pro continuation and remounts\n",
    );
    const groupedRound = (id, body) => `<div data-turn-key="round-${id}">
      <div data-content-search-unit-key="round-${id}:0"><div data-user-message-bubble>user ${id}</div></div>
      <div><div data-chatgpt-agent-turn-start></div><div data-markdown-text-style="assistant-message">activity must stay private</div></div>
      <div data-content-search-unit-key="round-${id}:1" data-chatgpt-search-message-ids="answer-${id}"><div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message">earlier commentary</div></div>
      <div data-content-search-unit-key="round-${id}:2" data-chatgpt-search-message-ids="answer-${id}"><div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message">${body}</div></div>
      <div class="turn-action-controls"><button data-testid="copy-turn-action-button">Copy</button></div>
    </div>`;
    const groupedToolText =
      '<codex_tool_calls>[{"name":"exec","input":"text(1)"}]</codex_tool_calls>';
    for (let round = 1; round <= 4; round++) {
      await setHtml(
        Array.from({ length: round }, (_, index) =>
          groupedRound(
            index + 1,
            index + 1 === round
              ? `<pre><code>${groupedToolText.replaceAll("<", "&lt;")}</code></pre>`
              : "old answer",
          ),
        ).join(""),
      );
      const grouped = await observe();
      assert.equal(grouped.error, "");
      assert.equal(grouped.userCount, round);
      assert.equal(grouped.assistantCount, round);
      assert.equal(grouped.userToken, `group:user:round-${round}`);
      assert.equal(grouped.assistantToken, `group:assistant:round-${round}`);
      assert.equal(
        chatGptAssistantText(grouped.renderedText, grouped.codeTexts),
        groupedToolText,
      );
      assert.equal(grouped.completionActionVisible, true);
    }
    await setHtml('<div data-turn-key="round-virtualized-round"></div>');
    const virtualized = await observe();
    await setHtml(groupedRound("virtualized-round", "old answer"));
    const remounted = await observe();
    assert.ok(virtualized.logicalTurnIds.includes(remounted.assistantToken));
    await setHtml(
      `<div style="width:0">${groupedRound("zero-width", "zero-width completed answer")}</div>`,
    );
    assert.equal((await observe()).renderedText, "zero-width completed answer");
    await setHtml(
      `<div style="display:none">${groupedRound("hidden", "hidden answer")}</div>`,
    );
    assert.equal((await observe()).renderedText, "");
    await setHtml(
      groupedRound("duplicate", "one") + groupedRound("duplicate", "two"),
    );
    assert.match((await observe()).error, /duplicate logical/);
    await setHtml(`<div data-turn-key="fallback-group">
      <div data-user-message-bubble>user text must stay private</div>
      <div><div data-chatgpt-agent-turn-start></div><div data-markdown-text-style="assistant-message">activity must stay private</div></div>
      <div data-conversation-role="assistant"></div>
      <div data-markdown-text-style="assistant-message">final group answer</div>
      <div class="turn-action-controls"><button data-testid="copy-turn-action-button">Copy</button></div>
    </div>`);
    assert.equal((await observe()).renderedText, "final group answer");
    await setHtml(`<div data-turn-key="activity-only">
      <div data-user-message-bubble>question</div>
      <div><div data-chatgpt-agent-turn-start></div><div data-markdown-text-style="assistant-message">activity must stay private</div></div>
    </div>`);
    assert.equal((await observe()).renderedText, "");
    await setHtml(
      groupedRound(
        "error-explanation",
        "載入應用程式時發生錯誤。 Failed to fetch template.",
      ),
    );
    assert.equal((await observe()).webNativeToolError, "");
    process.stdout.write("ChatGPT DOM checks: stale and sibling images\n");
    await setHtml(user(0) + reply(1, image) + user(2));
    await settleImages();
    let result = await observe();
    assert.equal(result.renderedText, "");
    assert.deepEqual(result.generatedImageUrls, []);
    assert.equal(result.completionActionVisible, false);

    process.stdout.write(
      "ChatGPT DOM checks: citation and intrinsic-size regressions\n",
    );
    // Native dimensions exceed the old 128px threshold; displayed size is only 16px.
    const largeIcon =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256"/></svg>',
      );
    await setHtml(
      user(0) +
        reply(
          1,
          `<p>Complete research answer.</p><a href="https://example.org/paper"><img src="${largeIcon}" width="16" height="16">Source</a>`,
        ),
    );
    await settleImages();
    assert.equal(
      await page.evaluate(() => document.images[0].naturalWidth),
      256,
    );
    result = await observe();
    assert.deepEqual(result.generatedImageUrls, []);
    assert.equal(result.hasRenderableMedia, false);
    assert.equal(result.mediaPending, false);
    assert.match(result.renderedText, /Complete research answer/);

    await setHtml(
      user(0) +
        reply(
          1,
          `<p>Answer with citation.</p><span data-testid="web-citation">${image}</span>`,
        ),
    );
    await settleImages();
    result = await observe();
    assert.deepEqual(result.generatedImageUrls, []);
    assert.equal(result.hasRenderableMedia, false);

    await page.route("https://example.org/favicon.png", () => undefined);
    await setHtml(
      user(0) +
        reply(
          1,
          '<p>Finished, citation still loading.</p><img src="https://example.org/favicon.png" width="16" height="16">',
        ),
    );
    result = await observe();
    assert.equal(result.mediaPending, false);
    assert.equal(result.hasRenderableMedia, false);

    // Generation containers must use the same displayed-size rule as image extraction.
    await setHtml(
      user(0) +
        reply(
          1,
          `<div data-testid="image-gen-result">${image}<div data-testid="image-gen-overlay">Edit image</div></div>`,
        ),
    );
    await settleImages();
    result = await observe();
    assert.equal(result.generatedImageUrls.length, 1);
    assert.equal(result.mediaPending, false);

    // Current ChatGPT image turns can be role-less and expose the completion
    // affordance as copy-turn-action-button with a Traditional Chinese label.
    await setHtml(
      user(0) +
        `<section data-testid="conversation-turn-1"><div>Worked for 1m 50s</div><div class="group/imagegen-image"><img alt="已產生圖像：粉彩夢境中的 Dayoung 房間時光" src="${png}" width="256" height="256"><img alt="" src="${png}" width="256" height="256"><img alt="" src="${png}" width="256" height="256"></div><button data-testid="copy-turn-action-button" aria-label="複製回應">Copy</button></section>`,
    );
    await settleImages();
    result = await observe();
    assert.deepEqual(result.generatedImageUrls, [png]);
    assert.equal(result.mediaPending, false);
    assert.equal(result.hasRenderableMedia, true);
    assert.equal(result.completionActionVisible, true);
    // Busy markers in quoted examples, hidden/disabled streaming surfaces, and
    // an earlier answer cannot hold up a completed current response.
    await setHtml(
      user(0) +
        reply(1, '<div aria-busy="true">old</div>') +
        user(2) +
        reply(
          3,
          '<p>finished</p><pre><code><span aria-busy="true">example</span></code></pre><div data-testid="streaming-container" data-is-streaming="false">done</div>',
        ),
    );
    result = await observe();
    assert.equal(result.responseBusy, false);
    assert.ok(result.busySources.some((source) => source.scope === "quoted"));
    assert.ok(result.busySources.some((source) => source.scope === "inactive"));
    await setHtml(
      user(0) +
        reply(1, "finished") +
        '<div aria-busy="true">Voice</div><button aria-label="Stop voice">Stop</button>',
    );
    result = await observe();

    // Estuary image URLs refresh their short-lived signature while the image is
    // settling. That must not manufacture a new semantic response signature.
    await page.route(
      "https://chatgpt.com/backend-api/estuary/content**",
      (route) =>
        route.fulfill({
          contentType: "image/png",
          body: Buffer.from(png.split(",")[1], "base64"),
        }),
    );
    const signedImageA =
      "https://chatgpt.com/backend-api/estuary/content?id=file_dom_check&ts=1&sig=first";
    const signedImageB =
      "https://chatgpt.com/backend-api/estuary/content?id=file_dom_check&ts=2&sig=second";
    await setHtml(
      user(0) +
        reply(1, `<img src="${signedImageA}" width="256" height="256">`),
    );
    await settleImages();
    result = await observe();
    const stableImageSignature = result.html;
    assert.deepEqual(result.generatedImageUrls, [signedImageA]);
    await page.evaluate((src) => {
      document.images[0].src = src;
    }, signedImageB);
    await settleImages();
    result = await observe();
    assert.equal(result.html, stableImageSignature);
    assert.deepEqual(result.generatedImageUrls, [signedImageB]);

    // Image is outside the author-role node and followed by a separate assistant text turn.
    await setHtml(
      user(0) +
        reply(1, "old image") +
        user(2) +
        `<div data-testid="conversation-turn-3"><div data-message-author-role="assistant">Worked for 41s</div>${image}<button data-testid="copy-turn-button">Copy</button></div>` +
        reply(4, "Here is your image."),
    );
    await settleImages();
    result = await observe();
    assert.equal(result.generatedImageUrls.length, 1);
    assert.equal(result.generatedImageUrls[0], png);
    assert.equal(result.mediaPending, false);
    assert.match(result.renderedText, /Here is your image/);
    assert.doesNotMatch(result.renderedText, /old image/);
    const token = result.assistantToken;
    await page.evaluate(() => {
      document.querySelector('[data-testid="conversation-turn-4"]').outerHTML =
        document.querySelector('[data-testid="conversation-turn-4"]').outerHTML;
    });
    assert.equal(
      (await observe()).assistantToken,
      token,
      "Remount must not manufacture a new response ID",
    );

    await setHtml(
      user(0) +
        `<div data-testid="conversation-turn-1"><div data-message-author-role="assistant"><pre><code>unfinished</code><button data-testid="copy-button">Copy</button></pre></div></div><button data-testid="stop-button">Stop</button>`,
    );
    result = await observe();
    assert.equal(result.completionActionVisible, false);
    assert.equal(result.responseBusy, true);

    await setHtml(
      user(0) +
        reply(1, "finished") +
        '<div aria-busy="true">Voice</div><button aria-label="Stop voice">Stop</button>',
    );
    result = await observe();
    assert.equal(result.responseBusy, false);
    assert.equal(result.completionActionVisible, true);
    const tracker = new ChatGptCompletionTracker(100);
    const tracked = () => ({
      ...result,
      text: chatGptAssistantText(result.renderedText, result.codeTexts),
      hasNewAssistant: true,
    });
    assert.equal(tracker.update(tracked(), 0), undefined);
    // UI-only mutations must not reset a stable response.
    await page.evaluate(() => {
      document
        .querySelector('[data-testid="copy-turn-button"]')
        .setAttribute("style", "opacity:0.99");
    });
    result = await observe();
    assert.equal(tracker.update(tracked(), 100), "finished");

    process.stdout.write(
      "ChatGPT DOM checks: name-independent native tool isolation\n",
    );
    await setHtml(
      user(0) +
        reply(
          1,
          '<div data-testid="connector-result-card"><strong>Acme Builder</strong><p>Result ready</p></div><p>Claimed completion</p>',
        ),
    );
    result = await observe();
    assert.equal(result.webNativeToolPending, false);
    assert.equal(result.webNativeToolPresent, true);
    const nativeToolTracker = new ChatGptCompletionTracker(100);
    const nativeToolObservation = {
      ...result,
      text: chatGptAssistantText(result.renderedText, result.codeTexts),
      hasNewAssistant: true,
    };
    assert.equal(nativeToolTracker.update(nativeToolObservation, 0), undefined);
    assert.equal(
      nativeToolTracker.update(nativeToolObservation, 10_000),
      undefined,
    );

    await setHtml(
      user(0) +
        reply(
          1,
          "<div><strong>Another Builder</strong><p>Waiting for a tool result.</p></div><p>Claimed completion</p>",
        ),
    );
    result = await observe();
    assert.equal(result.webNativeToolPending, true);
    assert.equal(result.webNativeToolPresent, true);

    await setHtml(
      user(0) +
        reply(
          1,
          '<div data-testid="artifact-preview"><iframe title="Generated app"></iframe></div><p>Artifact complete</p>',
        ),
    );
    result = await observe();
    assert.equal(result.webNativeToolPending, false);
    assert.equal(result.webNativeToolPresent, true);

    await setHtml(
      user(0) +
        '<div data-testid="conversation-turn-1" data-message-author-role="tool"><div data-tool-id="opaque-builder">Built result</div></div>' +
        reply(2, "Claimed completion"),
    );
    result = await observe();
    assert.equal(result.webNativeToolPending, false);
    assert.equal(result.webNativeToolPresent, true);

    process.stdout.write("ChatGPT DOM checks: inline protocol explanation\n");
    const templateError =
      "<div><strong>載入應用程式時發生錯誤</strong><p>Failed to fetch template</p><div><button>重試</button></div></div>";
    for (const role of ["", ' role="alert"']) {
      await setHtml(
        user(0) +
          reply(
            1,
            `<section${role}>${templateError}</section><pre><code>&lt;codex_tool_calls&gt;[{"name":"exec","input":"patch"}]&lt;/codex_tool_calls&gt;</code></pre>`,
          ),
      );
      result = await observe();
      assert.equal(result.webNativeToolPresent, true);
      assert.match(result.webNativeToolError, /app\/template failed/);
      assert.equal(result.error, ""); // Typed adapter failure, not a generic alert.
    }
    // The live page can put Retry directly under a sibling tool turn, outside
    // the assistant prose. This exact structure previously escaped detection.
    await setHtml(
      user(0) +
        reply(1, "Calculator preview") +
        '<div data-testid="conversation-turn-tool" data-message-author-role="tool" aria-busy="true"><strong>載入應用程式時發生錯誤</strong><p>Failed to fetch template</p><button>重試</button></div>',
    );
    result = await observe();
    assert.equal(result.webNativeToolPresent, true);
    assert.match(result.webNativeToolError, /app\/template failed/);
    assert.equal(result.error, "");
    // A completed failed-template card may no longer expose any Retry control.
    await setHtml(
      user(0) +
        reply(1, "Normal assistant prose") +
        "<section><strong>載入應用程式時發生錯誤</strong><p>Failed to fetch template</p></section>",
    );
    result = await observe();
    assert.equal(result.webNativeToolPresent, true);
    assert.match(result.webNativeToolError, /app\/template failed/);
    // The same words in the assistant's own prose are not a native error card.
    await setHtml(
      user(0) +
        reply(
          1,
          "<p>錯誤訊息的標題是：</p><strong>載入應用程式時發生錯誤</strong><p>Failed to fetch template</p><p>這代表模板載入失敗。</p>",
        ),
    );
    result = await observe();
    assert.equal(result.webNativeToolError, "");
    // Retry can be an accessible custom control rather than a button element.
    await setHtml(
      user(0) +
        reply(
          1,
          '<section><strong>載入應用程式時發生錯誤</strong><p>Failed to fetch template</p><div role="button" aria-label="Retry"></div></section>',
        ),
    );
    result = await observe();
    assert.match(result.webNativeToolError, /app\/template failed/);
    // A failed old app must not poison the correction round or the next user turn.
    await setHtml(
      user(0) +
        reply(1, `<div role="alert">${templateError}</div>`) +
        user(2) +
        reply(3, "Corrected reply"),
    );
    result = await observe();
    assert.equal(result.webNativeToolPresent, false);
    assert.equal(result.webNativeToolError, "");
    assert.equal(result.error, "");
    await setHtml(
      user(0) +
        reply(
          1,
          "<pre><code>Failed to fetch template<button>Retry</button></code></pre><p>Error explanation.</p>",
        ),
    );
    result = await observe();
    assert.equal(result.webNativeToolPresent, false);
    assert.equal(result.webNativeToolError, "");
    await setHtml(
      user(0) +
        reply(1, "Reply") +
        '<div role="alert">Rate limit exceeded</div>',
    );
    result = await observe();
    assert.match(result.error, /Rate limit/);
    process.stdout.write(
      "ChatGPT DOM checks: failed template card, correction and stale alerts passed\n",
    );
    for (const marker of ["codex_tool_calls", "codex_tool_call"]) {
      await setHtml(
        user(0) +
          reply(
            1,
            `<p>單純聊天、語音問答。</p><p>你剛剛看到的 <code>&lt;${marker}&gt;</code> 是工具標記。</p><p>回答已完成。</p>`,
          ) +
          '<div aria-busy="true">Voice thinking</div>',
      );
      result = await observe();
      const text = chatGptAssistantText(result.renderedText, result.codeTexts);
      assert.equal(text, result.renderedText);
      assert.deepEqual(result.codeTexts, []);
      const explanationTracker = new ChatGptCompletionTracker(100);
      const explanation = { ...result, text, hasNewAssistant: true };
      assert.equal(explanationTracker.update(explanation, 0), undefined);
      assert.equal(explanationTracker.update(explanation, 100), text);
      assert.match(text, /回答已完成/);
    }

    // Fenced client-tool JSON must still retain escapes and wait for its closing tag.
    const protocol =
      '<codex_tool_calls>[{"name":"exec_command","arguments":{"cmd":"echo \\"ok\\""}}]';
    const escapeHtml = (value) =>
      value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    const protocolTracker = new ChatGptCompletionTracker(100);
    for (const complete of [false, true]) {
      const text = protocol + (complete ? "</codex_tool_calls>" : "");
      await setHtml(
        user(0) + reply(1, `<pre><code>${escapeHtml(text)}</code></pre>`),
      );
      result = await observe();
      assert.deepEqual(result.codeTexts, [text]);
      const observedText = chatGptAssistantText(
        result.renderedText,
        result.codeTexts,
      );
      assert.equal(observedText, text);
      const observation = {
        ...result,
        text: observedText,
        hasNewAssistant: true,
      };
      assert.equal(
        protocolTracker.update(observation, complete ? 20_000 : 0),
        undefined,
      );
      assert.equal(
        protocolTracker.update(observation, complete ? 20_100 : 10_000),
        complete ? text : undefined,
      );
    }

    // Reproduce the localized code toolbar shown in the user's failed turn.
    // The raw custom input must survive the renderer and become a client call,
    // with no protocol text emitted to the Codex answer stream.
    const command = String.raw`Get-ChildItem -LiteralPath 'C:\Users\example-user\Desktop'`;
    const customInput = `const result = await tools.exec_command({cmd:${JSON.stringify(command)}, max_output_tokens:2000});\ntext(result);`;
    const customEnvelope = `<codex_tool_calls>${JSON.stringify([{ name: "exec", input: customInput }])}</codex_tool_calls>`;
    const prepared = prepareBridgeWebTurn(
      compileResponsesPrompt({
        input: "Compare the two tools in detail.",
        tools: [{ type: "custom", name: "exec", format: { type: "text" } }],
      }),
    );
    for (const location of [
      "inside",
      "outside",
      "without-pre",
      "without-class",
    ]) {
      for (const label of ["純文字", "Plain text"]) {
        const toolbar = `<div>${label}<button>Copy code</button></div>`;
        const code = `<div><code${location === "without-class" ? "" : ' class="language-text"'}>${escapeHtml(customEnvelope)}</code></div>`;
        await setHtml(
          user(0) +
            reply(
              1,
              location === "inside"
                ? `<pre>${toolbar}${code}</pre>`
                : location === "outside"
                  ? `<div>${toolbar}<pre>${code}</pre></div>`
                  : `<div>${toolbar}${code}</div>`,
            ),
        );
        result = await observe();
        const observed = chatGptAssistantText(
          result.renderedText,
          result.codeTexts,
        );
        assert.equal(observed, customEnvelope);
        const parsed = parseBridgeWebTurnResult(observed, prepared);
        assert.equal(parsed.kind, "tool_calls");
        assert.equal(parsed.calls[0].input, customInput);
        const deltas = [];
        const stream = new BridgeTextStream((delta) => deltas.push(delta));
        stream.updateNetwork(observed);
        stream.update(observed, true);
        assert.deepEqual(deltas, []);
      }
    }
    process.stdout.write(
      "ChatGPT DOM checks: localized tool toolbar round trip passed\n",
    );

    process.stdout.write("ChatGPT DOM checks: lazy image\n");
    await page.route("https://chatgpt.com/lazy-image.png", () => undefined);
    await setHtml(
      user(0) +
        reply(
          1,
          '<p>Image ready</p><img src="https://chatgpt.com/lazy-image.png" width="256" height="256">',
        ),
    );
    result = await observe();
    assert.equal(result.mediaPending, true);
    assert.deepEqual(result.generatedImageUrls, []);
    assert.equal(
      new ChatGptCompletionTracker(0).update(
        { ...result, text: result.renderedText, hasNewAssistant: true },
        1_000,
      ),
      undefined,
    );

    await setHtml(
      user(0) +
        reply(1, "text") +
        `<div data-testid="conversation-turn-2" data-message-author-role="user">uploaded image ${image}</div>`,
    );
    await settleImages();
    result = await observe();
    assert.deepEqual(result.generatedImageUrls, []);

    await setHtml(
      user(0) +
        reply(
          1,
          "<h2>Table</h2><p><strong>Bold</strong> text</p><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><pre><code>if x:\n    run()</code></pre>",
        ),
    );
    result = await observe();
    assert.match(result.renderedText, /\| A \| B \|/);
    assert.match(result.renderedText, /\n {4}run\(\)/);
    assert.match(result.renderedText, /\*\*Bold\*\*/);
    await runGenerationChecks(page);
    process.stdout.write(
      "ChatGPT DOM checks passed: stale images, sibling media, multi-node turns, remount identity, code-copy controls, voice chrome, lazy images, user attachments, Markdown.\n",
    );
  } finally {
    await page.close();
  }
}
