export type PreparationFailureCode =
  | "unrelated-dialog"
  | "model-menu-unavailable"
  | "model-selection-missing"
  | "model-selection-ambiguous"
  | "model-selection-disabled"
  | "model-selection-mismatch"
  | "full-mcp-connector-unavailable"
  | "native-tool-selection-active";

export type OperationFailureCode =
  | "cancelled"
  | "recovery-required"
  | "stream-conflict"
  | "rate-limited"
  | "session-expired"
  | "session-unavailable"
  | "verification-required"
  | PreparationFailureCode
  | "preparation-failed"
  | "web-tool-failed"
  | "full-mcp-unavailable"
  | "context-limit"
  | "structured-output-invalid"
  | "timeout"
  | "provider-error";

export type OperationRecoveryAction =
  "open-task" | "open-login" | "wait" | "none";

export interface OperationRecovery {
  readonly title: string;
  readonly instruction: string;
  readonly action: OperationRecoveryAction;
  readonly automatic: boolean;
}
