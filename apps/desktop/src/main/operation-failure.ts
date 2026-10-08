import type {
  OperationFailureCode,
  OperationRecovery,
  PreparationFailureCode,
} from "./operation-failure-types.js";
export type {
  OperationFailureCode,
  OperationRecovery,
  OperationRecoveryAction,
  PreparationFailureCode,
} from "./operation-failure-types.js";

const PREPARATION_FAILURES = new Set<PreparationFailureCode>([
  "unrelated-dialog",
  "model-menu-unavailable",
  "model-selection-missing",
  "model-selection-ambiguous",
  "model-selection-disabled",
  "model-selection-mismatch",
  "full-mcp-connector-unavailable",
  "native-tool-selection-active",
]);

function errorProperty(error: unknown, key: string): unknown {
  return typeof error === "object" && error !== null && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

export function classifyOperationFailure(error: unknown): OperationFailureCode {
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  const code = errorProperty(error, "code");
  const diagnosticCode = errorProperty(error, "diagnosticCode");
  if (
    typeof diagnosticCode === "string" &&
    PREPARATION_FAILURES.has(diagnosticCode as PreparationFailureCode)
  )
    return diagnosticCode as PreparationFailureCode;
  if (code === "bridge_operation_recovery_required") return "recovery-required";
  if (code === "bridge_stream_conflict") return "stream-conflict";
  if (code === "chatgpt_web_rate_limited") return "rate-limited";
  if (code === "chatgpt_web_session_expired") return "session-expired";
  if (code === "chatgpt_web_session_unavailable") return "session-unavailable";
  if (code === "chatgpt_web_verification_required")
    return "verification-required";
  if (code === "chatgpt_web_preparation_failed") return "preparation-failed";
  if (code === "bridge_full_mcp_unavailable") return "full-mcp-unavailable";
  if (code === "bridge_context_limit_exceeded") return "context-limit";
  if (code === "bridge_structured_output_invalid")
    return "structured-output-invalid";
  if (error instanceof Error && error.name === "UnsupportedWebNativeToolError")
    return "web-tool-failed";
  if (
    error instanceof Error &&
    /streamed|Network answer|text frame|duplicate logical message identities/.test(
      error.message,
    )
  )
    return "stream-conflict";
  if (
    error instanceof Error &&
    /timed out|within \d+ seconds|queue was busy/.test(error.message)
  )
    return "timeout";
  return "provider-error";
}

const RECOVERY: Readonly<Record<OperationFailureCode, OperationRecovery>> = {
  "verification-required": {
    title: "Browser verification needs your action",
    instruction:
      "Complete verification in the existing task tab before starting a new turn. Bridge will not open another tab or resend automatically.",
    action: "open-task",
    automatic: false,
  },
  cancelled: {
    title: "Task cancelled",
    instruction: "Bridge stopped this task and did not submit another message.",
    action: "none",
    automatic: false,
  },
  "recovery-required": {
    title: "Previous send needs inspection",
    instruction:
      "Open the ChatGPT task and confirm whether the previous message or action completed before starting a new turn.",
    action: "open-task",
    automatic: false,
  },
  "stream-conflict": {
    title: "Response stream changed",
    instruction:
      "Open the ChatGPT task and inspect the existing answer. Bridge will not resend an uncertain operation automatically.",
    action: "open-task",
    automatic: false,
  },
  "rate-limited": {
    title: "ChatGPT cooldown active",
    instruction:
      "Wait until the queue summary says ready, then start a new turn. Other queued tasks resume automatically; this failed operation is not resent.",
    action: "wait",
    automatic: false,
  },
  "session-expired": {
    title: "ChatGPT sign-in expired",
    instruction:
      "Open the sign-in window, finish authentication, then start a new turn.",
    action: "open-login",
    automatic: false,
  },
  "session-unavailable": {
    title: "ChatGPT session could not be verified",
    instruction:
      "Open the sign-in window and check ChatGPT connectivity before trying a new turn.",
    action: "open-login",
    automatic: false,
  },
  "unrelated-dialog": {
    title: "ChatGPT dialog blocked preparation",
    instruction:
      "Open the task, close the unrelated dialog, and start a new turn.",
    action: "open-task",
    automatic: false,
  },
  "model-menu-unavailable": {
    title: "Model controls were unavailable",
    instruction:
      "Open the task, reload ChatGPT if needed, and retry only after the model controls are visible.",
    action: "open-task",
    automatic: false,
  },
  "model-selection-missing": {
    title: "Model selection could not be verified",
    instruction:
      "Open the task and make the composer model controls visible before starting a new turn.",
    action: "open-task",
    automatic: false,
  },
  "model-selection-ambiguous": {
    title: "Multiple model controls were detected",
    instruction:
      "Open the task, close duplicate menus or dialogs, and start a new turn after one selection remains.",
    action: "open-task",
    automatic: false,
  },
  "model-selection-disabled": {
    title: "Requested model is locked",
    instruction:
      "Open ChatGPT, choose a model available to this account, then refresh Bridge capabilities.",
    action: "open-task",
    automatic: false,
  },
  "model-selection-mismatch": {
    title: "Selected model did not match",
    instruction:
      "Open the task and confirm the model family and effort before starting a new turn.",
    action: "open-task",
    automatic: false,
  },
  "native-tool-selection-active": {
    title: "A ChatGPT-native tool was selected",
    instruction:
      "Open the task, clear the native tool selection, and start a new Codex turn.",
    action: "open-task",
    automatic: false,
  },
  "full-mcp-connector-unavailable": {
    title: "Full MCP app unavailable",
    instruction:
      "Full MCP currently requires ChatGPT Business, Enterprise, or Edu and an enabled custom app with the exact configured name. Create or enable that app, or choose Simple for a new turn.",
    action: "open-task",
    automatic: false,
  },
  "preparation-failed": {
    title: "ChatGPT preparation failed",
    instruction:
      "Open the task, check the composer state, and retry with a new turn after correcting it.",
    action: "open-task",
    automatic: false,
  },
  "web-tool-failed": {
    title: "Unsupported ChatGPT Web tool",
    instruction:
      "Open the task and inspect the response. Use the corresponding Codex tool in a new turn.",
    action: "open-task",
    automatic: false,
  },
  "full-mcp-unavailable": {
    title: "Full MCP connector unavailable",
    instruction:
      "Refresh the ChatGPT connector and check the Tunnel, or explicitly choose Simple for a new turn.",
    action: "open-task",
    automatic: false,
  },
  "context-limit": {
    title: "Bridge input limit exceeded",
    instruction:
      "Compact the Codex task and start a new turn. The oversized send was not submitted.",
    action: "none",
    automatic: false,
  },
  "structured-output-invalid": {
    title: "Structured response stayed invalid",
    instruction:
      "Open the task and inspect the existing answer before requesting a new formatted response.",
    action: "open-task",
    automatic: false,
  },
  timeout: {
    title: "Browser operation timed out",
    instruction:
      "Open the task and inspect ChatGPT before retrying; the previous send may already have been accepted.",
    action: "open-task",
    automatic: false,
  },
  "provider-error": {
    title: "ChatGPT provider failed",
    instruction:
      "Open the task and inspect its current state before starting a new turn.",
    action: "open-task",
    automatic: false,
  },
};

export function operationRecovery(
  code: OperationFailureCode,
): OperationRecovery {
  return RECOVERY[code];
}
