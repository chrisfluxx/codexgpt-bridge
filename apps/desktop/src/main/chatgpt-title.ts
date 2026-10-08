import type { ChatGptWindow } from "./chatgpt-window.js";
import { delay } from "./browser-delay.js";
import {
  chatGptTitleAction,
  type TitleAction,
  type TitleSurface,
} from "./chatgpt-title-dom.js";

/** Best-effort caller: failure must not change delivery of an already completed answer. */
export async function syncChatGptTitle(
  window: ChatGptWindow,
  conversationUrl: string,
  title: string,
  signal: AbortSignal,
  onStage?: (stage: string) => void,
): Promise<void> {
  title = title.trim();
  if (!title.trim()) return;
  if (
    title.length > 128 ||
    [...title].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new Error("ChatGPT 標題最多 128 字元且不可含控制字元；名稱未變更。");
  const url = new URL(conversationUrl);
  const chatId = url.pathname.match(/\/c\/([A-Za-z0-9-]+)\/?$/)?.[1];
  if (!chatId) throw new Error("找不到此任務的 ChatGPT 對話，名稱未變更。");
  let bounded = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
  let editing = false;
  let opened = false;
  let step = "inspect";
  const enter = (stage: string): void => {
    step = stage;
    onStage?.(stage);
  };
  let lastState: TitleSurface | undefined;
  const act = async (action: TitleAction): Promise<TitleSurface> => {
    bounded.throwIfAborted();
    if (
      window.isDestroyed() ||
      new URL(window.webContents.getURL()).origin !== url.origin
    )
      throw new Error("ChatGPT 對話頁已變更，名稱未同步。");
    const result = (await window.webContents.executeJavaScript(
      `(${chatGptTitleAction.toString()})(${JSON.stringify(action)},${JSON.stringify(chatId)},${JSON.stringify(title)})`,
      true,
    )) as TitleSurface;
    lastState = result;
    if (!result.target || result.error)
      throw new Error(result.error ?? "ChatGPT 對話 ID 已變更，名稱未同步。");
    return result;
  };
  const wait = async (
    action: TitleAction,
    accept: (state: TitleSurface) => boolean,
  ): Promise<TitleSurface> => {
    for (;;) {
      const state = await act(action);
      if (accept(state)) return state;
      await delay(100, bounded);
    }
  };
  const key = (keyCode: string): void => {
    bounded.throwIfAborted();
    window.webContents.sendInputEvent({ type: "keyDown", keyCode });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode });
  };
  try {
    enter("inspect");
    const initial = await act("inspect");
    if (initial.title === title) return;
    if (initial.editor) throw new Error("ChatGPT 已在編輯標題，略過自動改名。");
    enter("menu");
    const menu = await wait("menu", (state) => state.activated);
    opened = true;
    if (!menu.menuOpen) key("ENTER");
    enter("rename");
    await wait("rename", (state) => state.activated);
    editing = true;
    enter("editor");
    const field = await wait("focus", (state) => state.activated);
    if (field.value === title) {
      key("ESCAPE");
      editing = false;
      return;
    }
    key("BACKSPACE");
    enter("clear");
    await wait("inspect", (state) => {
      if (!state.editor || !state.focused)
        throw new Error("ChatGPT 標題輸入焦點已改變，沒有送出改名。");
      return state.cleared;
    });
    await window.webContents.insertText(title);
    enter("input");
    await wait("inspect", (state) => {
      if (!state.editor || !state.focused)
        throw new Error("ChatGPT 標題輸入焦點已改變，沒有送出改名。");
      return state.accepted;
    });
    enter("save");
    const submitted = await wait("save", (state) => state.activated);
    if (submitted.submitWithEnter) key("ENTER");
    // Saving waits on the server and sidebar updates, independently of the
    // time already spent opening the menu and entering the title.
    bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    enter("saved");
    await wait("inspect", (state) => !state.editor && state.title === title);
    editing = false;
    await delay(300, bounded);
    if ((await act("inspect")).title !== title)
      throw new Error("ChatGPT 尚未保存新名稱。");
  } catch (error) {
    throw new Error(
      `對話改名未完成（${step}；選單=${!!lastState?.menuOpen}、編輯框=${!!lastState?.editor}、輸入確認=${!!lastState?.accepted}）：${error instanceof Error ? error.message : "unknown error"}`,
      { cause: error },
    );
  } finally {
    if ((editing || opened) && !window.isDestroyed()) {
      // Escape never submits a prompt. Only close this chat's menu/editor.
      const cleanup = (await window.webContents
        .executeJavaScript(
          `(${chatGptTitleAction.toString()})("inspect",${JSON.stringify(chatId)},${JSON.stringify(title)})`,
          true,
        )
        .catch(() => undefined)) as TitleSurface | undefined;
      if (
        cleanup?.target &&
        (cleanup.menuOpen || (cleanup.editor && cleanup.focused))
      ) {
        window.webContents.sendInputEvent({
          type: "keyDown",
          keyCode: "ESCAPE",
        });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "ESCAPE" });
      }
    }
  }
}
