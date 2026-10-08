import { access, stat } from "node:fs/promises";
import type { ChatGptUsageSummary } from "./chatgpt-usage-types.js";
import type {
  DesktopDoctorReport,
  DoctorCheck,
} from "./desktop-doctor-types.js";
import type { ReleaseUpdateStatus } from "./release-update-types.js";
export type {
  DesktopDoctorReport,
  DoctorCheck,
} from "./desktop-doctor-types.js";

interface DoctorFile {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly required: boolean;
  readonly repairable: boolean;
}

export interface DesktopDoctorInput {
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly homeDirectory: string;
  readonly secureStorageAvailable: boolean;
  readonly settingsLoaded: boolean;
  readonly provider: {
    readonly installed: boolean;
    readonly repairable: boolean;
    readonly running: boolean;
    readonly browserSignedIn: boolean;
    readonly error?: string;
  };
  readonly update: ReleaseUpdateStatus;
  readonly usage: ChatGptUsageSummary;
  readonly fullMcp?: {
    readonly configured: boolean;
    readonly running: boolean;
    readonly ready: boolean;
    readonly detail?: string;
  };
  readonly files: readonly DoctorFile[];
}

function safePath(path: string, home: string): string {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/").replace(/\/$/u, "");
  return normalizedPath.toLowerCase().startsWith(normalizedHome.toLowerCase())
    ? `<home>${normalizedPath.slice(normalizedHome.length)}`
    : `<external>/${normalizedPath.split("/").at(-1) ?? "path"}`;
}

async function fileCheck(file: DoctorFile, home: string): Promise<DoctorCheck> {
  try {
    await access(file.path);
    const info = await stat(file.path);
    return {
      id: file.id,
      status: info.isFile() ? "pass" : "fail",
      label: file.label,
      detail: `${safePath(file.path, home)} is ${info.isFile() ? "present" : "not a regular file"}.`,
      repairable: file.repairable,
    };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      id: file.id,
      status: file.required || !missing ? "fail" : "warning",
      label: file.label,
      detail: `${safePath(file.path, home)} ${missing ? "is absent" : "could not be inspected"}.`,
      repairable: file.repairable,
    };
  }
}

export async function runDesktopDoctor(
  input: DesktopDoctorInput,
): Promise<DesktopDoctorReport> {
  const checks: DoctorCheck[] = [
    {
      id: "secure-storage",
      status: input.secureStorageAvailable ? "pass" : "fail",
      label: "Secure credential storage",
      detail: input.secureStorageAvailable
        ? "OS-backed encryption is available."
        : "OS-backed encryption is unavailable; ChatGPT credentials cannot be stored securely.",
      repairable: false,
    },
    {
      id: "settings",
      status: input.settingsLoaded ? "pass" : "fail",
      label: "Desktop settings",
      detail: input.settingsLoaded
        ? "Settings parsed with the current schema."
        : "Desktop settings could not be parsed.",
      repairable: false,
    },
    {
      id: "provider-integration",
      status: input.provider.repairable
        ? "fail"
        : input.provider.installed
          ? "pass"
          : "warning",
      label: "Codex Web provider integration",
      detail: input.provider.repairable
        ? "Owned provider files no longer match their integrity journal."
        : input.provider.installed
          ? "Owned provider configuration and catalog match their journal."
          : "Web models are not installed in Codex.",
      repairable: input.provider.repairable,
    },
    {
      id: "provider-runtime",
      status:
        input.provider.installed && !input.provider.running ? "fail" : "pass",
      label: "Responses gateway",
      detail: input.provider.running
        ? "The loopback Responses gateway is running."
        : input.provider.installed
          ? `The provider is installed but its gateway is offline${input.provider.error ? `: ${input.provider.error}` : "."}`
          : "The gateway may remain offline until Web models are installed.",
      repairable: input.provider.installed && !input.provider.running,
    },
    {
      id: "chatgpt-session",
      status: input.provider.browserSignedIn ? "pass" : "warning",
      label: "ChatGPT browser session",
      detail: input.provider.browserSignedIn
        ? "A signed-in composer is visible in the isolated Bridge partition."
        : "No signed-in composer is currently verified; open ChatGPT login to check it.",
      repairable: false,
    },
    {
      id: "usage-policy",
      status: input.usage.accountObserved
        ? input.usage.needsAttention
          ? "fail"
          : input.usage.supported
            ? "pass"
            : "warning"
        : "warning",
      label: "Official limits policy and local usage ledger",
      detail: input.usage.accountObserved
        ? `Observed ${input.usage.plan ?? "unknown"}; retained ${input.usage.accepted.retainedEvents} account-isolated accepted sends. Remaining usage and reset time are intentionally not inferred.`
        : "Refresh limits after signing in to bind local accepted-send counts to a hashed account identity.",
      repairable: false,
    },
    {
      id: "updates",
      status:
        input.update.phase === "failed"
          ? "fail"
          : input.update.phase === "unconfigured"
            ? "warning"
            : "pass",
      label: "Verified update channel",
      detail:
        input.update.phase === "unconfigured"
          ? "No update manifest URL is configured."
          : input.update.phase === "failed"
            ? (input.update.error ?? "The last update operation failed.")
            : `Update channel is ${input.update.phase}; downloaded installers require exact SHA-256 verification.`,
      repairable: false,
    },
  ];
  if (input.fullMcp) {
    checks.push({
      id: "full-mcp",
      status: !input.fullMcp.configured
        ? "warning"
        : input.fullMcp.ready
          ? "pass"
          : "fail",
      label: "Full MCP tunnel",
      detail: !input.fullMcp.configured
        ? "Full MCP is selected but tunnel settings are incomplete."
        : input.fullMcp.ready
          ? "Full MCP listener and tunnel are ready."
          : (input.fullMcp.detail ?? "Full MCP is configured but not ready."),
      repairable: false,
    });
  }
  checks.push(
    ...(await Promise.all(
      input.files.map((file) => fileCheck(file, input.homeDirectory)),
    )),
  );
  const overall = checks.some((check) => check.status === "fail")
    ? "broken"
    : checks.some((check) => check.status === "warning")
      ? "attention"
      : "healthy";
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    appVersion: input.appVersion,
    platform: input.platform,
    arch: input.arch,
    overall,
    checks,
    privacy: {
      promptsIncluded: false,
      responsesIncluded: false,
      credentialsIncluded: false,
      rawAccountIdentityIncluded: false,
      absoluteHomePathsIncluded: false,
    },
  };
}
