import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compareReleaseVersions } from "./release-update.js";
import type {
  ReleaseUpdateManager,
  ReleaseUpdateStatus,
} from "./release-update.js";

export class UpdateReminders {
  #timer: ReturnType<typeof setInterval> | undefined;
  #checking: Promise<ReleaseUpdateStatus> | undefined;
  #notified = new Map<string, string>();
  #stopped = false;
  #lastAttempt: { source: string; at: number } | undefined;

  constructor(
    private readonly manager: Pick<ReleaseUpdateManager, "status" | "check">,
    private readonly receiptPath: string,
    private readonly onStatus: (status: ReleaseUpdateStatus) => void,
    private readonly notify: (version: string) => boolean,
  ) {}

  async start(): Promise<void> {
    try {
      const raw = await readFile(this.receiptPath, "utf8");
      if (raw.length > 65_536)
        throw new Error("Update reminder receipt is too large.");
      const stored: unknown = JSON.parse(raw);
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        for (const [source, version] of Object.entries(stored).slice(-32)) {
          if (typeof version !== "string") continue;
          try {
            compareReleaseVersions(version, version);
            this.#notified.set(source, version);
          } catch {
            /* Ignore invalid receipts. */
          }
        }
      }
    } catch {
      /* A new profile has no notification receipts yet. */
    }
    if (this.#stopped) return;
    this.#timer = setInterval(
      () => void this.check().catch(() => undefined),
      60_000,
    );
    this.#timer.unref?.();
    await this.check().catch(() => undefined);
  }

  refresh(): void {
    this.onStatus(this.manager.status());
  }

  check(manual = false): Promise<ReleaseUpdateStatus> {
    if (this.#checking) return this.#checking;
    const status = this.manager.status();
    const recent =
      status.manifestUrl &&
      this.#lastAttempt?.source === status.manifestUrl &&
      Date.now() - this.#lastAttempt.at < 6 * 60 * 60_000;
    if (
      this.#stopped ||
      status.phase === "unconfigured" ||
      ["checking", "downloading", "installing", "ready"].includes(
        status.phase,
      ) ||
      (!manual && status.manifestUrl && recent)
    ) {
      this.refresh();
      return Promise.resolve(status);
    }
    const operation = this.#check();
    this.#checking = operation;
    void operation
      .finally(() => {
        if (this.#checking === operation) this.#checking = undefined;
      })
      .catch(() => undefined);
    return operation;
  }

  async #check(): Promise<ReleaseUpdateStatus> {
    try {
      const attemptedSource =
        this.manager.status().manifestUrl ?? this.manager.status().manifestPath;
      if (attemptedSource)
        this.#lastAttempt = { source: attemptedSource, at: Date.now() };
      const status = await this.manager.check();
      if (this.#stopped) return status;
      this.onStatus(status);
      const version = status.availableVersion;
      const source = status.manifestUrl ?? status.manifestPath;
      if (status.phase === "available" && version && source) {
        const previous = this.#notified.get(source);
        if (
          (!previous || compareReleaseVersions(version, previous) > 0) &&
          this.notify(version)
        ) {
          this.#notified.delete(source);
          this.#notified.set(source, version);
          if (this.#notified.size > 32)
            this.#notified.delete(this.#notified.keys().next().value!);
          try {
            await mkdir(dirname(this.receiptPath), { recursive: true });
            await writeFile(
              this.receiptPath,
              JSON.stringify(Object.fromEntries(this.#notified)),
              { mode: 0o600 },
            );
          } catch {
            /* Notification receipts must not turn a valid update into a failure. */
          }
        }
      }
      return status;
    } finally {
      if (!this.#stopped) this.refresh();
    }
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
  }
}
