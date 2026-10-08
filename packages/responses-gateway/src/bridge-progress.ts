/** Reserved adapter status messages. Keep them in the client, out of model history. */
export const BRIDGE_PROGRESS_TEXT = {
  working: "Bridge：正在處理請求。",
  queued: "Bridge：等待可用的瀏覽器工作階段。",
  preparing: "Bridge：正在準備 ChatGPT 對話。",
  selecting: "Bridge：正在選擇並驗證模型與推理模式。",
  submitting: "Bridge：模型選項已驗證，正在送出請求。",
  generating: "Bridge：ChatGPT 已接受請求，正在生成回覆。",
  receiving: "Bridge：已收到回覆內容，等待網頁生成完成。",
  validating: "Bridge：網頁生成已結束，正在確認回覆完整性。",
  transferring: "Bridge：正在傳回生成的圖片。",
  repairing: "Bridge：偵測到工具或回覆格式異常，正在自動修正一次。",
  reconnecting: "Bridge：連線恢復，正在接回原本的操作，不會重新送出。",
  waiting_challenge:
    "Bridge：ChatGPT 正在等待 Cloudflare 驗證；已開啟驗證視窗，完成後會安全接續。",
  resuming_challenge:
    "Bridge：Cloudflare 驗證已完成，正在重驗工作階段與頁面狀態，不會重送已接受的請求。",
  recovering_rate_limit:
    "Bridge：冷卻結束，正在恢復先前被限流的操作；已送出的任務可能會追加續接訊息。",
  recovering_connector:
    "Bridge：Full MCP 連接器未提供必要工具，正在改用 Simple 工具協定重試本回合。",
  reusing: "Bridge：沿用同一個 ChatGPT 對話，只同步新增內容。",
  rebuilding: "Bridge：原對話或歷史無法對齊，正在從 Codex 歷史重建。",
  waiting_media: "Bridge：正在等待圖片完成或載入。",
  waiting_web_tool: "Bridge：正在等待網頁工具結束。",
} as const;

export type BridgeProgressStage =
  keyof typeof BRIDGE_PROGRESS_TEXT | `queued_${number}` | `cooldown_${number}`;

/** Routine milestones share one notice; waits and recovery remain actionable. */
export function bridgeProgressDisplayStage(
  stage: BridgeProgressStage,
): BridgeProgressStage {
  switch (stage) {
    case "queued":
    case "preparing":
    case "selecting":
    case "submitting":
    case "generating":
    case "receiving":
    case "validating":
    case "transferring":
    case "reusing":
    case "rebuilding":
    case "waiting_media":
    case "waiting_web_tool":
      return "working";
    default:
      return stage;
  }
}

export function bridgeProgressText(
  stage: BridgeProgressStage,
): string | undefined {
  if (stage in BRIDGE_PROGRESS_TEXT)
    return BRIDGE_PROGRESS_TEXT[stage as keyof typeof BRIDGE_PROGRESS_TEXT];
  const cooldown = /^cooldown_([1-9][0-9]{0,4})$/.exec(stage);
  if (cooldown)
    return `Bridge：ChatGPT 顯示限流，暫停新請求；預計等待 ${cooldown[1]} 秒後再檢查。`;
  const match = /^queued_([1-9][0-9]{0,4})$/.exec(stage);
  return match ? `Bridge：排隊中，前方有 ${match[1]} 個網頁回合。` : undefined;
}

export function isBridgeProgressMessage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (
    (item.type !== undefined && item.type !== "message") ||
    item.role !== "assistant" ||
    item.phase !== "commentary" ||
    !Array.isArray(item.content) ||
    item.content.length !== 1
  )
    return false;
  const part = item.content[0] as Record<string, unknown> | null;
  if (
    !part ||
    part.type !== "output_text" ||
    typeof part.text !== "string" ||
    (part.annotations !== undefined &&
      (!Array.isArray(part.annotations) || part.annotations.length !== 0))
  )
    return false;
  const stage = (
    Object.keys(BRIDGE_PROGRESS_TEXT) as (keyof typeof BRIDGE_PROGRESS_TEXT)[]
  ).find((key) => BRIDGE_PROGRESS_TEXT[key] === part.text);
  const queued =
    /^Bridge：排隊中，前方有 ([1-9][0-9]{0,4}) 個網頁回合(?:；目前一次執行一個)?。$/.exec(
      part.text,
    );
  const cooldown =
    /^Bridge：ChatGPT 顯示限流，暫停新請求；預計等待 ([1-9][0-9]{0,4}) 秒後再檢查。$/.exec(
      part.text,
    );
  const resolvedStage =
    stage ??
    (queued
      ? `queued_${queued[1]}`
      : cooldown
        ? `cooldown_${cooldown[1]}`
        : undefined);
  if (!resolvedStage) return false;
  // Codex can omit output ids when rebuilding input. When retained, require our
  // exact id shape as well as the reserved, single-part commentary body.
  return (
    item.id === undefined ||
    (typeof item.id === "string" &&
      new RegExp(`^msg_[a-zA-Z0-9_-]+_bridge_${resolvedStage}$`).test(item.id))
  );
}
