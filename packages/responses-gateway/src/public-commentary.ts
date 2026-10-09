import { createHash } from "node:crypto";

/** Completed public assistant commentary, never an analysis or tool message. */
export interface BridgePublicCommentary {
  readonly messageId: string;
  readonly text: string;
}

export function publicCommentaryOutputId(
  turnId: string,
  messageId: string,
): string {
  return `msg_bridge_commentary_${createHash("sha256")
    .update(`${turnId}\0${messageId}`)
    .digest("hex")}`;
}
