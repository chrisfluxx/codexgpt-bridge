import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHAT_GPT_RICH_OUTPUT_ONLY,
  chatGptAssistantText,
  ChatGptCompletionTracker,
  hasChatGptResponseStarted,
  isChatGptSubmissionAcknowledged,
  isConfirmedStalePageStop,
  isRecoverableToolFailure,
  shouldRetryTransientImageGeneration,
} from "./chatgpt-completion.js";
import {
  chatGptDomToMarkdown,
  type ChatGptDomNode,
} from "./chatgpt-markdown.js";
import { sameCompletedBody } from "./chatgpt-generation.js";
import {
  CompletionTrace,
  CompletionDiagnosticStore,
  PreparationError,
} from "./completion-diagnostics.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("preserves every submission attempt even when milestones retain only the first", () => {
  const trace = new CompletionTrace("retry-diagnostic");
  trace.mark("submitting", trace.started + 10);
  trace.event("submission-attempt", trace.started + 10);
  trace.event("submission-accepted", trace.started + 20);
  trace.mark("submitting", trace.started + 40);
  trace.event("submission-attempt", trace.started + 40);
  const result = trace.finish("failed");
  assert.equal(result.milestones.submitting, 10);
  assert.equal(result.eventCounts?.["submission-attempt"], 2);
  assert.equal(result.eventCounts?.["submission-accepted"], 1);
  assert.deepEqual(
    result.events?.map((event) => event.elapsedMs),
    [10, 20, 40],
  );
});

function textNode(value: string): ChatGptDomNode {
  return { nodeType: 3, nodeName: "#text", textContent: value };
}

function elementNode(
  name: string,
  children: readonly ChatGptDomNode[],
  attributes: Readonly<Record<string, string>> = {},
): ChatGptDomNode {
  return {
    nodeType: 1,
    nodeName: name.toUpperCase(),
    childNodes: children,
    getAttribute: (attribute) => attributes[attribute] ?? null,
  };
}

describe("ChatGPT completion tracking", () => {
  it("continues after an exact completed turn even when its page Stop never clears", () => {
    const proof = {
      userToken: "user-1",
      assistantMessageId: "assistant-1",
      requestCount: 1,
      text: "first answer",
    };
    const stale = {
      userCount: 1,
      assistantCount: 1,
      userToken: "user-1",
      assistantMessageId: "assistant-1",
      generationRequestCount: 1,
      text: "first answer",
      composerText: "",
      responseBusy: true,
      busySources: [
        {
          kind: "stop-control",
          scope: "page",
          owner: "page",
          blocking: true,
        },
      ],
    };
    assert.equal(isConfirmedStalePageStop(stale, proof, true), true);
    assert.equal(
      isConfirmedStalePageStop(
        {
          ...stale,
          busySources: [
            ...stale.busySources,
            {
              kind: "aria-busy",
              scope: "current-answer",
              owner: "assistant-1",
              blocking: true,
            },
          ],
        },
        proof,
        true,
      ),
      false,
    );
    assert.equal(
      isConfirmedStalePageStop(
        { ...stale, generationRequestCount: 2 },
        proof,
        true,
      ),
      false,
    );
    assert.equal(isConfirmedStalePageStop(stale, proof, false), false);
  });

  it("does not mistake a retained Stop for submission or response-start evidence", () => {
    const baseline = {
      userCount: 1,
      assistantCount: 1,
      userToken: "user-1",
      assistantMessageId: "assistant-1",
      generationRequestCount: 1,
      text: "first answer",
      composerText: "second prompt",
      responseBusy: true,
      busySources: [
        {
          kind: "stop-control",
          scope: "page",
          owner: "page",
          blocking: true,
        },
      ],
    };
    assert.equal(
      isChatGptSubmissionAcknowledged(baseline, baseline, true),
      false,
    );
    assert.equal(hasChatGptResponseStarted(baseline, baseline, false), false);
    const accepted = {
      ...baseline,
      userCount: 2,
      userToken: "user-2",
      generationRequestCount: 2,
      composerText: "",
    };
    assert.equal(
      isChatGptSubmissionAcknowledged(baseline, accepted, true),
      true,
    );
    assert.equal(hasChatGptResponseStarted(baseline, accepted, false), true);
  });

  it("permits one exact failed native-tool turn to reach protocol correction", () => {
    const proof = {
      userToken: "user-tool",
      assistantToken: "assistant-tool",
      assistantMessageId: "message-tool",
      requestCount: 4,
      error: "ChatGPT app/template failed to load",
    };
    const observation = {
      userCount: 1,
      assistantCount: 1,
      userToken: proof.userToken,
      assistantToken: proof.assistantToken,
      assistantMessageId: proof.assistantMessageId,
      generationRequestCount: proof.requestCount,
      text: "",
      composerText: "[Codex tool protocol correction]",
      composer: true,
      responseBusy: true,
      webNativeToolPresent: true,
      webNativeToolError: proof.error,
      busySources: [
        {
          kind: "aria-busy",
          scope: "current-answer",
          owner: "tool-turn",
          blocking: true,
        },
        {
          kind: "stop-control",
          scope: "page",
          owner: "page",
          blocking: true,
        },
      ],
    };
    assert.equal(isRecoverableToolFailure(observation, proof), true);
    assert.equal(
      isRecoverableToolFailure(
        { ...observation, assistantMessageId: "different-message" },
        proof,
      ),
      false,
    );
    assert.equal(
      isRecoverableToolFailure(
        {
          ...observation,
          busySources: [
            ...observation.busySources,
            {
              kind: "aria-busy",
              scope: "auxiliary",
              owner: "other-dialog",
              blocking: true,
            },
          ],
        },
        proof,
      ),
      false,
    );
  });

  it("bounds preparation evidence and records failure codes without private error text", async () => {
    const trace = new CompletionTrace("preparation-test");
    for (let index = 0; index < 270; index++)
      await trace.measure("menu-state", async () => index);
    await assert.rejects(
      trace.measure("pre-submit-verify", () =>
        trace.measure("model-menu-ready", async () => {
          throw new PreparationError(
            "PRIVATE_ERROR_WITH_PROMPT",
            "model-menu-unavailable",
          );
        }),
      ),
      /PRIVATE_ERROR/,
    );
    const row = trace.finish("failed");
    assert.equal(row.preparationSteps?.length, 256);
    assert.deepEqual(row.failure, {
      stage: "model-menu-ready",
      code: "model-menu-unavailable",
    });
    assert.doesNotMatch(JSON.stringify(row), /PRIVATE_ERROR/);
    assert.equal(trace.finish("completed").failure, undefined);
  });
  it("delivers bound terminal text on the next matching observation despite a stale Stop", () => {
    const tracker = new ChatGptCompletionTracker(2_000);
    const value = {
      hasNewAssistant: true,
      text: "<codex_text>test OK</codex_text>",
      html: "",
      busy: true,
      responseBusy: true,
      completionActionVisible: false,
      terminalConfirmed: true,
      userToken: "user-new",
      assistantToken: "assistant-new",
    };
    assert.equal(tracker.update(value, 0), undefined);
    assert.equal(tracker.update(value, 250), value.text);
    assert.equal(tracker.reason, "completed-confirmed-message");
    // Revoked, mismatched or absent proof cannot inherit a completed candidate.
    assert.equal(
      tracker.update({ ...value, terminalConfirmed: false }, 4_000),
      undefined,
    );
    assert.equal(tracker.reason, "generation-busy");
  });

  it("requires two matching observations of a complete terminal tool call", () => {
    const tracker = new ChatGptCompletionTracker();
    const value = {
      hasNewAssistant: true,
      text: '<codex_tool_calls>[{"name":"read_file","arguments":{"path":"a.ts"}}]</codex_tool_calls>',
      html: "",
      busy: true,
      responseBusy: true,
      completionActionVisible: false,
      terminalConfirmed: true,
      userToken: "user-1",
      assistantToken: "assistant-1",
    };
    assert.equal(tracker.update(value, 0), undefined);
    const changed = { ...value, text: value.text.replace("a.ts", "b.ts") };
    assert.equal(tracker.update(changed, 250), undefined);
    const rebound = { ...changed, assistantToken: "assistant-2" };
    assert.equal(tracker.update(rebound, 500), undefined);
    assert.equal(tracker.update(rebound, 750), rebound.text);
  });

  it("does not carry fast completion into revoked terminal proof or rich output", () => {
    const value = {
      hasNewAssistant: true,
      text: "complete",
      html: "",
      busy: false,
      completionActionVisible: true,
      terminalConfirmed: true,
    };
    for (const changes of [
      { terminalConfirmed: false },
      { hasRenderableMedia: true },
    ]) {
      const tracker = new ChatGptCompletionTracker();
      assert.equal(tracker.update(value, 0), undefined);
      const next = { ...value, ...changes };
      assert.equal(tracker.update(next, 250), undefined);
      assert.equal(tracker.update(next, 500), undefined);
      assert.equal(tracker.update(next, 2_250), value.text);
    }
  });

  it("does not let terminal evidence bypass media, tool, partial-frame or new-message gates", () => {
    const base = {
      hasNewAssistant: true,
      text: "<codex_text>complete</codex_text>",
      html: "",
      busy: true,
      responseBusy: true,
      terminalConfirmed: true,
      completionActionVisible: true,
    };
    for (const changes of [
      { hasNewAssistant: false },
      { mediaPending: true },
      { webNativeToolPending: true },
      { webNativeToolPresent: true },
      { text: "<codex_text>partial" },
      { text: '<codex_tool_calls>[{"name":"f"}' },
    ]) {
      const tracker = new ChatGptCompletionTracker(100);
      assert.equal(tracker.update({ ...base, ...changes }, 0), undefined);
      assert.equal(tracker.update({ ...base, ...changes }, 200_000), undefined);
    }
  });

  it("binds settlement to the user and assistant identities even for identical text", () => {
    const tracker = new ChatGptCompletionTracker(1_000);
    const value = {
      hasNewAssistant: true,
      text: "same",
      html: "",
      busy: false,
      completionActionVisible: true,
      assistantToken: "a",
      userToken: "u",
    };
    tracker.update(value, 0);
    assert.equal(
      tracker.update({ ...value, assistantToken: "b" }, 999),
      undefined,
    );
    assert.equal(
      tracker.update({ ...value, assistantToken: "b" }, 1_000),
      undefined,
    );
    assert.equal(
      tracker.update({ ...value, assistantToken: "b" }, 1_999),
      "same",
    );
  });

  it("requires full text equality and preserves JSON escapes and code indentation", () => {
    assert.equal(sameCompletedBody("test OK", "test OK"), true);
    assert.equal(sameCompletedBody("partial", "partial plus final"), false);
    assert.equal(sameCompletedBody("", ""), false);
    assert.equal(
      sameCompletedBody(
        "```text\n<codex_tool_calls>[]</codex_tool_calls>\n```",
        "<codex_tool_calls>[]</codex_tool_calls>",
      ),
      true,
    );
    assert.equal(
      sameCompletedBody("if (x) {\n a()\n}", "if (x) {\n  a()\n}"),
      false,
    );
    assert.equal(sameCompletedBody('"\\n"', '"n"'), false);
  });

  it("bounds diagnostic history and never writes response bodies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "completion-diagnostics-"));
    try {
      const trace = new CompletionTrace("operation-test");
      trace.mark("submitting");
      const value = {
        text: "PRIVATE_RESPONSE_BODY",
        assistantMessageId: "message-test",
        generationState: "observing",
        terminalConfirmed: false,
        busySources: [],
      };
      for (let index = 0; index < 150; index++)
        trace.observe(value, "generation-busy", trace.started + index * 10_000);
      const row = trace.finish("completed");
      assert.equal(row.observations.length, 128);
      assert.ok(row.milestones["first-content"] !== undefined);
      assert.doesNotMatch(JSON.stringify(row), /PRIVATE_RESPONSE_BODY/);
      const path = join(directory, "completion-diagnostics.json");
      const store = new CompletionDiagnosticStore(path);
      await Promise.all(
        Array.from({ length: 103 }, (_, index) =>
          store.record({
            ...row,
            observations: [],
            operationId: "op-" + index,
          }),
        ),
      );
      const content = JSON.parse(await readFile(path, "utf8")) as Array<{
        operationId: string;
      }>;
      assert.equal(content.length, 100);
      assert.equal(content.at(-1)?.operationId, "op-102");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("retries a transient image-tool failure only for image and retry requests", () => {
    const englishFailure =
      "I couldn’t generate the image because the image generation tool hit an error just now.";
    const chineseFailure = "圖像生成失敗：圖片生成工具發生錯誤。";
    assert.equal(
      shouldRetryTransientImageGeneration(
        "build a chiikawa image",
        "",
        englishFailure,
      ),
      true,
    );
    assert.equal(
      shouldRetryTransientImageGeneration(
        "build 任dayoung",
        "這張是剛才生成的 AI 人像。",
        chineseFailure,
      ),
      true,
    );
    assert.equal(
      shouldRetryTransientImageGeneration(
        "再一次",
        chineseFailure,
        "圖像生成失敗",
      ),
      true,
    );
    assert.equal(
      shouldRetryTransientImageGeneration(
        "翻譯",
        englishFailure,
        "我無法生成圖片，因為圖片生成工具發生錯誤。",
      ),
      false,
    );
    assert.equal(
      shouldRetryTransientImageGeneration(
        "Describe the error message",
        "",
        englishFailure,
      ),
      false,
    );
    assert.equal(
      shouldRetryTransientImageGeneration(
        "generate an image",
        "",
        "I cannot help with that request.",
      ),
      false,
    );
  });

  it("does not settle active generation even when a response action is visible", () => {
    const tracker = new ChatGptCompletionTracker(100);
    const pending = {
      hasNewAssistant: true,
      text: "partial",
      html: "partial",
      busy: true,
      responseBusy: true,
      completionActionVisible: true,
    };
    assert.equal(tracker.update(pending, 0), undefined);
    assert.equal(tracker.update(pending, 10_000), undefined);
    assert.equal(
      tracker.update({ ...pending, busy: false, responseBusy: false }, 10_001),
      undefined,
    );
    assert.equal(
      tracker.update({ ...pending, busy: false, responseBusy: false }, 10_101),
      "partial",
    );
  });

  it("waits for lazy image loading even when timing text and copy controls exist", () => {
    const tracker = new ChatGptCompletionTracker(100);
    const pending = {
      hasNewAssistant: true,
      text: "Image ready",
      html: "image",
      busy: false,
      mediaPending: true,
      hasRenderableMedia: true,
      completionActionVisible: true,
    };
    assert.equal(tracker.update(pending, 0), undefined);
    assert.equal(tracker.update(pending, 10_000), undefined);
    assert.equal(
      tracker.update({ ...pending, mediaPending: false }, 10_001),
      undefined,
    );
    assert.equal(
      tracker.update({ ...pending, mediaPending: false }, 10_101),
      "Image ready",
    );
  });

  it("preserves indentation inside fenced code and nested lists", () => {
    const response = elementNode("div", [
      elementNode("pre", [
        elementNode(
          "code",
          [textNode("if ready:\n    print('ok')\n\n\n    next()")],
          { class: "language-python" },
        ),
      ]),
      elementNode("ul", [
        elementNode("li", [
          textNode("parent"),
          elementNode("ul", [elementNode("li", [textNode("child")])]),
        ]),
      ]),
    ]);
    const result = chatGptDomToMarkdown(response);
    assert.match(result, /\n {4}print\('ok'\)/);
    assert.match(result, /\n{3} {4}next\(\)/);
    assert.match(result, /\n {2}- child/);
  });

  it("preserves modern plain-text copy blocks without a language class", () => {
    const sources = [
      "先漲至少 +1%\n↓\n從該高點回檔 1%～3%\n↓\n沒有把整個上漲結構完全跌破",
      "前低 → 墊高\n    → 再墊高\n\n\n目前量 >= 前 5 根平均量 × 1.5",
      "one line",
      "```literal fence```\n    indented",
    ];
    for (const source of sources) {
      const response = elementNode("div", [
        elementNode(
          "div",
          [
            elementNode("div", [
              textNode("純文字"),
              elementNode("button", [textNode("複製程式碼")]),
            ]),
            elementNode("div", [elementNode("code", [textNode(source)])]),
          ],
          { "data-markdown-copy": "code-block" },
        ),
      ]);
      const fence = source.includes("```") ? "````" : "```";
      const expected = `${fence}\n${source}\n${fence}`;
      assert.equal(chatGptDomToMarkdown(response), expected);
      assert.equal(chatGptAssistantText(expected, [source]), expected);
    }
  });

  it("recognizes unmarked multiline code while retaining inline code", () => {
    const response = elementNode("div", [
      elementNode("p", [
        textNode("策略 "),
        elementNode("code", [textNode("B_higher_low_volume_breakout")]),
      ]),
      elementNode("div", [
        elementNode("code", [
          textNode("前低 → 墊高"),
          elementNode("br", []),
          textNode("    → 再墊高"),
        ]),
      ]),
    ]);
    assert.equal(
      chatGptDomToMarkdown(response),
      "策略 `B_higher_low_volume_breakout`\n\n```\n前低 → 墊高\n    → 再墊高\n```",
    );
  });

  it("reconstructs KaTeX display and inline formulas from one TeX source", () => {
    const katex = (source: string) =>
      elementNode(
        "span",
        [
          elementNode(
            "span",
            [
              elementNode("math", [
                elementNode("semantics", [
                  elementNode("mrow", [textNode("duplicated MathML")]),
                  elementNode("annotation", [textNode(source)], {
                    encoding: "application/x-tex",
                  }),
                ]),
              ]),
            ],
            { class: "katex-mathml" },
          ),
          elementNode("span", [textNode("duplicated visual formula")], {
            class: "katex-html",
            "aria-hidden": "true",
          }),
        ],
        { class: "katex" },
      );
    const source = "dip = 1 - \\frac{盤中截至目前最低價}{昨收}";
    const response = elementNode("div", [
      elementNode("p", [textNode("公式就是：")]),
      elementNode("span", [katex(source)], { class: "katex-display" }),
      elementNode("p", [textNode("要求："), katex("dip \\ge 1\\%")]),
    ]);
    const expected = `公式就是：\n\n\\[\n${source}\n\\]\n\n要求：\\(dip \\ge 1\\%\\)`;
    assert.equal(chatGptDomToMarkdown(response), expected);
    assert.equal(chatGptAssistantText(expected, []), expected);
    const injected = new Function(
      "root",
      `return (${chatGptDomToMarkdown.toString()})(root)`,
    );
    assert.equal(injected(response), expected);
  });

  it("keeps timing-like text, blank lines and TeX comments inside literal blocks", () => {
    const code = "if ready:\n    next()\n\n\nThought for 58s\n    done()";
    const source = "x % preserve this comment\n\n\n+ y";
    const response = elementNode("div", [
      elementNode("p", [textNode("Thought for 58s")]),
      elementNode("pre", [elementNode("code", [textNode(code)])]),
      elementNode(
        "span",
        [
          elementNode(
            "span",
            [
              elementNode("annotation", [textNode(source)], {
                encoding: "application/x-tex",
              }),
            ],
            { class: "katex" },
          ),
        ],
        { class: "katex-display" },
      ),
    ]);
    const markdown = chatGptDomToMarkdown(response);
    const expected = `\`\`\`\n${code}\n\`\`\`\n\n\\[\n${source}\n\\]`;
    assert.equal(chatGptAssistantText(markdown, [code]), expected);
  });

  it("recognizes a partial tool envelope inside a text fence", () => {
    const tracker = new ChatGptCompletionTracker(100);
    const pending = {
      hasNewAssistant: true,
      text: '```text\n<codex_tool_calls>[{"name":',
      html: "partial",
      busy: false,
      completionActionVisible: true,
    };
    assert.equal(tracker.update(pending, 0), undefined);
    assert.equal(tracker.update(pending, 10_000), undefined);
  });
  it("reconstructs headings, emphasis, lists, and tables as Markdown", () => {
    const response = elementNode("div", [
      elementNode("h2", [textNode("體脂估算")]),
      elementNode("p", [
        textNode("你現在 "),
        elementNode("strong", [textNode("77 kg")]),
        textNode("。"),
      ]),
      elementNode("ul", [
        elementNode("li", [textNode("先以 20% 為目標")]),
        elementNode("li", [textNode("保留肌肉量")]),
      ]),
      elementNode("table", [
        elementNode("thead", [
          elementNode("tr", [
            elementNode("th", [textNode("目標體脂")]),
            elementNode("th", [textNode("預估體重")]),
            elementNode("th", [textNode("需要減")]),
          ]),
        ]),
        elementNode("tbody", [
          elementNode("tr", [
            elementNode("td", [textNode("20%")]),
            elementNode("td", [textNode("73.2～74.1 kg")]),
            elementNode("td", [textNode("約 3～4 kg")]),
          ]),
          elementNode("tr", [
            elementNode("td", [textNode("18%")]),
            elementNode("td", [textNode("71.4～72.3 kg")]),
            elementNode("td", [textNode("約 5～6 kg")]),
          ]),
        ]),
      ]),
    ]);

    assert.equal(
      chatGptDomToMarkdown(response),
      [
        "## 體脂估算",
        "",
        "你現在 **77 kg**。",
        "",
        "- 先以 20% 為目標",
        "- 保留肌肉量",
        "",
        "| 目標體脂 | 預估體重 | 需要減 |",
        "| --- | --- | --- |",
        "| 20% | 73.2～74.1 kg | 約 3～4 kg |",
        "| 18% | 71.4～72.3 kg | 約 5～6 kg |",
      ].join("\n"),
    );
  });

  it("prefers fenced protocol source that preserves JSON quote escapes", () => {
    const source =
      '<codex_tool_calls>[{"name":"exec_command","arguments":{"cmd":"New-Item -Path \\"新增文字文件.txt\\""}}]</codex_tool_calls>';
    const rendered = source.replaceAll('\\"', '"');

    assert.match(rendered, /-Path "新增文字文件\.txt""/);
    assert.equal(chatGptAssistantText(rendered, [source]), source);
  });

  it("reads nested fenced source without the language label or toolbar", () => {
    const source =
      '<codex_tool_calls>[{"name":"exec","input":"text(await tools.exec_command({cmd: \\"Write-Output 42\\"}));"}]</codex_tool_calls>';
    const response = elementNode("pre", [
      elementNode("div", [
        textNode("純文字"),
        elementNode("button", [textNode("複製程式碼")]),
      ]),
      elementNode("div", [
        elementNode("code", [textNode(source)], { class: "language-text" }),
      ]),
    ]);
    const markdown = chatGptDomToMarkdown(response);
    assert.equal(markdown, `\`\`\`text\n${source}\n\`\`\``);
    assert.equal(chatGptAssistantText(markdown, [source]), source);
    const modern = elementNode("div", [
      elementNode("div", [textNode("純文字")]),
      elementNode("div", [
        elementNode("code", [textNode(source)], {
          class: "hljs language-text",
        }),
      ]),
    ]);
    const modernMarkdown = chatGptDomToMarkdown(modern);
    assert.equal(modernMarkdown, `純文字\n\n\`\`\`text\n${source}\n\`\`\``);
    assert.equal(chatGptAssistantText(modernMarkdown, [source]), source);
    const unclassified = elementNode("div", [
      elementNode("div", [textNode("純文字")]),
      elementNode("div", [elementNode("code", [textNode(source)])]),
    ]);
    const unclassifiedMarkdown = chatGptDomToMarkdown(unclassified);
    assert.equal(unclassifiedMarkdown, `純文字\n\n\`${source}\``);
    assert.equal(chatGptAssistantText(unclassifiedMarkdown, [source]), source);
  });

  it("accepts code chrome outside pre without promoting prose examples", () => {
    const source =
      '<codex_tool_calls>[{"name":"exec","input":"text(42)"}]</codex_tool_calls>';
    for (const label of ["純文字", "Plain text", "text"]) {
      for (const code of [`\`\`\`text\n${source}\n\`\`\``, `\`${source}\``]) {
        const rendered = `${label}\n\n${code}`;
        assert.equal(chatGptAssistantText(rendered, [source]), source);
        for (const explanation of [
          `工具呼叫範例：\n${rendered}`,
          `${rendered}\n以上只是範例。`,
        ])
          assert.equal(
            chatGptAssistantText(explanation, [source]),
            explanation,
          );
      }
    }
    assert.equal(
      chatGptAssistantText(
        `處理時間為 1m 52s\n純文字\n\`\`\`\n${source}\n\`\`\``,
        [source],
      ),
      source,
    );
    const tracker = new ChatGptCompletionTracker(100);
    const partial = source.slice(0, -"</codex_tool_calls>".length);
    const observation = {
      hasNewAssistant: true,
      text: chatGptAssistantText(`純文字\n\`\`\`text\n${partial}\n\`\`\``, [
        partial,
      ]),
      html: "partial",
      busy: false,
      completionActionVisible: true,
    };
    assert.equal(observation.text, partial);
    assert.equal(tracker.update(observation, 0), undefined);
    assert.equal(tracker.update(observation, 10_000), undefined);
    assert.equal(
      chatGptAssistantText(`純文字\n\`${partial}\``, [partial]),
      partial,
    );
  });

  it("removes ChatGPT timing chrome so an image-only response stays image-only", () => {
    assert.equal(chatGptAssistantText("處理時間為 1m 21s", []), "");
    assert.equal(chatGptAssistantText("Worked for 1m 31s", []), "");
    assert.equal(
      chatGptAssistantText("圖片已完成。\n\n處理時間為 1m 21s", []),
      "圖片已完成。",
    );
  });

  it("settles a timed image turn as rich media after timing chrome is removed", () => {
    const tracker = new ChatGptCompletionTracker(1_000);
    const complete = {
      hasNewAssistant: true,
      text: chatGptAssistantText("處理時間為 1m 21s", []),
      html: '<div>處理時間為 1m 21s<img src="https://example.test/image.png"></div>',
      hasRenderableMedia: true,
      busy: false,
      completionActionVisible: true,
    };

    assert.equal(tracker.update(complete, 0), undefined);
    assert.equal(tracker.update(complete, 1_000), CHAT_GPT_RICH_OUTPUT_ONLY);
  });

  it("uses a conservative stable-text fallback when completion controls drift", () => {
    const tracker = new ChatGptCompletionTracker(1_000, 5_000);
    const actionlessComplete = {
      hasNewAssistant: true,
      text: "這張圖可辨識為：理財達人。",
      html: "<p>這張圖可辨識為：理財達人。</p>",
      busy: false,
      completionActionVisible: false,
    };

    assert.equal(tracker.update(actionlessComplete, 0), undefined);
    assert.equal(tracker.update(actionlessComplete, 4_999), undefined);
    assert.equal(
      tracker.update(actionlessComplete, 5_000),
      actionlessComplete.text,
    );
  });

  it("returns the full answer only after completion evidence settles", () => {
    const tracker = new ChatGptCompletionTracker(1_000);
    const complete = {
      hasNewAssistant: true,
      text: "這張圖可辨識為：理財達人。",
      html: "<p>這張圖可辨識為：理財達人。</p>",
      busy: false,
      completionActionVisible: true,
    };

    assert.equal(tracker.update(complete, 30_000), undefined);
    assert.equal(tracker.update(complete, 30_999), undefined);
    assert.equal(tracker.update(complete, 31_000), complete.text);
  });

  it("settles a rich-media-only response instead of waiting indefinitely", () => {
    const tracker = new ChatGptCompletionTracker(1_000);
    const complete = {
      hasNewAssistant: true,
      text: "",
      html: '<img alt="Generated image" src="https://example.test/image.png">',
      hasRenderableMedia: true,
      busy: false,
      completionActionVisible: true,
    };

    assert.equal(tracker.update(complete, 0), undefined);
    assert.equal(tracker.update(complete, 999), undefined);
    assert.equal(tracker.update(complete, 1_000), CHAT_GPT_RICH_OUTPUT_ONLY);
  });

  it("restarts the settle window when the final DOM changes", () => {
    const tracker = new ChatGptCompletionTracker(1_000);
    const first = {
      hasNewAssistant: true,
      text: "第一段",
      html: "<p>第一段</p>",
      busy: false,
      completionActionVisible: true,
    };
    const final = {
      ...first,
      text: "第一段與第二段",
      html: "<p>第一段與第二段</p>",
    };

    assert.equal(tracker.update(first, 0), undefined);
    assert.equal(tracker.update(final, 900), undefined);
    assert.equal(tracker.update(final, 1_899), undefined);
    assert.equal(tracker.update(final, 1_900), final.text);
  });

  it("restarts the settle window after a busy observation", () => {
    const tracker = new ChatGptCompletionTracker(1_000, 5_000);
    const complete = {
      hasNewAssistant: true,
      text: "完成",
      html: "<p>完成</p>",
      busy: false,
      completionActionVisible: false,
    };

    assert.equal(tracker.update(complete, 0), undefined);
    assert.equal(tracker.update({ ...complete, busy: true }, 4_000), undefined);
    assert.equal(tracker.update(complete, 5_000), undefined);
    assert.equal(tracker.update(complete, 9_999), undefined);
    assert.equal(tracker.update(complete, 10_000), complete.text);
  });

  it("never settles prose while an unsupported web-native tool is present", () => {
    const tracker = new ChatGptCompletionTracker(1_000);
    const completedBesideNativeTool = {
      hasNewAssistant: true,
      text: "完整回答",
      html: "<p>完整回答</p>",
      busy: false,
      webNativeToolPresent: true,
      completionActionVisible: true,
    };

    assert.equal(tracker.update(completedBesideNativeTool, 0), undefined);
    assert.equal(tracker.update(completedBesideNativeTool, 10_000), undefined);
  });

  it("settles a completed answer while unrelated voice UI remains busy", () => {
    const tracker = new ChatGptCompletionTracker(1_000);
    const completedWhileVoiceIsBusy = {
      hasNewAssistant: true,
      text: "這是已經完成的回答。",
      html: "<p>這是已經完成的回答。</p>",
      busy: true,
      completionActionVisible: true,
    };

    assert.equal(tracker.update(completedWhileVoiceIsBusy, 0), undefined);
    assert.equal(
      tracker.update(completedWhileVoiceIsBusy, 1_000),
      completedWhileVoiceIsBusy.text,
    );
  });

  it("waits for a complete Codex client-tool envelope", () => {
    const tracker = new ChatGptCompletionTracker(1_000);
    const partial = {
      hasNewAssistant: true,
      text: '<codex_tool_calls>[{"name":"exec_command"',
      html: '<p>&lt;codex_tool_calls&gt;[{"name":"exec_command"</p>',
      busy: false,
      completionActionVisible: true,
    };
    const complete = {
      ...partial,
      text: '<codex_tool_calls>[{"name":"exec_command","arguments":{"cmd":"Get-Date"}}]</codex_tool_calls>',
      html: '<p>&lt;codex_tool_calls&gt;[{"name":"exec_command","arguments":{"cmd":"Get-Date"}}]&lt;/codex_tool_calls&gt;</p>',
    };

    assert.equal(tracker.update(partial, 0), undefined);
    assert.equal(tracker.update(partial, 10_000), undefined);
    assert.equal(tracker.update(complete, 10_001), undefined);
    assert.equal(tracker.update(complete, 11_001), complete.text);
  });

  it("waits while the Codex client-tool opening marker is still streaming", () => {
    const tracker = new ChatGptCompletionTracker(1_000);
    const partialMarker = {
      hasNewAssistant: true,
      text: "<codex_tool_cal",
      html: "<p>&lt;codex_tool_cal</p>",
      busy: false,
      completionActionVisible: true,
    };

    assert.equal(tracker.update(partialMarker, 0), undefined);
    assert.equal(tracker.update(partialMarker, 10_000), undefined);
  });
});
