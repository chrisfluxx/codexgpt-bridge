export type TitleAction = "inspect" | "menu" | "rename" | "focus" | "save";
export interface TitleSurface {
  target: boolean;
  title?: string;
  editor: boolean;
  value?: string;
  accepted: boolean;
  cleared: boolean;
  focused: boolean;
  activated: boolean;
  menuOpen: boolean;
  submitWithEnter?: boolean;
  error?: string;
}

/** Rendered UI only. Both page URL and menu trigger must belong to the exact chat. */
export function chatGptTitleAction(
  action: TitleAction,
  chatId: string,
  title: string,
): TitleSurface {
  const visible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      !el.closest('[inert], [aria-hidden="true"]')
    );
  };
  const result: TitleSurface = {
    target: false,
    editor: false,
    accepted: false,
    cleared: false,
    focused: false,
    activated: false,
    menuOpen: false,
  };
  if (location.pathname.match(/\/c\/([A-Za-z0-9-]+)\/?$/)?.[1] !== chatId)
    return result;
  result.target = true;
  const alerts = [...document.querySelectorAll<HTMLElement>('[role="alert"]')]
    .filter(visible)
    .map((el) => el.innerText.trim())
    .filter(Boolean);
  if (alerts.length) {
    result.error = "ChatGPT 顯示錯誤，尚未確認對話名稱。";
    return result;
  }
  const links = [
    ...document.querySelectorAll<HTMLAnchorElement>(
      "a[data-sidebar-item][href], a[data-interactive-row-link][href]",
    ),
  ].filter(
    (el) =>
      visible(el) &&
      new URL(el.href, location.href).pathname.match(
        /\/c\/([A-Za-z0-9-]+)\/?$/,
      )?.[1] === chatId,
  );
  const labels = new Set(
    links
      .map((link) =>
        link
          .querySelector<HTMLElement>(
            "[data-thread-title], [data-marquee-text]",
          )
          ?.innerText.trim(),
      )
      .filter((label): label is string => !!label),
  );
  if (labels.size === 1) result.title = [...labels][0]!;
  const legacyTriggers = [
    ...document.querySelectorAll<HTMLButtonElement>(
      "button[data-conversation-options-trigger]",
    ),
  ].filter(
    (el) =>
      visible(el) &&
      el.getAttribute("data-conversation-options-trigger") === chatId &&
      !el.disabled,
  );
  // The new sidebar puts actions beside the link, without a conversation-ID
  // attribute. Only inspect the group containing an exact-ID chat link.
  const rowTriggers = links.flatMap((link) => {
    const row = link.closest('[role="group"]');
    if (!row) return [];
    const chatLinks = [
      ...row.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ].filter((el) =>
      /\/c\/[^/]+\/?$/.test(new URL(el.href, location.href).pathname),
    );
    if (chatLinks.some((el) => !links.includes(el))) return [];
    const buttons = [
      ...row.querySelectorAll<HTMLButtonElement>(
        'button[aria-haspopup="menu"]',
      ),
    ].filter(
      (el) =>
        visible(el) &&
        !el.disabled &&
        el.getAttribute("aria-disabled") !== "true",
    );
    return buttons.length === 1 ? buttons : [];
  });
  const triggers = [...new Set([...legacyTriggers, ...rowTriggers])];
  // Projects and Recents may both render the same chat. Either exact-ID row
  // is valid; retain its open menu when both rows are present.
  const trigger =
    triggers.find(
      (el) =>
        el.getAttribute("aria-expanded") === "true" ||
        el.getAttribute("data-state") === "open",
    ) ??
    triggers.find((el) => el.closest('[aria-current="page"]')) ??
    triggers[0];
  const menu = trigger?.id
    ? [...document.querySelectorAll<HTMLElement>('[role="menu"]')].find(
        (el) =>
          visible(el) && el.getAttribute("aria-labelledby") === trigger.id,
      )
    : undefined;
  result.menuOpen = !!menu;
  const renameDialogs = [
    ...document.querySelectorAll<HTMLElement>('[role="dialog"]'),
  ].filter((el) => {
    if (!visible(el)) return false;
    const labelledBy = el.getAttribute("aria-labelledby");
    const heading = labelledBy
      ? document.getElementById(labelledBy)
      : el.querySelector("h1, h2");
    return (
      !!heading &&
      /^(Rename (?:chat|conversation)|重新命名(?:對話|聊天)?|重命名(?:对话|聊天)?)$/i.test(
        heading.textContent?.trim() ?? "",
      )
    );
  });
  const editors = [
    ...new Set([
      ...document.querySelectorAll<HTMLInputElement>(
        '[data-sidebar-item] input[name="title-editor"]',
      ),
      ...renameDialogs.flatMap((dialog) => [
        ...dialog.querySelectorAll<HTMLInputElement>(
          'input:not([type]), input[type="text"]',
        ),
      ]),
    ]),
  ].filter(visible);
  if (editors.length > 1) {
    result.error = "ChatGPT 有多個標題編輯框，名稱未同步。";
    return result;
  }
  const editor = editors.length === 1 ? editors[0] : undefined;
  if (editor) {
    result.editor = true;
    result.value = editor.value;
    result.accepted =
      editor.value === title && editor.getAttribute("value") === title;
    result.cleared = editor.value === "" && editor.getAttribute("value") === "";
    result.focused = document.activeElement === editor;
  }
  if (action === "menu" && trigger && !editor) {
    if (!menu) {
      trigger.focus();
      result.activated = document.activeElement === trigger;
    } else result.activated = true;
  }
  if (action === "menu" && !trigger && !editor) {
    const toggles = [
      ...document.querySelectorAll<HTMLButtonElement>(
        'button[aria-controls="stage-slideover-sidebar"][aria-expanded="false"], button[aria-label="Toggle sidebar"][aria-expanded="false"]',
      ),
    ].filter(visible);
    if (toggles.length === 1) toggles[0]!.click();
  }
  if (action === "rename" && menu && !editor) {
    const items = [
      ...menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].filter(
      (el) =>
        visible(el) &&
        /^(Rename|重新命名|重新命名對話|重命名)$/.test(el.innerText.trim()) &&
        el.getAttribute("aria-disabled") !== "true",
    );
    if (items.length === 1) {
      items[0]!.click();
      result.activated = true;
    }
  }
  if (action === "focus" && editor && !editor.disabled && !editor.readOnly) {
    editor.focus();
    editor.select();
    result.focused = document.activeElement === editor;
    result.activated = result.focused;
  }
  if (action === "save" && editor) {
    if (!result.focused || !result.accepted) {
      result.error = "ChatGPT 標題輸入焦點或內容已改變，沒有送出改名。";
      return result;
    }
    const dialog = renameDialogs.find((el) => el.contains(editor));
    if (dialog) {
      // The dialog uses normal form submission. Electron keyDown/keyUp alone
      // do not perform Enter's implicit submit; activate this dialog's Save.
      const buttons = [
        ...dialog.querySelectorAll<HTMLButtonElement>("button"),
      ].filter(
        (el) =>
          visible(el) &&
          /^(Save|儲存|保存)$/i.test(
            (el.getAttribute("aria-label") ?? el.innerText).trim(),
          ),
      );
      if (buttons.length !== 1) {
        result.error = "ChatGPT 改名視窗的儲存按鈕不明確，名稱未同步。";
        return result;
      }
      const save = buttons[0]!;
      if (!save.disabled && save.getAttribute("aria-disabled") !== "true") {
        save.click();
        result.activated = true;
      }
    } else {
      // The legacy sidebar editor handles Enter on keydown itself.
      result.submitWithEnter = true;
      result.activated = true;
    }
  }
  return result;
}
