import type { ContextReceipt } from "./context-sync.js";
import { readFile } from "node:fs/promises";
import { writeDurableJson } from "./durable-json.js";
import {
  normalizeChatGptProjectUrl,
  projectUrlFromConversation,
} from "./chatgpt-projects.js";

const DEFAULT_MAPPING_TTL_MS = 90 * 24 * 60 * 60_000;
const DEFAULT_MAPPING_CAPACITY = 2_000;
const DEFAULT_MAPPING_PRUNE_AT = 1_900;
const DEFAULT_MAPPING_PRUNE_TO = 1_800;

interface ConversationState {
  readonly urls: Map<string, string>;
  readonly receipts: Map<string, ContextReceipt>;
  readonly projects: Map<string, string>;
  readonly temporary: Map<string, boolean>;
  readonly accessed: Map<string, number>;
}

export interface ChatGptConversationOptions {
  readonly now?: () => number;
  readonly mappingTtlMs?: number;
  readonly mappingCapacity?: number;
  readonly mappingPruneAt?: number;
  readonly mappingPruneTo?: number;
}

/** The browser queue owns this store; callers must serialize mutations. No messages or credentials are stored. */
export class ChatGptConversations {
  #loaded = false;
  #loading: Promise<void> | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  readonly #receipts = new Map<string, ContextReceipt>();
  readonly #urls = new Map<string, string>();
  readonly #projects = new Map<string, string>();
  readonly #temporary = new Map<string, boolean>();
  readonly #accessed = new Map<string, number>();
  readonly #now: () => number;
  readonly #mappingTtlMs: number;
  readonly #mappingCapacity: number;
  readonly #mappingPruneAt: number;
  readonly #mappingPruneTo: number;
  constructor(
    private readonly baseUrl: string,
    private readonly file?: string,
    options: ChatGptConversationOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#mappingTtlMs = options.mappingTtlMs ?? DEFAULT_MAPPING_TTL_MS;
    this.#mappingCapacity = options.mappingCapacity ?? DEFAULT_MAPPING_CAPACITY;
    this.#mappingPruneAt = options.mappingPruneAt ?? DEFAULT_MAPPING_PRUNE_AT;
    this.#mappingPruneTo = options.mappingPruneTo ?? DEFAULT_MAPPING_PRUNE_TO;
    if (
      !Number.isSafeInteger(this.#mappingTtlMs) ||
      this.#mappingTtlMs <= 0 ||
      !Number.isSafeInteger(this.#mappingCapacity) ||
      this.#mappingCapacity <= 0 ||
      !Number.isSafeInteger(this.#mappingPruneAt) ||
      this.#mappingPruneAt <= 0 ||
      this.#mappingPruneAt > this.#mappingCapacity ||
      !Number.isSafeInteger(this.#mappingPruneTo) ||
      this.#mappingPruneTo < 0 ||
      this.#mappingPruneTo >= this.#mappingPruneAt
    ) {
      throw new Error("Invalid conversation retention configuration.");
    }
  }

  #conversationUrl(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    try {
      const url = new URL(value);
      const base = new URL(this.baseUrl);
      if (
        url.origin !== base.origin ||
        !/^(?:\/g\/g-p-[A-Za-z0-9-]+)?\/c\/[a-zA-Z0-9-]+\/?$/.test(
          url.pathname,
        ) ||
        url.username ||
        url.password
      )
        return undefined;
      return url.origin + url.pathname;
    } catch {
      return undefined;
    }
  }

  #snapshot(): ConversationState {
    return {
      urls: new Map(this.#urls),
      receipts: new Map(this.#receipts),
      projects: new Map(this.#projects),
      temporary: new Map(this.#temporary),
      accessed: new Map(this.#accessed),
    };
  }

  #commit(state: ConversationState): void {
    const replace = <T>(target: Map<string, T>, source: Map<string, T>) => {
      target.clear();
      for (const [key, value] of source) target.set(key, value);
    };
    replace(this.#urls, state.urls);
    replace(this.#receipts, state.receipts);
    replace(this.#projects, state.projects);
    replace(this.#temporary, state.temporary);
    replace(this.#accessed, state.accessed);
  }

  #taskIds(state: ConversationState): Set<string> {
    return new Set([...state.urls.keys(), ...state.temporary.keys()]);
  }

  #deleteTask(state: ConversationState, threadId: string): void {
    state.urls.delete(threadId);
    state.receipts.delete(threadId);
    state.projects.delete(threadId);
    state.temporary.delete(threadId);
    state.accessed.delete(threadId);
  }

  #expire(state: ConversationState, now: number): boolean {
    let changed = false;
    for (const threadId of this.#taskIds(state)) {
      const accessed = state.accessed.get(threadId);
      if (accessed !== undefined && now - accessed >= this.#mappingTtlMs) {
        this.#deleteTask(state, threadId);
        changed = true;
      }
    }
    return changed;
  }

  #pruneForNewTask(state: ConversationState, threadId: string): void {
    const taskIds = this.#taskIds(state);
    if (taskIds.has(threadId) || taskIds.size < this.#mappingPruneAt) return;
    const oldest = [...taskIds].sort(
      (left, right) =>
        (state.accessed.get(left) ?? 0) - (state.accessed.get(right) ?? 0),
    );
    while (taskIds.size > this.#mappingPruneTo) {
      const candidate = oldest.shift();
      if (!candidate) break;
      this.#deleteTask(state, candidate);
      taskIds.delete(candidate);
    }
    if (taskIds.size >= this.#mappingCapacity) {
      throw new Error("Conversation mapping reached its capacity.");
    }
  }

  async #load(): Promise<void> {
    this.#loading ??= this.#loadOnce();
    const loading = this.#loading;
    try {
      await loading;
    } catch (error) {
      // A repaired file must be usable without retaining the rejected load forever.
      if (this.#loading === loading) this.#loading = undefined;
      throw error;
    }
  }

  async #loadOnce(): Promise<void> {
    if (this.#loaded) return;
    if (this.file) {
      try {
        let rewrite = false;
        const raw = await readFile(this.file, "utf8");
        if (raw.length > 32_000_000)
          throw new Error("Conversation mapping file exceeds its size limit.");
        const parsed = JSON.parse(raw) as {
          version?: unknown;
          conversations?: unknown;
          receipts?: Array<[string, ContextReceipt]>;
          projects?: unknown;
          temporary?: unknown;
          accessed?: unknown;
        };
        if (parsed.version !== 1 || !Array.isArray(parsed.conversations))
          throw new Error("Invalid conversation mapping file.");
        if (parsed.temporary !== undefined) {
          if (!Array.isArray(parsed.temporary))
            throw new Error("Invalid task chat modes.");
          for (const entry of parsed.temporary) {
            if (
              !Array.isArray(entry) ||
              entry.length !== 2 ||
              typeof entry[0] !== "string" ||
              !/^[A-Za-z0-9_-]{6,128}$/.test(entry[0]) ||
              typeof entry[1] !== "boolean"
            )
              throw new Error("Invalid task chat mode.");
            this.#temporary.set(entry[0], entry[1]);
          }
        }
        if (Array.isArray(parsed.receipts))
          for (const [key, receipt] of parsed.receipts) {
            if (
              receipt &&
              Array.isArray(receipt.ledger) &&
              receipt.ledger.every(
                (x) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x),
              ) &&
              typeof receipt.instructions === "string" &&
              typeof receipt.contract === "string" &&
              Number.isSafeInteger(receipt.generation)
            )
              this.#receipts.set(key, receipt);
          }
        for (const entry of parsed.conversations) {
          if (
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            typeof entry[0] !== "string" ||
            !/^[A-Za-z0-9_-]{6,128}$/.test(entry[0])
          )
            throw new Error("Invalid conversation mapping entry.");
          const url = this.#conversationUrl(entry[1]);
          if (!url)
            throw new Error(
              "Conversation mapping contains an invalid ChatGPT URL.",
            );
          this.#urls.set(entry[0], url);
          if (this.#temporary.get(entry[0]) === true)
            throw new Error(
              "Temporary task must not retain a conversation URL.",
            );
        }
        if (parsed.projects !== undefined) {
          if (!Array.isArray(parsed.projects))
            throw new Error("Invalid conversation project mappings.");
          for (const entry of parsed.projects) {
            if (
              !Array.isArray(entry) ||
              entry.length !== 2 ||
              typeof entry[0] !== "string" ||
              !this.#urls.has(entry[0])
            )
              throw new Error("Invalid conversation project mapping.");
            this.#projects.set(
              entry[0],
              normalizeChatGptProjectUrl(entry[1], this.baseUrl),
            );
          }
        }
        const persistedAccess = new Map<string, number>();
        if (parsed.accessed === undefined) {
          rewrite = true;
        } else {
          if (!Array.isArray(parsed.accessed))
            throw new Error("Invalid conversation access timestamps.");
          for (const entry of parsed.accessed) {
            if (
              !Array.isArray(entry) ||
              entry.length !== 2 ||
              typeof entry[0] !== "string" ||
              !/^[A-Za-z0-9_-]{6,128}$/.test(entry[0]) ||
              !Number.isSafeInteger(entry[1]) ||
              entry[1] <= 0
            ) {
              throw new Error("Invalid conversation access timestamp.");
            }
            persistedAccess.set(entry[0], entry[1]);
          }
        }
        const now = this.#now();
        for (const threadId of this.#taskIds(this.#snapshot())) {
          const accessed = persistedAccess.get(threadId);
          this.#accessed.set(threadId, accessed ?? now);
          if (accessed === undefined) rewrite = true;
        }
        if (persistedAccess.size !== this.#accessed.size) rewrite = true;
        const state = this.#snapshot();
        if (this.#expire(state, now)) rewrite = true;
        this.#commit(state);
        if (rewrite) await this.#persist(state);
      } catch (error) {
        this.#urls.clear();
        this.#projects.clear();
        this.#receipts.clear();
        this.#temporary.clear();
        this.#accessed.clear();
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
    }
    this.#loaded = true;
  }

  async get(threadId: string): Promise<string | undefined> {
    const pending = this.#tail
      .catch(() => undefined)
      .then(async () => {
        await this.#load();
        const state = this.#snapshot();
        const now = this.#now();
        const expired = this.#expire(state, now);
        const url = state.urls.get(threadId);
        if (url) state.accessed.set(threadId, now);
        if (expired || url) {
          await this.#persist(state);
          this.#commit(state);
        }
        return url;
      });
    this.#tail = pending;
    return pending;
  }

  /** Pin the first requested mode; old URL mappings are always standard chats. */
  async selectTemporaryMode(
    threadId: string | undefined,
    requested: boolean,
  ): Promise<boolean> {
    if (!threadId) return requested;
    const pending = this.#tail
      .catch(() => undefined)
      .then(async () => {
        await this.#load();
        if (!/^[A-Za-z0-9_-]{6,128}$/.test(threadId))
          throw new Error("Invalid Codex task identity.");
        const state = this.#snapshot();
        const now = this.#now();
        this.#expire(state, now);
        const hasConversation = state.urls.has(threadId);
        const existing = state.temporary.get(threadId);
        const selected = hasConversation ? false : (existing ?? requested);
        if (!hasConversation && existing === undefined) {
          this.#pruneForNewTask(state, threadId);
          state.temporary.set(threadId, selected);
        }
        state.accessed.set(threadId, now);
        await this.#persist(state);
        this.#commit(state);
        return selected;
      });
    this.#tail = pending;
    return pending;
  }

  async #persist(state: ConversationState): Promise<void> {
    if (!this.file) return;
    await writeDurableJson(
      this.file,
      JSON.stringify({
        version: 1,
        conversations: [...state.urls],
        receipts: [...state.receipts],
        projects: [...state.projects],
        temporary: [...state.temporary],
        accessed: [...state.accessed],
      }),
    );
  }

  async receipt(threadId: string): Promise<ContextReceipt | undefined> {
    await this.get(threadId);
    return this.#receipts.get(threadId);
  }

  async projectUrl(threadId: string): Promise<string | undefined> {
    const url = await this.get(threadId);
    return (
      this.#projects.get(threadId) ??
      (url ? projectUrlFromConversation(url, this.baseUrl) : undefined)
    );
  }

  async remember(
    threadId: string,
    value: string,
    receipt?: ContextReceipt,
    projectUrl?: string,
  ): Promise<void> {
    const pending = this.#tail
      .catch(() => undefined)
      .then(() => this.#remember(threadId, value, receipt, projectUrl));
    this.#tail = pending;
    return pending;
  }

  async #remember(
    threadId: string,
    value: string,
    receipt?: ContextReceipt,
    projectUrl?: string,
  ): Promise<void> {
    await this.#load();
    const url = this.#conversationUrl(value);
    if (!url) return;
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(threadId))
      throw new Error("Invalid Codex task identity.");
    const state = this.#snapshot();
    const now = this.#now();
    this.#expire(state, now);
    if (state.temporary.get(threadId)) {
      await this.#persist(state);
      this.#commit(state);
      return;
    }
    const project = projectUrl
      ? normalizeChatGptProjectUrl(projectUrl, this.baseUrl)
      : undefined;
    this.#pruneForNewTask(state, threadId);
    state.urls.set(threadId, url);
    if (project) state.projects.set(threadId, project);
    else state.projects.delete(threadId);
    if (receipt) state.receipts.set(threadId, receipt);
    state.accessed.set(threadId, now);
    await this.#persist(state);
    this.#commit(state);
  }
}
