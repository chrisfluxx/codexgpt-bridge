import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyOperationFailure,
  operationRecovery,
  type OperationFailureCode,
} from "./operation-failure.js";

function coded(code: string, diagnosticCode?: string): Error {
  return Object.assign(new Error("private provider detail"), {
    code,
    ...(diagnosticCode ? { diagnosticCode } : {}),
  });
}

describe("operation failure recovery", () => {
  it("preserves bounded preparation reasons instead of collapsing model failures", () => {
    for (const code of [
      "unrelated-dialog",
      "model-menu-unavailable",
      "model-selection-missing",
      "model-selection-ambiguous",
      "model-selection-disabled",
      "model-selection-mismatch",
      "full-mcp-connector-unavailable",
      "native-tool-selection-active",
    ] as const) {
      assert.equal(
        classifyOperationFailure(coded("chatgpt_web_preparation_failed", code)),
        code,
      );
    }
    assert.equal(
      classifyOperationFailure(
        coded("chatgpt_web_preparation_failed", "arbitrary-private-value"),
      ),
      "preparation-failed",
    );
  });

  it("classifies stable provider codes before message fallbacks", () => {
    const cases = [
      ["bridge_operation_recovery_required", "recovery-required"],
      ["bridge_stream_conflict", "stream-conflict"],
      ["chatgpt_web_rate_limited", "rate-limited"],
      ["chatgpt_web_session_expired", "session-expired"],
      ["chatgpt_web_session_unavailable", "session-unavailable"],
      ["chatgpt_web_verification_required", "verification-required"],
      ["bridge_full_mcp_unavailable", "full-mcp-unavailable"],
      ["bridge_context_limit_exceeded", "context-limit"],
      ["bridge_structured_output_invalid", "structured-output-invalid"],
    ] as const;
    for (const [input, expected] of cases)
      assert.equal(classifyOperationFailure(coded(input)), expected);

    assert.equal(
      classifyOperationFailure(new DOMException("stop", "AbortError")),
      "cancelled",
    );
    assert.equal(
      classifyOperationFailure(new Error("The browser turn timed out")),
      "timeout",
    );
    assert.equal(
      classifyOperationFailure(new Error("unrecognized private detail")),
      "provider-error",
    );
    assert.equal(
      classifyOperationFailure(
        new Error(
          "ChatGPT exposed duplicate logical message identities; response binding is ambiguous.",
        ),
      ),
      "stream-conflict",
    );
  });

  it("maps every public failure code to fixed, prompt-free recovery guidance", () => {
    const codes: readonly OperationFailureCode[] = [
      "cancelled",
      "recovery-required",
      "stream-conflict",
      "rate-limited",
      "session-expired",
      "session-unavailable",
      "verification-required",
      "unrelated-dialog",
      "model-menu-unavailable",
      "model-selection-missing",
      "model-selection-ambiguous",
      "model-selection-disabled",
      "model-selection-mismatch",
      "full-mcp-connector-unavailable",
      "native-tool-selection-active",
      "preparation-failed",
      "web-tool-failed",
      "full-mcp-unavailable",
      "context-limit",
      "structured-output-invalid",
      "timeout",
      "provider-error",
    ];
    for (const code of codes) {
      const recovery = operationRecovery(code);
      assert.ok(recovery.title.length > 0);
      assert.ok(recovery.instruction.length > 0);
      assert.doesNotMatch(
        JSON.stringify(recovery),
        /private provider detail|prompt|cookie|authorization|bearer/i,
      );
    }
    assert.deepEqual(operationRecovery("rate-limited"), {
      title: "ChatGPT cooldown active",
      instruction:
        "Wait until the queue summary says ready, then start a new turn. Other queued tasks resume automatically; this failed operation is not resent.",
      action: "wait",
      automatic: false,
    });
    assert.equal(operationRecovery("session-expired").action, "open-login");
    assert.equal(
      operationRecovery("model-selection-mismatch").action,
      "open-task",
    );
    assert.deepEqual(operationRecovery("full-mcp-connector-unavailable"), {
      title: "Full MCP app unavailable",
      instruction:
        "Full MCP currently requires ChatGPT Business, Enterprise, or Edu and an enabled custom app with the exact configured name. Create or enable that app, or choose Simple for a new turn.",
      action: "open-task",
      automatic: false,
    });
  });
});
