import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CODEXGPT_BRIDGE_ALL_WEB_MODEL_IDS } from "@codexgpt-bridge/responses-gateway";
import {
  installCodexInterruptHook,
  restoreCodexInterruptHook,
  verifyCodexInterruptHook,
  type InstalledCodexInterruptHook,
} from "./codex-interrupt-hook.js";

export const WEB_ONLY_PROVIDER = "codexgpt_bridge_web";
const START = "# >>> CodexGPT Bridge Web-only settings";
const END = "# <<< CodexGPT Bridge Web-only settings";
const TABLE_START = "# >>> CodexGPT Bridge Web-only connection";
const TABLE_END = "# <<< CodexGPT Bridge Web-only connection";
const KEYS = new Set([
  "model",
  "model_provider",
  "model_catalog_json",
  "model_reasoning_effort",
  "service_tier",
  "profile",
]);

interface SavedAssignment {
  readonly marker: string;
  readonly original: string;
}
export interface WebOnlyPlan {
  readonly header: string;
  readonly footer: string;
  readonly saved: readonly SavedAssignment[];
  readonly beforeHash: string;
  readonly installed: string;
}
interface JournalV1 {
  readonly version: 1;
  readonly configPath: string;
  readonly createdConfig: boolean;
  readonly catalogHash: string;
  readonly plan: WebOnlyPlan;
}
interface JournalV2 {
  readonly version: 2;
  readonly configPath: string;
  readonly createdConfig: boolean;
  readonly catalogHash: string;
  readonly plan: WebOnlyPlan;
  readonly interruptHook: InstalledCodexInterruptHook;
}
type Journal = JournalV1 | JournalV2;

const hash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/** Keep original assignments in place as markers, so unrelated config edits can survive restoration. */
export function planWebOnlyConfig(
  text: string,
  baseUrl: string,
  catalogPath: string,
  token: string,
): WebOnlyPlan {
  const url = new URL(baseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/web/v1" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("Web-only mode requires the local Bridge Web endpoint.");
  }
  if (
    text.includes(START) ||
    text.includes(TABLE_START) ||
    text.includes(WEB_ONLY_PROVIDER)
  ) {
    throw new Error(
      "Codex already contains Web-only settings; restore the previous mode first.",
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(token))
    throw new Error("Invalid local Web provider credential.");
  const ending = text.includes("\r\n") ? "\r\n" : "\n";
  const firstTable = text.search(/^[\t ]*\[/mu);
  const top = firstTable < 0 ? text : text.slice(0, firstTable);
  // Never mistake a table-looking line in a multiline value for an actual TOML table.
  if (/"""|'''/u.test(top))
    throw new Error(
      "Multiline top-level TOML needs manual provider configuration.",
    );
  const saved: SavedAssignment[] = [];
  const seen = new Set<string>();
  const replaced = top.replace(/[^\r\n]+(?:\r\n|\n|$)/gu, (line) => {
    const assignment = /^[\t ]*(?:([\w-]+)|"([\w-]+)"|'([\w-]+)')[\t ]*=/u.exec(
      line,
    );
    const key = assignment?.[1] ?? assignment?.[2] ?? assignment?.[3];
    if (!key || !KEYS.has(key)) return line;
    if (seen.has(key))
      throw new Error(`Duplicate ${key} prevents Web-only setup.`);
    seen.add(key);
    if (
      !/=[\t ]*(?:"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')[\t ]*(?:#[^\r\n]*)?(?:\r?\n)?$/u.test(
        line,
      )
    ) {
      throw new Error(
        `Unsupported ${key} assignment; Web-only setup left settings unchanged.`,
      );
    }
    const marker = `# CodexGPT Bridge saved ${key}${ending}`;
    saved.push({ marker, original: line });
    return marker;
  });
  const header = [
    START,
    'model = "codexgpt-bridge/high"',
    `model_provider = "${WEB_ONLY_PROVIDER}"`,
    'model_reasoning_effort = "high"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    END,
    "",
  ].join(ending);
  const connection = [
    TABLE_START,
    `[model_providers.${WEB_ONLY_PROVIDER}]`,
    'name = "CodexGPT Bridge Web"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    `experimental_bearer_token = ${JSON.stringify(token)}`,
    "supports_websockets = true",
    TABLE_END,
    "",
  ].join(ending);
  // Preserve the exact original final newline, including an originally absent newline.
  const body = replaced + (firstTable < 0 ? "" : text.slice(firstTable));
  const footer = (body.endsWith("\n") ? ending : ending + ending) + connection;
  return {
    header,
    footer,
    saved,
    beforeHash: hash(text),
    installed: header + body + footer,
  };
}

function replaceOnce(
  text: string,
  needle: string,
  replacement: string,
): string {
  const offset = text.indexOf(needle);
  if (offset < 0 || text.indexOf(needle, offset + needle.length) >= 0) {
    throw new Error(
      "Web-only settings changed after setup; refusing to overwrite newer settings.",
    );
  }
  return (
    text.slice(0, offset) + replacement + text.slice(offset + needle.length)
  );
}

export function restoreWebOnlyConfig(text: string, plan: WebOnlyPlan): string {
  // Codex may persist another selected Web mode. Accept only that normal interaction.
  const start = text.indexOf(START);
  const end = text.indexOf(END, start);
  if (start < 0 || end < 0) throw new Error("Web-only settings are missing.");
  const ending = plan.header.includes("\r\n") ? "\r\n" : "\n";
  const currentHeader = text.slice(start, end + END.length + ending.length);
  const normalized = currentHeader
    .replace(/^model = "([^"]+)"$/mu, (line, model: string) => {
      if (!CODEXGPT_BRIDGE_ALL_WEB_MODEL_IDS.includes(model)) return line;
      return 'model = "codexgpt-bridge/high"';
    })
    .replace(
      /^model_reasoning_effort = "(low|medium|high|xhigh|ultra)"$/mu,
      'model_reasoning_effort = "high"',
    );
  if (normalized !== plan.header)
    throw new Error(
      "Web-only model settings were modified; restore cannot overwrite them.",
    );
  let restored = replaceOnce(text, currentHeader, "");
  restored = replaceOnce(restored, plan.footer, "");
  for (const entry of plan.saved)
    restored = replaceOnce(restored, entry.marker, entry.original);
  return restored;
}

async function read(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class WebOnlyIntegration {
  readonly configPath: string;
  readonly catalogPath: string;
  readonly #journalPath: string;
  readonly #tokenPath: string;
  readonly #interruptHookCommand: string | undefined;
  #tokenPromise?: Promise<string>;
  constructor(
    codexHome: string,
    userData: string,
    interruptHookCommand?: string,
  ) {
    this.configPath = join(codexHome, "config.toml");
    this.catalogPath = join(codexHome, "codexgpt-bridge-web-only-models.json");
    this.#journalPath = join(userData, "web-only-integration.json");
    this.#tokenPath = join(userData, "web-only-token");
    this.#interruptHookCommand = interruptHookCommand;
  }
  token(): Promise<string> {
    return (this.#tokenPromise ??= (async () => {
      const existing = await read(this.#tokenPath);
      if (existing !== undefined) {
        if (!/^[a-f0-9]{64}$/u.test(existing))
          throw new Error("Local Web provider credential is invalid.");
        return existing;
      }
      const token = randomBytes(32).toString("hex");
      await atomicWrite(this.#tokenPath, token);
      return token;
    })());
  }
  async #journal(): Promise<Journal | undefined> {
    const text = await read(this.#journalPath);
    if (!text) return undefined;
    const value = JSON.parse(text) as Journal;
    if (
      (value.version !== 1 && value.version !== 2) ||
      value.configPath !== this.configPath ||
      typeof value.createdConfig !== "boolean" ||
      typeof value.catalogHash !== "string" ||
      typeof value.plan?.header !== "string" ||
      typeof value.plan.footer !== "string" ||
      typeof value.plan.beforeHash !== "string" ||
      typeof value.plan.installed !== "string" ||
      !Array.isArray(value.plan.saved) ||
      !value.plan.saved.every(
        (s) => typeof s.marker === "string" && typeof s.original === "string",
      ) ||
      (value.version === 2 &&
        (typeof value.interruptHook?.command !== "string" ||
          typeof value.interruptHook.fragment !== "string" ||
          typeof value.interruptHook.stateKey !== "string" ||
          typeof value.interruptHook.trustedHash !== "string" ||
          !Number.isInteger(value.interruptHook.groupIndex)))
    ) {
      throw new Error(
        "Web-only ownership journal is invalid or belongs to a different Codex home.",
      );
    }
    return value;
  }
  async status(): Promise<{
    enabled: boolean;
    managed: boolean;
    error?: string;
  }> {
    const journal = await this.#journal();
    if (!journal) return { enabled: false, managed: false };
    try {
      const config = (await read(this.configPath)) ?? "";
      const withoutHook =
        journal.version === 2
          ? restoreCodexInterruptHook(config, journal.interruptHook)
          : config;
      restoreWebOnlyConfig(withoutHook, journal.plan);
      if (hash((await read(this.catalogPath)) ?? "") !== journal.catalogHash)
        throw new Error("Web-only model catalog changed after setup.");
      return { enabled: true, managed: true };
    } catch (error) {
      return {
        enabled: false,
        managed: true,
        error:
          error instanceof Error
            ? error.message
            : "Web-only setup needs attention.",
      };
    }
  }
  async models(): Promise<unknown> {
    const journal = await this.#journal();
    const text = await read(this.catalogPath);
    if (!journal || !text || hash(text) !== journal.catalogHash)
      throw new Error("Web-only model catalog is unavailable.");
    return JSON.parse(text) as unknown;
  }
  /** Refresh only the exact owned snapshot; configuration and credentials stay intact. */
  async refreshModels(
    compile: (models: unknown) => unknown | Promise<unknown>,
  ): Promise<boolean> {
    const journal = await this.#journal();
    if (!journal || !(await this.status()).enabled) return false;
    const before = await read(this.catalogPath);
    const beforeJournal = await read(this.#journalPath);
    const beforeConfig = await read(this.configPath);
    if (!before || hash(before) !== journal.catalogHash) return false;
    const text =
      JSON.stringify(await compile(JSON.parse(before)), null, 2) + "\n";
    if (text === before) return false;
    if (
      (await read(this.catalogPath)) !== before ||
      (await read(this.#journalPath)) !== beforeJournal ||
      (await read(this.configPath)) !== beforeConfig
    )
      throw new Error(
        "Web-only setup changed during catalog refresh. No owned snapshot was overwritten.",
      );
    await atomicWrite(this.catalogPath, text);
    try {
      await atomicWrite(
        this.#journalPath,
        JSON.stringify({ ...journal, catalogHash: hash(text) }, null, 2) + "\n",
      );
    } catch (error) {
      if (
        (await read(this.catalogPath)) === text &&
        (await read(this.#journalPath)) === beforeJournal
      )
        await atomicWrite(this.catalogPath, before);
      throw error;
    }
    return true;
  }
  async enable(
    baseUrl: string,
    catalog: unknown,
    existingInterruptHook?: InstalledCodexInterruptHook,
  ): Promise<void> {
    const current = await this.status();
    if (current.enabled) return;
    if (current.managed)
      throw new Error(
        current.error ?? "Restore previous Web-only setup first.",
      );
    const before = await read(this.configPath);
    const plan = planWebOnlyConfig(
      before ?? "",
      baseUrl,
      this.catalogPath,
      await this.token(),
    );
    if (existingInterruptHook) {
      verifyCodexInterruptHook(before ?? "", existingInterruptHook);
    }
    if ((await read(this.catalogPath)) !== undefined)
      throw new Error("An unowned Web-only catalog already exists.");
    const catalogText = JSON.stringify(catalog, null, 2) + "\n";
    const installedHook =
      this.#interruptHookCommand && !existingInterruptHook
        ? installCodexInterruptHook(
            plan.installed,
            this.configPath,
            this.#interruptHookCommand,
          )
        : undefined;
    if ((await read(this.configPath)) !== before)
      throw new Error("Codex settings changed during Web-only setup.");
    // Save recovery information before activating the new configuration.
    await atomicWrite(
      this.#journalPath,
      JSON.stringify(
        {
          ...(installedHook
            ? { version: 2 as const, interruptHook: installedHook.installed }
            : { version: 1 as const }),
          configPath: this.configPath,
          createdConfig: before === undefined,
          catalogHash: hash(catalogText),
          plan,
        } satisfies Journal,
        null,
        2,
      ) + "\n",
    );
    await atomicWrite(this.catalogPath, catalogText);
    if ((await read(this.configPath)) !== before)
      throw new Error(
        "Codex settings changed during Web-only setup. Restore previous mode before retrying.",
      );
    await atomicWrite(this.configPath, installedHook?.text ?? plan.installed);
  }
  async disable(): Promise<void> {
    const journal = await this.#journal();
    if (!journal) return;
    const current = await read(this.configPath);
    // Recover a setup interrupted before activation as well as a normal disable.
    const withoutHook =
      journal.version === 2 && hash(current ?? "") !== journal.plan.beforeHash
        ? restoreCodexInterruptHook(current ?? "", journal.interruptHook)
        : (current ?? "");
    const restored =
      hash(current ?? "") === journal.plan.beforeHash
        ? (current ?? "")
        : restoreWebOnlyConfig(withoutHook, journal.plan);
    if ((await read(this.configPath)) !== current)
      throw new Error("Codex settings changed during restoration.");
    if (restored !== current) {
      if (journal.createdConfig && restored === "")
        await rm(this.configPath, { force: true });
      else await atomicWrite(this.configPath, restored);
    }
    const catalog = await read(this.catalogPath);
    if (catalog !== undefined && hash(catalog) === journal.catalogHash)
      await rm(this.catalogPath, { force: true });
    await rm(this.#journalPath);
  }
}
