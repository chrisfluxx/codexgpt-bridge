import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const counts = [
  "rootsCount",
  "elementsCount",
  "effortsCount",
  "modelsCount",
  "slidersCount",
] as const;

/** Opt-in structural telemetry. Never serialize page strings, URLs or error messages. */
export async function recordModelDiagnostic(
  profileDirectory: string,
  collect: () => Promise<unknown>,
  enabled = process.env.CODEXGPT_BRIDGE_MODEL_DIAGNOSTICS === "1",
): Promise<boolean> {
  if (!enabled) return false;
  try {
    const raw = await collect();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const value = raw as Record<string, unknown>;
    const safe: Record<string, unknown> = {
      version: 1,
      capturedAt: new Date().toISOString(),
      menuState: value.menuState === "closed" ? "closed" : "loading",
      composerFound: value.composerFound === true,
    };
    for (const key of counts) {
      const count = value[key];
      if (
        typeof count === "number" &&
        Number.isSafeInteger(count) &&
        count >= 0
      ) {
        safe[key] = Math.min(count, 100_000);
      }
    }
    await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(profileDirectory, "menu-debug.json"),
      JSON.stringify(safe, null, 2),
      { mode: 0o600 },
    );
    return true;
  } catch {
    // Diagnostics must never replace the original model/preparation failure.
    return false;
  }
}
