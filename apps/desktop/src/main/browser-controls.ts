export type BrowserZoomAction = "in" | "out" | "reset";

const MIN_ZOOM_FACTOR = 0.5;
const MAX_ZOOM_FACTOR = 2;
const ZOOM_STEP = 0.1;

export function nextBrowserZoomFactor(
  current: number,
  action: BrowserZoomAction,
): number {
  if (action === "reset") return 1;
  const candidate = current + (action === "in" ? ZOOM_STEP : -ZOOM_STEP);
  return Math.min(
    MAX_ZOOM_FACTOR,
    Math.max(MIN_ZOOM_FACTOR, Math.round(candidate * 10) / 10),
  );
}

export function browserZoomPercent(factor: number): number {
  return Math.round(factor * 100);
}
