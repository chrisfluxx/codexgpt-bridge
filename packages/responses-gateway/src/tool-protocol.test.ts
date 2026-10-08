import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compileResponsesPrompt,
  type CompiledResponsesPrompt,
} from "./prompt.js";
import {
  bridgeGeneratedImagesEnvelope,
  normalizeResponsesTools,
  parseBridgeWebTurnResult,
  parseBridgeGeneratedImagesEnvelope,
  prepareBridgeWebTurn,
} from "./tool-protocol.js";

it("keeps native image bytes out of textual tool results while preserving Full delivery", () => {
  const imageUrl = "data:image/png;base64,binary-payload-marker";
  const output = [
    { type: "text", text: "Image read successfully" },
    { type: "input_image", image_url: imageUrl },
  ];
  const compiled = compileResponsesPrompt({
    input: [
      { role: "user", content: "Read the image." },
      {
        type: "function_call",
        name: "view_image",
        call_id: "image-call",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "image-call", output },
    ],
  });
  const prepared = prepareBridgeWebTurn(compiled);
  assert.match(prepared.prompt, /Image read successfully/);
  assert.doesNotMatch(prepared.prompt, /nativeOutput|binary-payload-marker/);
  assert.deepEqual(compiled.toolResults[0]!.nativeOutput, output);
  assert.equal(compiled.images[0]!.imageUrl, imageUrl);
});

const namespaceTool = {
  type: "namespace",
  name: "codexgpt-bridge",
  tools: [
    {
      type: "function",
      name: "open_workspace",
      description: "Open an allowed workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
};

const bridgeToolSet = {
  type: "namespace",
  name: "codexgpt-bridge",
  tools: [
    "list_workspaces",
    "open_workspace",
    "read_file",
    "list_directory",
    "search_text",
    "apply_patch",
    "exec_command",
    "write_stdin",
    "show_changes",
    "close_workspace",
  ].map((name) => ({
    type: "function",
    name,
    description: `${name} bridge tool.`,
    parameters: { type: "object", properties: {} },
  })),
};

const toolSearch = {
  type: "tool_search",
  description: "Search for deferred Codex tools.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
  },
};

const imageGenerationTool = {
  type: "namespace",
  name: "image_gen",
  tools: [
    {
      type: "function",
      name: "imagegen",
      description: "Generate or edit an image for the user.",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
      },
    },
  ],
};

function compiled(
  prompt: string,
  overrides: Partial<CompiledResponsesPrompt> = {},
): CompiledResponsesPrompt {
  return {
    context: { instructions: "", history: [], ledger: [], images: [] },
    toolChoice: "auto",
    parallelToolCalls: true,
    prompt,
    images: [],
    textFormat: { type: "text" },
    hasToolDefinitions: true,
    toolChoiceRequired: false,
    toolDefinitions: [namespaceTool],
    toolResults: [],
    ...overrides,
  };
}

describe("Codex browser tool protocol", () => {
  it("wraps and unwraps Bridge-captured generated image Markdown", () => {
    const markdown = "![Generated image](C:/tmp/generated.png)";
    const envelope = bridgeGeneratedImagesEnvelope(markdown);

    assert.equal(parseBridgeGeneratedImagesEnvelope(envelope), markdown);
    assert.equal(parseBridgeGeneratedImagesEnvelope(markdown), undefined);
  });

  it("does not require tools when the current instruction forbids them", () => {
    for (const prompt of [
      "Repeat the earlier token. Do not call any tools.",
      "Repeat the earlier token. Don't use tools.",
      "Never invoke tools. Answer from the previous result.",
      "Avoid calling tools. Answer from history.",
      "回覆先前的結果，不要呼叫任何工具。",
      "不要使用工具，直接回答。",
    ]) {
      assert.equal(
        prepareBridgeWebTurn(compiled(prompt)).expectsToolCall,
        false,
        prompt,
      );
    }
    assert.equal(
      prepareBridgeWebTurn(
        compiled("Do not use web tools. Use Codex tools to read the file."),
      ).expectsToolCall,
      true,
    );
    assert.equal(
      prepareBridgeWebTurn(
        compiled("Do not call tools.", { toolChoiceRequired: true }),
      ).expectsToolCall,
      true,
    );
  });

  it("keeps simple questions verbatim", () => {
    const prepared = prepareBridgeWebTurn(compiled("test"));
    assert.equal(prepared.protocolActive, prepared.tools.length > 0);
    assert.equal(prepared.expectsToolCall, false);
    assert.equal(prepared.prompt, "test");
    assert.match(prepared.contract ?? "", /Markdown directly/u);
    assert.doesNotMatch(prepared.contract ?? "", /codex_text/u);
    assert.match(prepared.contract ?? "", /<codex_tool_calls>/u);
    assert.deepEqual(parseBridgeWebTurnResult("I don't know.", prepared), {
      kind: "text",
      text: "I don't know.",
    });
  });

  it("preserves ordinary Markdown and retained comment-frame answers", () => {
    const prepared = prepareBridgeWebTurn(compiled("show the architecture"));
    const markdown = [
      "Architecture:",
      "",
      "```text",
      "Codex",
      "  |",
      "  v",
      "ChatGPT Web",
      "```",
    ].join("\n");

    assert.deepEqual(parseBridgeWebTurnResult(markdown, prepared), {
      kind: "text",
      text: markdown,
    });
    assert.deepEqual(
      parseBridgeWebTurnResult(
        `<!--codex_text-->\n${markdown}\n<!--/codex_text-->`,
        prepared,
      ),
      { kind: "text", text: markdown },
    );
  });

  it("requires exactly one real subagent for an explicit one-subagent request", () => {
    const prepared = prepareBridgeWebTurn(
      compiled("建立一個子代理，等它完成後回覆結果。", {
        toolDefinitions: [
          {
            type: "custom",
            name: "exec",
            namespace: "functions",
            description: "Run JavaScript to orchestrate tool calls.",
            format: { type: "text" },
          },
        ],
      }),
    );

    assert.equal(prepared.expectsToolCall, true);
    assert.equal(prepared.requiresSubagent, true);
    assert.equal(prepared.subagentCount, 1);
    assert.equal(prepared.requiredTool, "exec");
    assert.match(prepared.contract ?? "", /multi_agent_v1__spawn_agent/);
    assert.match(
      prepared.contract ?? "",
      /exactly 1 successful subagent result/,
    );
  });

  it("does not turn a question about prior subagents into a new spawn request", () => {
    const prepared = prepareBridgeWebTurn(
      compiled("為什麼建立了三個子代理？", {
        toolDefinitions: [
          {
            type: "custom",
            name: "exec",
            namespace: "functions",
            description: "Run JavaScript to orchestrate tool calls.",
          },
        ],
      }),
    );

    assert.equal(prepared.requiresSubagent, undefined);
    assert.equal(prepared.expectsToolCall, false);
  });

  it("accepts a currently available tool on a follow-up without local keywords", () => {
    const prompt = "你知道目前已有幾部，撞號機率多少嗎";
    const prepared = prepareBridgeWebTurn(
      compiled(prompt, {
        toolDefinitions: [{ type: "function", name: "exec_command" }],
      }),
    );
    assert.equal(prepared.protocolActive, prepared.tools.length > 0);
    assert.equal(prepared.prompt, prompt);
    const result = parseBridgeWebTurnResult(
      '<codex_tool_calls>[{"name":"exec_command","arguments":{"cmd":"Write-Output 42"}}]</codex_tool_calls>',
      prepared,
    );
    assert.equal(result.kind, "tool_calls");
    if (result.kind !== "tool_calls") return;
    assert.equal(result.calls[0]?.name, "exec_command");
    assert.deepEqual(result.calls[0]?.arguments, { cmd: "Write-Output 42" });
  });

  it("rejects stale and missing tools on a follow-up", () => {
    const envelope =
      '<codex_tool_call>{"name":"exec_command","arguments":{}}</codex_tool_call>';
    assert.throws(
      () =>
        parseBridgeWebTurnResult(
          envelope,
          prepareBridgeWebTurn(compiled("多少嗎")),
        ),
      /unavailable tool: exec_command/,
    );
    assert.throws(
      () =>
        parseBridgeWebTurnResult(
          envelope,
          prepareBridgeWebTurn(
            compiled("多少嗎", {
              hasToolDefinitions: false,
              toolDefinitions: [],
            }),
          ),
        ),
      /outside an active tool turn/,
    );
  });

  it("accepts a fenced follow-up call but leaves explanatory examples as text", () => {
    const prepared = prepareBridgeWebTurn(
      compiled("多少嗎", {
        toolDefinitions: [{ type: "function", name: "exec_command" }],
      }),
    );
    const envelope =
      '<codex_tool_calls>[{"name":"exec_command","arguments":{}}]</codex_tool_calls>';
    const fenced = `\`\`\`text\n${envelope}\n\`\`\``;
    assert.equal(parseBridgeWebTurnResult(fenced, prepared).kind, "tool_calls");
    const explanation = `工具呼叫範例：\n${fenced}\n以上只是範例。`;
    assert.deepEqual(parseBridgeWebTurnResult(explanation, prepared), {
      kind: "text",
      text: explanation,
    });
  });

  it("routes image-generation commands through the Codex client image tool", () => {
    const prepared = prepareBridgeWebTurn(
      compiled("生成一張chiikawa", {
        toolDefinitions: [toolSearch, bridgeToolSet, imageGenerationTool],
      }),
    );

    assert.equal(prepared.protocolActive, true);
    assert.equal(prepared.expectsToolCall, false);
    assert.ok(
      prepared.tools.some((tool) => tool.wireName === "image_gen__imagegen"),
    );
    assert.match(prepared.contract ?? "", /imagegen/);
  });

  it("allows web-native image generation when no Codex image tool is available", () => {
    const prompt = "生成一張白底紅色圓形測試圖";
    const prepared = prepareBridgeWebTurn(
      compiled(prompt, {
        hasToolDefinitions: false,
        toolDefinitions: [],
      }),
    );

    assert.equal(prepared.protocolActive, prepared.tools.length > 0);
    assert.equal(prepared.expectsToolCall, false);
    assert.equal(prepared.prompt, prompt);
  });

  it("does not misclassify image-generation troubleshooting as a new image command", () => {
    const prompt = "我看 GPT 已經生成圖片，但 Codex 還卡在正在思考";
    const prepared = prepareBridgeWebTurn(
      compiled(prompt, {
        toolDefinitions: [imageGenerationTool],
      }),
    );

    assert.equal(prepared.protocolActive, prepared.tools.length > 0);
    assert.equal(prepared.expectsToolCall, false);
    assert.equal(prepared.prompt, prompt);
  });

  it("adds a compact tool contract for local file requests", () => {
    const prepared = prepareBridgeWebTurn(
      compiled("C:\\work 可以在這裡新增檔案嗎？"),
    );
    assert.equal(prepared.protocolActive, true);
    assert.equal(prepared.expectsToolCall, false);
    assert.match(prepared.contract ?? "", /codex_tool_calls/);
    assert.match(prepared.contract ?? "", /fenced text block/);
    assert.match(prepared.contract ?? "", /Preserve JSON escapes/);
    assert.match(prepared.contract ?? "", /codexgpt-bridge__open_workspace/);
    assert.doesNotMatch(prepared.prompt, /large base instructions/);
  });

  it("requires a tool call when the user explicitly asks for a Codex tool", () => {
    const prepared = prepareBridgeWebTurn(
      compiled(
        "請使用 Codex 工具讀取工作區根目錄的 .bridge-live-probe.txt，禁止猜測。",
      ),
    );

    assert.equal(prepared.protocolActive, true);
    assert.equal(prepared.expectsToolCall, true);
  });

  it("does not require a tool call for a question about Codex tools", () => {
    const prepared = prepareBridgeWebTurn(compiled("Codex 工具有哪些用途？"));

    assert.equal(prepared.expectsToolCall, false);
  });

  it("retains all declared tools and discovery", () => {
    const prepared = prepareBridgeWebTurn(
      compiled("在目前專案新增 txt 檔案", {
        toolDefinitions: [toolSearch, bridgeToolSet],
      }),
    );
    const names = prepared.tools.map((tool) => tool.wireName);

    assert.equal(
      names.length,
      normalizeResponsesTools([toolSearch, bridgeToolSet]).length,
    );
    assert.ok(names.includes("tool_search"));
    assert.ok(names.includes("codexgpt-bridge__open_workspace"));
    assert.ok(names.includes("codexgpt-bridge__apply_patch"));
    assert.ok(names.includes("codexgpt-bridge__exec_command"));
    assert.ok(names.includes("codexgpt-bridge__write_stdin"));
    assert.ok(names.includes("codexgpt-bridge__show_changes"));
    assert.match(prepared.contract ?? "", /codexgpt-bridge__close_workspace/);
  });

  it("promotes search tools when the request asks to find files", () => {
    const prepared = prepareBridgeWebTurn(
      compiled("搜尋並列出專案目錄裡的設定檔", {
        toolDefinitions: [toolSearch, bridgeToolSet],
      }),
    );
    const names = prepared.tools.map((tool) => tool.wireName);

    assert.equal(
      names.length,
      normalizeResponsesTools([toolSearch, bridgeToolSet]).length,
    );
    assert.ok(names.includes("tool_search"));
    assert.ok(names.includes("codexgpt-bridge__search_text"));
    assert.ok(names.includes("codexgpt-bridge__list_directory"));
  });

  it("preserves large parameter descriptions without weakening the schema", () => {
    const prepared = prepareBridgeWebTurn(
      compiled("執行大型工具", {
        toolDefinitions: [
          {
            type: "function",
            name: "oversized_tool",
            description: "A tool with an oversized parameter description.",
            parameters: {
              type: "object",
              properties: {
                payload: {
                  type: "string",
                  description: "x".repeat(50_000),
                },
              },
              required: ["payload"],
            },
          },
        ],
      }),
    );
    assert.match(prepared.contract ?? "", /x{50000}/);
    assert.equal(prepared.tools.length, 1);
  });

  it("preserves all client-authorized namespaces instead of preferring Bridge", () => {
    const prepared = prepareBridgeWebTurn(
      compiled("C:\\work 新增檔案", {
        toolDefinitions: [
          {
            type: "namespace",
            name: "codex_apps",
            tools: [
              {
                type: "function",
                name: "devspace_open_workspace",
                description: "Local coding workspace through DevSpace MCP.",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
          {
            type: "function",
            name: "unrelated_file_tool",
            description: "Another local file tool.",
            parameters: { type: "object", properties: {} },
          },
          namespaceTool,
        ],
      }),
    );

    assert.deepEqual(
      prepared.tools.map((tool) => tool.wireName),
      [
        "codex_apps__devspace_open_workspace",
        "unrelated_file_tool",
        "codexgpt-bridge__open_workspace",
      ],
    );
    assert.match(prepared.contract ?? "", /devspace/i);
    assert.match(prepared.contract ?? "", /unrelated_file_tool/);
  });

  it("flattens namespaces and parses an exact function call", () => {
    const tools = normalizeResponsesTools([namespaceTool]);
    assert.deepEqual(
      tools.map((tool) => tool.wireName),
      ["codexgpt-bridge__open_workspace"],
    );
    const prepared = prepareBridgeWebTurn(compiled("開啟 C:\\work"));
    const result = parseBridgeWebTurnResult(
      '<codex_tool_calls>[{"name":"codexgpt-bridge__open_workspace","arguments":{"path":"C:\\\\work"}}]</codex_tool_calls>',
      prepared,
    );
    assert.equal(result.kind, "tool_calls");
    if (result.kind !== "tool_calls") return;
    assert.deepEqual(result.calls[0], {
      kind: "function",
      wireName: "codexgpt-bridge__open_workspace",
      name: "open_workspace",
      namespace: "codexgpt-bridge",
      arguments: { path: "C:\\work" },
    });
  });

  it("repairs unescaped backslashes in Windows path tool arguments", () => {
    const prepared = prepareBridgeWebTurn(compiled("開啟 C:\\work"));
    const result = parseBridgeWebTurnResult(
      '<codex_tool_calls>[{"name":"codexgpt-bridge__open_workspace","arguments":{"path":"C:\\Users\\example-user\\Desktop\\範例資料夾 (3)"}}]</codex_tool_calls>',
      prepared,
    );
    assert.equal(result.kind, "tool_calls");
    if (result.kind !== "tool_calls") return;
    assert.equal(
      result.calls[0]?.arguments.path,
      "C:\\Users\\example-user\\Desktop\\範例資料夾 (3)",
    );
  });

  it("parses a fenced tool envelope with escaped quotes in a shell command", () => {
    const prepared = prepareBridgeWebTurn(
      compiled("新增 txt", {
        toolDefinitions: [
          {
            type: "function",
            name: "exec_command",
            description: "Run a shell command.",
            parameters: {
              type: "object",
              properties: { cmd: { type: "string" } },
              required: ["cmd"],
            },
          },
        ],
      }),
    );
    const result = parseBridgeWebTurnResult(
      '```text\n<codex_tool_calls>[{"name":"exec_command","arguments":{"cmd":"New-Item -Path \\"新增文字文件.txt\\""}}]</codex_tool_calls>\n```',
      prepared,
    );
    assert.equal(result.kind, "tool_calls");
    if (result.kind !== "tool_calls") return;
    assert.equal(
      result.calls[0]?.arguments.cmd,
      'New-Item -Path "新增文字文件.txt"',
    );
  });

  it("maps custom tool input and rejects unadvertised tools", () => {
    const prepared = prepareBridgeWebTurn(
      compiled("修改檔案", {
        toolDefinitions: [
          {
            type: "custom",
            name: "apply_patch",
            description: "Apply a patch.",
          },
        ],
      }),
    );
    const result = parseBridgeWebTurnResult(
      '<codex_tool_call>{"name":"apply_patch","arguments":{"input":"*** Begin Patch"}}</codex_tool_call>',
      prepared,
    );
    assert.equal(result.kind, "tool_calls");
    if (result.kind === "tool_calls") {
      assert.equal(result.calls[0]?.input, "*** Begin Patch");
    }
    assert.throws(
      () =>
        parseBridgeWebTurnResult(
          '<codex_tool_call>{"name":"unknown","arguments":{}}</codex_tool_call>',
          prepared,
        ),
      /unavailable tool/,
    );
  });

  it("forces the protocol after a client tool result", () => {
    const prepared = prepareBridgeWebTurn(
      compiled("original request", {
        toolResults: [
          {
            callId: "call_1",
            kind: "function_call_output",
            toolName: "codexgpt-bridge__open_workspace",
            output: '{"workspace_id":"ws_1"}',
          },
        ],
      }),
    );
    assert.equal(prepared.protocolActive, true);
    assert.match(prepared.prompt, /call_1/);
    assert.match(prepared.prompt, /Continue the same user task/);
  });

  it("continues from tool results when Codex omits tools on the next request", () => {
    const prepared = prepareBridgeWebTurn(
      compiled("original request", {
        hasToolDefinitions: false,
        toolDefinitions: [],
        toolResults: [
          {
            callId: "call_2",
            kind: "function_call_output",
            toolName: "write_file",
            output: "created",
          },
        ],
      }),
    );
    assert.equal(prepared.protocolActive, false);
    assert.equal(prepared.expectsToolCall, false);
    assert.match(prepared.prompt, /call_2/);
    assert.match(prepared.prompt, /created/);
  });

  it("allows a final answer after the explicitly requested tool has returned", () => {
    const source = compiled(
      "請使用工具執行 Write-Output 42，取得工具結果後只回覆結果。",
      {
        toolDefinitions: [{ type: "function", name: "exec_command" }],
        toolResults: [
          {
            callId: "call_done",
            kind: "function_call_output",
            toolName: "exec_command",
            output: "42",
          },
        ],
      },
    );
    const prepared = prepareBridgeWebTurn(source);
    assert.equal(prepared.expectsToolCall, false);
    assert.deepEqual(
      parseBridgeWebTurnResult(
        "<!--codex_text-->\n42\n<!--/codex_text-->",
        prepared,
      ),
      { kind: "text", text: "42" },
    );
    assert.equal(
      prepareBridgeWebTurn({
        ...source,
        toolChoice: "required",
        toolChoiceRequired: true,
      }).expectsToolCall,
      true,
    );
    assert.equal(
      prepareBridgeWebTurn({
        ...source,
        toolChoice: { type: "function", name: "exec_command" },
      }).expectsToolCall,
      true,
    );
  });
});
