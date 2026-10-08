const PEER_DISCONNECT_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_STREAM_WRITE_AFTER_END",
]);

function errorCode(error: unknown): string | undefined {
  let current = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || typeof current !== "object" || seen.has(current)) {
      return undefined;
    }
    seen.add(current);
    if (
      "code" in current &&
      typeof (current as { code?: unknown }).code === "string"
    ) {
      return (current as { code: string }).code;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

export function isExpectedPeerDisconnect(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && PEER_DISCONNECT_CODES.has(code);
}

export function installMainProcessErrorBoundary(options: {
  readonly onPeerDisconnect: (error: unknown) => void;
  readonly onUnexpectedError: (error: unknown) => void;
}): () => void {
  const listener = (error: unknown): void => {
    if (isExpectedPeerDisconnect(error)) {
      options.onPeerDisconnect(error);
      return;
    }
    options.onUnexpectedError(error);
  };
  process.on("uncaughtException", listener);
  return () => process.off("uncaughtException", listener);
}
