function parseTomlString(literal: string, description: string): string {
  if (literal.startsWith("'")) return literal.slice(1, -1);
  try {
    const parsed = JSON.parse(literal) as unknown;
    if (typeof parsed === "string") return parsed;
  } catch {
    // Report one stable configuration error below.
  }
  throw new Error(`${description} must be a single-line TOML string.`);
}

function assignmentStringValue(line: string, key: string): string | undefined {
  const assignment =
    /^\s*([A-Za-z0-9_]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/u.exec(
      line,
    );
  if (assignment?.[1] === key) {
    return parseTomlString(assignment[2]!, `Codex ${key}`);
  }
  if (new RegExp(`^\\s*${key}\\s*=`, "u").test(line)) {
    throw new Error(`Codex ${key} must be a single-line TOML string.`);
  }
  return undefined;
}

function topLevelStringValue(text: string, key: string): string | undefined {
  let value: string | undefined;
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\n|$)/gu)) {
    if (match[0].length === 0) break;
    const line = match[0].replace(/\r?\n$/u, "");
    if (/^\s*\[/u.test(line)) break;
    const candidate = assignmentStringValue(line, key);
    if (candidate === undefined) continue;
    if (value !== undefined) {
      throw new Error(`Codex config contains duplicate ${key} assignments.`);
    }
    value = candidate;
  }
  return value;
}

function providerSectionBaseUrl(
  text: string,
  providerId: string,
): string | undefined {
  let inProviderSection = false;
  let value: string | undefined;
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\n|$)/gu)) {
    if (match[0].length === 0) break;
    const line = match[0].replace(/\r?\n$/u, "");
    const providerTable =
      /^\s*\[\s*model_providers\.("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*\]\s*(?:#.*)?$/u.exec(
        line,
      );
    if (providerTable) {
      const literal = providerTable[1]!;
      const sectionId =
        literal.startsWith('"') || literal.startsWith("'")
          ? parseTomlString(literal, "Codex model provider table name")
          : literal;
      inProviderSection = sectionId === providerId;
      continue;
    }
    if (/^\s*\[/u.test(line)) {
      inProviderSection = false;
      continue;
    }
    if (!inProviderSection) continue;
    const candidate = assignmentStringValue(line, "base_url");
    if (candidate === undefined) continue;
    if (value !== undefined) {
      throw new Error(
        `Codex provider ${JSON.stringify(providerId)} contains duplicate base_url assignments.`,
      );
    }
    value = candidate;
  }
  return value;
}

export function normalizeOriginalProviderBaseUrl(
  value: string,
  bridgeBaseUrl?: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("The original Codex provider base URL is invalid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The original Codex provider must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "The original Codex provider base URL cannot contain credentials, query parameters or a fragment.",
    );
  }
  const normalized = parsed.toString().replace(/\/+$/u, "");
  if (bridgeBaseUrl !== undefined) {
    const bridge = new URL(bridgeBaseUrl);
    if (parsed.origin === bridge.origin) {
      throw new Error(
        "The original Codex provider points back to CodexGPT Bridge and would create a proxy loop.",
      );
    }
  }
  return normalized;
}

export function parseOriginalProviderAssignment(
  assignment: string,
  bridgeBaseUrl?: string,
): string | undefined {
  if (assignment.length === 0) return undefined;
  const line = assignment.replace(/\r?\n$/u, "");
  const value = assignmentStringValue(line, "openai_base_url");
  if (value === undefined) {
    throw new Error(
      "The saved original openai_base_url is not a supported TOML string assignment.",
    );
  }
  return normalizeOriginalProviderBaseUrl(value, bridgeBaseUrl);
}

/** Resolve the effective provider Codex used before Bridge adds its top-level route override. */
export function originalProviderBaseUrlFromConfig(
  config: string,
  bridgeBaseUrl?: string,
): string | undefined {
  const direct = topLevelStringValue(config, "openai_base_url");
  if (direct !== undefined) {
    return normalizeOriginalProviderBaseUrl(direct, bridgeBaseUrl);
  }

  const providerId = topLevelStringValue(config, "model_provider");
  if (providerId === undefined || providerId === "openai") return undefined;
  const providerBaseUrl = providerSectionBaseUrl(config, providerId);
  if (providerBaseUrl === undefined) {
    throw new Error(
      `The active Codex model provider ${JSON.stringify(providerId)} does not have a literal base_url that Bridge can preserve.`,
    );
  }
  return normalizeOriginalProviderBaseUrl(providerBaseUrl, bridgeBaseUrl);
}
