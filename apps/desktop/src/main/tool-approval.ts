/** Runs on the ChatGPT page. Only the one-time connector approval is eligible. */
export function oneTimeToolApprovalTarget(
  connectorName: string,
): { x: number; y: number } | undefined {
  const labels = new Set([
    "allow",
    "allow once",
    "允許",
    "允许",
    "允許一次",
    "允许一次",
    "許可",
    "今回のみ許可",
    "허용",
    "한 번 허용",
  ]);
  for (const button of document.querySelectorAll<HTMLButtonElement>("button")) {
    if (
      button.disabled ||
      !labels.has(
        (button.innerText || button.getAttribute("aria-label") || "")
          .trim()
          .toLowerCase(),
      )
    )
      continue;
    const card = button.closest(
      '[role="dialog"], [data-testid="tool-approval-card"]',
    );
    if (!card || !connectorName || !card.textContent?.includes(connectorName))
      continue;
    const rect = button.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      getComputedStyle(button).visibility === "hidden"
    )
      continue;
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }
  return undefined;
}
