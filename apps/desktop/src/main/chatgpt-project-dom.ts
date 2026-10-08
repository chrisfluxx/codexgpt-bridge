export type ProjectAction =
  "inspect" | "search" | "open" | "new" | "fill" | "create" | "destination";
export interface ProjectSurface {
  ready: boolean;
  searchAccepted: boolean;
  nameAccepted: boolean;
  signature: string;
  searchStatus: string;
  matches: number;
  empty: boolean;
  clicked: boolean;
  destination: boolean;
  error: string;
}

/** Uses only the rendered Projects UI, not private APIs or framework internals. */
export function chatGptProjectAction(
  action: ProjectAction,
  name: string,
): ProjectSurface {
  const visible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      el.isConnected &&
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  };
  const text = (el: Element): string =>
    (el instanceof HTMLElement ? el.innerText : (el.textContent ?? "")).trim();
  const result: ProjectSurface = {
    ready: false,
    searchAccepted: false,
    nameAccepted: false,
    signature: "",
    searchStatus: "",
    matches: 0,
    empty: false,
    clicked: false,
    destination: false,
    error: "",
  };
  const alerts = [...document.querySelectorAll('[role="alert"]')]
    .filter(visible)
    .map(text)
    .filter(Boolean);
  if (alerts.length) {
    result.error = alerts.join(" | ");
    return result;
  }
  const main = document.querySelector("main");
  if (!main) return result;
  const input = [
    ...main.querySelectorAll<HTMLInputElement>(
      "#projects-page-search, #projects-index-search",
    ),
  ].find(visible);
  const busy = [
    ...main.querySelectorAll('[aria-busy="true"], [role="progressbar"]'),
  ].some(visible);
  const rows = [
    ...main.querySelectorAll<HTMLElement>(
      '[role="row"][data-page-table-selectable-row], [data-project-row="true"]',
    ),
  ].filter(visible);
  const matches = rows.filter((row) => {
    const cell = row.querySelector('[role="gridcell"], span.truncate');
    return (
      cell &&
      [cell, ...cell.querySelectorAll("div, span")].some(
        (el) => visible(el) && text(el) === name,
      )
    );
  });
  result.matches = matches.length;
  const rowTexts = rows.map((row) =>
    text(row.querySelector('[role="gridcell"], span.truncate') ?? row),
  );
  result.empty = [...main.querySelectorAll("p, div, span")].some(
    (el) =>
      visible(el) &&
      /^(No matching projects|No projects yet|No projects|找不到相符的專案|沒有相符的專案|沒有符合的專案|尚無專案|沒有專案|没有匹配的项目|暂无项目|没有项目)$/.test(
        text(el),
      ),
  );
  // A changed DOM value alone is not an acknowledged controlled-input update.
  // React renders the value attribute after consuming the browser input event.
  result.searchAccepted =
    !!input &&
    visible(input) &&
    input.value === name &&
    input.getAttribute("value") === name;
  result.signature = JSON.stringify([rowTexts, result.empty]);
  // Keep failure evidence limited to the Projects surface, not sidebar chat history.
  result.searchStatus = JSON.stringify({
    accepted: result.searchAccepted,
    busy,
    rows: rows.length,
    empty: result.empty,
    page: rows.length === 0 ? text(main).slice(0, 400) : undefined,
  });
  result.ready =
    result.searchAccepted &&
    !busy &&
    rowTexts.every((value) =>
      value.toLocaleLowerCase().includes(name.toLocaleLowerCase()),
    ) &&
    (rows.length > 0 || result.empty);
  result.destination =
    /\/g\/g-p-[A-Za-z0-9-]+\/project\/?$/.test(location.pathname) &&
    [...main.querySelectorAll("h1, h2")].some(
      (el) => visible(el) && text(el) === name,
    );
  const focus = (field: HTMLInputElement): boolean => {
    if (field.disabled || field.readOnly) return false;
    field.focus();
    field.select();
    return document.activeElement === field;
  };
  const clickButton = (root: Element, pattern: RegExp): boolean => {
    const buttons = [
      ...root.querySelectorAll<HTMLButtonElement>("button"),
    ].filter(
      (el) =>
        visible(el) &&
        !el.disabled &&
        el.getAttribute("aria-disabled") !== "true" &&
        pattern.test(text(el)),
    );
    if (buttons.length !== 1) return false;
    buttons[0]!.click();
    return true;
  };
  if (action === "search" && input && visible(input)) {
    result.clicked = focus(input);
  }
  if (action === "open" && result.ready && matches.length === 1) {
    const row = matches[0]!;
    if (row.getAttribute("data-project-row") === "true") {
      // Index rows expand their chat list. Only the new-chat button opens the
      // Project landing page; clicking the row would wait forever at /projects.
      const buttons = [
        ...row.querySelectorAll<HTMLButtonElement>("button"),
      ].filter(
        (button) =>
          visible(button) &&
          !button.disabled &&
          button.getAttribute("aria-disabled") !== "true" &&
          /^(Start new chat in project|在專案中開始新對話|在專案中開始新聊天|在專案中開啟新對話|在项目中开始新聊天)$/.test(
            button.getAttribute("aria-label") ?? text(button),
          ),
      );
      if (buttons.length === 1) {
        buttons[0]!.click();
        result.clicked = true;
      }
    } else {
      row.click();
      result.clicked = true;
    }
  }
  // Only an explicit empty state proves absence. Partial matches, loading or UI drift cannot create duplicates.
  if (action === "new" && result.ready && result.empty && matches.length === 0)
    result.clicked = clickButton(
      main,
      /^(New|New project|Create|新增|新增專案|建立|建立專案|新建|新建项目|创建|创建项目)$/,
    );
  const projectName = [
    ...document.querySelectorAll<HTMLInputElement>(
      "#project-name, #chatgpt-project-name",
    ),
  ].find(visible);
  const dialog = projectName?.closest('dialog[open], [role="dialog"]');
  result.nameAccepted =
    !!projectName &&
    !!dialog &&
    visible(projectName) &&
    projectName.value === name &&
    projectName.getAttribute("value") === name;
  if (action === "fill" && projectName && visible(projectName) && dialog) {
    result.clicked = focus(projectName);
  }
  if (action === "create" && result.nameAccepted && dialog)
    result.clicked = clickButton(
      dialog,
      /^(Create project|建立專案|创建项目)$/,
    );
  return result;
}
