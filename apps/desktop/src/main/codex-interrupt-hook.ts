import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";

export const MANAGED_INTERRUPT_HOOK_START =
  "# >>> CodexGPT Bridge managed Interrupt hook";
export const MANAGED_INTERRUPT_HOOK_END =
  "# <<< CodexGPT Bridge managed Interrupt hook";

export interface InstalledCodexInterruptHook {
  readonly command: string;
  readonly groupIndex: number;
  readonly stateKey: string;
  readonly trustedHash: string;
  readonly fragment: string;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  );
}

/** Matches Codex's trusted command-hook identity for one Interrupt hook. */
export function codexInterruptHookHash(command: string): string {
  const identity = canonicalJson({
    event_name: "interrupt",
    hooks: [{ type: "command", command, timeout: 3, async: false }],
  });
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")}`;
}

function posixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function cmdShellArgument(value: string): string {
  if (value.includes('"') || /[\r\n]/u.test(value)) {
    throw new Error("Interrupt hook command contains an invalid Windows path.");
  }
  return `"${value}"`;
}

export function codexInterruptHookCommand(options: {
  readonly executablePath: string;
  readonly hookScriptPath: string;
  readonly metadataPath: string;
  readonly platform?: NodeJS.Platform;
}): string {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const args = [
    pathApi.resolve(options.executablePath),
    pathApi.resolve(options.hookScriptPath),
    pathApi.resolve(options.metadataPath),
  ];
  const command = args
    .map(platform === "win32" ? cmdShellArgument : posixShellArgument)
    .join(" ");
  return platform === "win32"
    ? `set "ELECTRON_RUN_AS_NODE=1" && ${command}`
    : `ELECTRON_RUN_AS_NODE=1 ${command}`;
}

function lineEnding(text: string): "\r\n" | "\n" | "\r" {
  return text.includes("\r\n")
    ? "\r\n"
    : text.includes("\n")
      ? "\n"
      : text.includes("\r")
        ? "\r"
        : "\n";
}

function interruptGroupCount(text: string): number {
  return text
    .split(/\r\n|\n|\r/u)
    .filter((line) => /^\s*\[\[hooks\.Interrupt\]\]\s*(?:#.*)?$/u.test(line))
    .length;
}

function markerCount(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

function canonicalConfigPath(configPath: string): string {
  const absolute = resolve(configPath);
  try {
    return realpathSync.native(absolute);
  } catch {
    try {
      return join(realpathSync.native(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

export function installCodexInterruptHook(
  text: string,
  configPath: string,
  command: string,
): { readonly text: string; readonly installed: InstalledCodexInterruptHook } {
  if (
    markerCount(text, MANAGED_INTERRUPT_HOOK_START) !== 0 ||
    markerCount(text, MANAGED_INTERRUPT_HOOK_END) !== 0
  ) {
    throw new Error(
      "Codex config already contains a CodexGPT Bridge Interrupt hook marker.",
    );
  }
  const groupIndex = interruptGroupCount(text);
  const stateKey = `${canonicalConfigPath(configPath)}:interrupt:${groupIndex}:0`;
  const trustedHash = codexInterruptHookHash(command);
  const ending = lineEnding(text);
  const core = [
    MANAGED_INTERRUPT_HOOK_START,
    "[[hooks.Interrupt]]",
    "",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    "timeout = 3",
    "",
    `[hooks.state.${JSON.stringify(stateKey)}]`,
    `trusted_hash = ${JSON.stringify(trustedHash)}`,
    MANAGED_INTERRUPT_HOOK_END,
  ].join(ending);
  const leading =
    text.length === 0
      ? ""
      : text.endsWith(`${ending}${ending}`)
        ? ""
        : text.endsWith(ending)
          ? ending
          : `${ending}${ending}`;
  const trailing = text.length > 0 && text.endsWith(ending) ? ending : "";
  const fragment = `${leading}${core}${trailing}`;
  return {
    text: `${text}${fragment}`,
    installed: { command, groupIndex, stateKey, trustedHash, fragment },
  };
}

function locateOwnedHook(
  text: string,
  installed: InstalledCodexInterruptHook,
): { readonly start: number; readonly end: number } {
  if (codexInterruptHookHash(installed.command) !== installed.trustedHash) {
    throw new Error("Stored Codex Interrupt hook hash is invalid.");
  }
  if (
    markerCount(text, MANAGED_INTERRUPT_HOOK_START) !== 1 ||
    markerCount(text, MANAGED_INTERRUPT_HOOK_END) !== 1
  ) {
    throw new Error(
      "Codex Interrupt hook ownership changed after setup; refusing to overwrite it.",
    );
  }
  const markerStart = text.indexOf(MANAGED_INTERRUPT_HOOK_START);
  const markerEnd = text.indexOf(MANAGED_INTERRUPT_HOOK_END);
  const coreEnd = markerEnd + MANAGED_INTERRUPT_HOOK_END.length;
  const groupIndex = interruptGroupCount(text.slice(0, markerStart));
  const stateSuffix = `:interrupt:${installed.groupIndex}:0`;
  if (!installed.stateKey.endsWith(stateSuffix)) {
    throw new Error("Stored Codex Interrupt hook state key is invalid.");
  }
  const stateKey = `${installed.stateKey.slice(0, -stateSuffix.length)}:interrupt:${groupIndex}:0`;
  const stateHeader = `[hooks.state.${JSON.stringify(installed.stateKey)}]`;
  const normalize = (value: string): string =>
    value.replace(/\r\n|\r/gu, "\n").replace(/^\n+|\n+$/gu, "");
  const expected = normalize(installed.fragment).replace(
    stateHeader,
    `[hooks.state.${JSON.stringify(stateKey)}]`,
  );
  // Another integration may move the complete hook and rebase its trust key.
  // Accept only that change and line endings; command, hash and fields stay exact.
  if (
    markerEnd <= markerStart ||
    (markerStart > 0 && !/[\r\n]/u.test(text[markerStart - 1]!)) ||
    normalize(text.slice(markerStart, coreEnd)) !== expected
  ) {
    throw new Error(
      "Codex Interrupt hook changed after setup; refusing to overwrite it.",
    );
  }
  const exactStart = text.indexOf(installed.fragment);
  if (groupIndex === installed.groupIndex && exactStart !== -1) {
    return { start: exactStart, end: exactStart + installed.fragment.length };
  }
  const leadingCount =
    installed.fragment.match(/^(?:\r\n|\n|\r)*/u)![0].match(/\r\n|\n|\r/gu)
      ?.length ?? 0;
  const trailingCount =
    installed.fragment.match(/(?:\r\n|\n|\r)*$/u)![0].match(/\r\n|\n|\r/gu)
      ?.length ?? 0;
  const leadingRun = /(?:\r\n|\n|\r)*$/u.exec(text.slice(0, markerStart))![0];
  const removableLeading = Math.min(
    leadingCount,
    Math.max(0, (leadingRun.match(/\r\n|\n|\r/gu)?.length ?? 0) - 1),
  );
  const leading = new RegExp(
    `(?:\\r\\n|\\n|\\r){0,${removableLeading}}$`,
    "u",
  ).exec(text.slice(0, markerStart))![0];
  const trailing = new RegExp(
    `^(?:\\r\\n|\\n|\\r){0,${trailingCount}}`,
    "u",
  ).exec(text.slice(coreEnd))![0];
  return {
    start: markerStart - leading.length,
    end: coreEnd + trailing.length,
  };
}

export function verifyCodexInterruptHook(
  text: string,
  installed: InstalledCodexInterruptHook,
): void {
  locateOwnedHook(text, installed);
}

/** Update the owned hook in place so later user hooks retain their trust indices. */
export function reinstallCodexInterruptHook(
  text: string,
  configPath: string,
  command: string,
  installed: InstalledCodexInterruptHook,
): ReturnType<typeof installCodexInterruptHook> {
  const range = locateOwnedHook(text, installed);
  const replacement = installCodexInterruptHook(
    text.slice(0, range.start),
    configPath,
    command,
  );
  const suffix = text.slice(range.end);
  const separator =
    suffix.length > 0 &&
    !/[\r\n]$/u.test(replacement.text) &&
    !/^[\r\n]/u.test(suffix)
      ? lineEnding(text)
      : "";
  return { ...replacement, text: replacement.text + separator + suffix };
}

export function isCodexInterruptHookFullyAbsent(
  text: string,
  installed: InstalledCodexInterruptHook,
): boolean {
  return (
    markerCount(text, MANAGED_INTERRUPT_HOOK_START) === 0 &&
    markerCount(text, MANAGED_INTERRUPT_HOOK_END) === 0 &&
    !text.includes(installed.command) &&
    !text.includes(installed.stateKey) &&
    !text.includes(installed.trustedHash)
  );
}

export function restoreCodexInterruptHook(
  text: string,
  installed: InstalledCodexInterruptHook,
  options: { readonly allowAbsent?: boolean } = {},
): string {
  if (options.allowAbsent && isCodexInterruptHookFullyAbsent(text, installed)) {
    return text;
  }
  const range = locateOwnedHook(text, installed);
  return text.slice(0, range.start) + text.slice(range.end);
}
