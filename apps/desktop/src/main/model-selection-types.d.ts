import type {
  BridgeExecutionPreflight,
  BridgeWebMode,
} from "@codexgpt-bridge/responses-gateway";

export interface ModelUiObservation {
  readonly model: string | null;
  readonly mode: BridgeWebMode | null;
  readonly modeLabel: string | null;
  readonly surface: "direct" | "configure" | "legacy" | "missing";
  readonly availableModels: readonly string[];
  readonly ambiguous: boolean;
  readonly disabled: boolean;
  /** Only aria-describedby text attached to the active composer picker/slider. */
  readonly modelDescriptions?: readonly string[];
}

export interface ModelExecutionReceipt {
  readonly version: 1;
  readonly operationId: string;
  readonly requestedRoute: string;
  readonly requestedModel: string | null;
  readonly requestedMode: BridgeWebMode;
  /** Gateway-computed route, tool transport and token evidence for this send. */
  readonly execution?: BridgeExecutionPreflight;
  readonly observed: ModelUiObservation;
  readonly confidence: "UI_VERIFIED" | "EFFORT_VERIFIED" | "REJECTED";
  readonly backendIdentity: "NOT_OBSERVED";
  readonly phase: "before-submit" | "completed" | "failed";
  readonly checkedAt: string;
}
