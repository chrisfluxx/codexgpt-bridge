import type { DesktopApi } from "../main/preload.cjs";

declare global {
  interface Window {
    readonly codexgptBridge: DesktopApi;
  }
}

export {};
