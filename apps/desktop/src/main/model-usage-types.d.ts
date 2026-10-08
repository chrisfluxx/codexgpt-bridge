export interface LocalBridgeUsageSummary {
  readonly retainedOperations: number;
  readonly completedOperations: number;
  readonly failedOperations: number;
  readonly pendingOperations: number;
  readonly estimatedBrowserInputTokens: number;
  readonly estimatedSourceContextTokens: number;
  readonly byMode: Readonly<
    Record<string, { readonly operations: number; readonly completed: number }>
  >;
  readonly retentionLimit: 200;
  readonly officialQuotaObserved: false;
}
