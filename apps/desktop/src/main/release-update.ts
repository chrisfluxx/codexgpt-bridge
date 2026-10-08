import { createHash, randomUUID, verify as verifySignature } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ReleaseArch,
  ReleaseArtifact,
  ReleaseArtifactKind,
  ReleaseManifest,
  ReleaseManifestSignature,
  ReleasePlatform,
  ReleaseUpdateStatus,
} from "./release-update-types.js";
export type {
  ReleaseArtifact,
  ReleaseManifest,
  ReleaseUpdateStatus,
} from "./release-update-types.js";

const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_ARTIFACT_BYTES = 1_500_000_000;
const MAX_RELEASE_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const GITHUB_ASSET_ORIGINS = new Set([
  "https://release-assets.githubusercontent.com",
  "https://objects.githubusercontent.com",
  "https://github-releases.githubusercontent.com",
]);
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+()-]{0,199}$/u;
const PLATFORMS = new Set<ReleasePlatform>(["win32", "darwin", "linux"]);
const ARCHES = new Set<ReleaseArch>(["x64", "arm64"]);
const KINDS = new Set<ReleaseArtifactKind>([
  "nsis",
  "dmg",
  "zip",
  "appimage",
  "deb",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function updateErrorMessage(error: unknown, fallback: string): string {
  const code = record(error)?.code;
  if (code === "ENOENT")
    return "Update file was not found. Check the update source.";
  if (code === "ENOSPC") return "Insufficient disk space for the update.";
  if (typeof code === "string" && /^E[A-Z]+$/u.test(code))
    return `Update file could not be accessed (${code}). Check file permissions.`;
  return error instanceof Error ? error.message : fallback;
}

function allowedRemoteUrl(value: string, base?: URL): URL {
  const url = new URL(value, base);
  const loopback =
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback)
    throw new Error(
      "Release URLs must use HTTPS (loopback HTTP is test-only).",
    );
  if (url.username || url.password)
    throw new Error("Release URLs must not contain credentials.");
  return url;
}

async function fetchReleaseResponse(
  value: string,
  fetcher: typeof fetch,
  options: RequestInit,
): Promise<{ response: Response; sourceUrl: string }> {
  const original = allowedRemoteUrl(value);
  let current = original;
  let sourceUrl = original.href;
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetcher(current.href, {
      ...options,
      credentials: "omit",
      redirect: "manual",
    });
    if (!REDIRECT_STATUSES.has(response.status)) return { response, sourceUrl };
    await response.body?.cancel();
    if (redirects >= MAX_RELEASE_REDIRECTS)
      throw new Error("Release download exceeded its redirect limit.");
    const location = response.headers.get("location");
    if (!location) throw new Error("Release redirect has no destination.");
    const next = allowedRemoteUrl(location, current);
    const sameOrigin = next.origin === current.origin;
    const githubAsset =
      current.origin === "https://github.com" &&
      GITHUB_ASSET_ORIGINS.has(next.origin);
    if (!sameOrigin && !githubAsset)
      throw new Error("Release redirect destination is not allowed.");
    // Resolve relative artifact URLs beside the release manifest, before GitHub's CDN.
    if (next.origin === original.origin) sourceUrl = next.href;
    current = next;
  }
}

export function normalizeUpdateManifestUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 2_048)
    throw new Error("Update manifest URL is invalid.");
  return allowedRemoteUrl(value).toString();
}

function manifestSignature(
  value: unknown,
): ReleaseManifestSignature | undefined {
  if (value === undefined) return undefined;
  const signature = record(value);
  if (
    !signature ||
    signature.algorithm !== "ed25519" ||
    typeof signature.keyId !== "string" ||
    !KEY_ID.test(signature.keyId) ||
    typeof signature.value !== "string" ||
    !BASE64_SIGNATURE.test(signature.value)
  )
    throw new Error("Release manifest signature is invalid.");
  return {
    algorithm: "ed25519",
    keyId: signature.keyId,
    value: signature.value,
  };
}

function signingPayload(value: unknown): Buffer {
  const input = record(value);
  if (!input || !Array.isArray(input.artifacts))
    throw new Error("Release manifest schema is invalid.");
  const artifacts = input.artifacts.map((item) => {
    const artifact = record(item);
    if (!artifact) throw new Error("Release artifact is invalid.");
    return {
      platform: artifact.platform,
      arch: artifact.arch,
      kind: artifact.kind,
      file: artifact.file,
      size: artifact.size,
      sha256: artifact.sha256,
      url: artifact.url,
    };
  });
  return Buffer.from(
    JSON.stringify({
      schemaVersion: input.schemaVersion,
      version: input.version,
      publishedAt: input.publishedAt,
      artifacts,
    }),
    "utf8",
  );
}

export function verifyReleaseManifestSignature(
  value: unknown,
  trustedPublicKey: string | Buffer,
): ReleaseManifestSignature {
  const input = record(value);
  const signature = manifestSignature(input?.signature);
  if (!signature) throw new Error("Release manifest signature is required.");
  try {
    if (
      !verifySignature(
        null,
        signingPayload(value),
        trustedPublicKey,
        Buffer.from(signature.value, "base64"),
      )
    )
      throw new Error("Release manifest signature verification failed.");
  } catch {
    throw new Error("Release manifest signature verification failed.");
  }
  return signature;
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (!a || !b)
    throw new Error("Release version is not valid semantic versioning.");
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  if (a[4] === b[4]) return 0;
  if (a[4] === undefined) return 1;
  if (b[4] === undefined) return -1;
  return a[4].localeCompare(b[4], "en", { numeric: true });
}

export function parseReleaseManifest(
  value: unknown,
  manifestUrl: string,
): ReleaseManifest {
  const input = record(value);
  if (!input || input.schemaVersion !== 1 || typeof input.version !== "string")
    throw new Error("Release manifest schema is invalid.");
  if (!SEMVER.test(input.version))
    throw new Error("Release manifest version is invalid.");
  if (
    typeof input.publishedAt !== "string" ||
    !Number.isFinite(Date.parse(input.publishedAt))
  )
    throw new Error("Release manifest publish time is invalid.");
  if (
    !Array.isArray(input.artifacts) ||
    input.artifacts.length === 0 ||
    input.artifacts.length > 32
  )
    throw new Error("Release manifest artifacts are invalid.");
  const signature = manifestSignature(input.signature);
  const base = allowedRemoteUrl(manifestUrl);
  const artifacts = input.artifacts.map((item): ReleaseArtifact => {
    const artifact = record(item);
    if (!artifact) throw new Error("Release artifact is invalid.");
    if (
      typeof artifact.platform !== "string" ||
      !PLATFORMS.has(artifact.platform as ReleasePlatform) ||
      typeof artifact.arch !== "string" ||
      !ARCHES.has(artifact.arch as ReleaseArch) ||
      typeof artifact.kind !== "string" ||
      !KINDS.has(artifact.kind as ReleaseArtifactKind) ||
      typeof artifact.file !== "string" ||
      !FILE_NAME.test(artifact.file) ||
      basename(artifact.file) !== artifact.file ||
      !Number.isSafeInteger(artifact.size) ||
      (artifact.size as number) <= 0 ||
      (artifact.size as number) > MAX_ARTIFACT_BYTES ||
      typeof artifact.sha256 !== "string" ||
      !SHA256.test(artifact.sha256) ||
      typeof artifact.url !== "string"
    )
      throw new Error("Release artifact fields are invalid.");
    return {
      platform: artifact.platform as ReleasePlatform,
      arch: artifact.arch as ReleaseArch,
      kind: artifact.kind as ReleaseArtifactKind,
      file: artifact.file,
      size: artifact.size as number,
      sha256: artifact.sha256,
      url: allowedRemoteUrl(artifact.url, base).toString(),
    };
  });
  const identities = artifacts.map(
    (artifact) => `${artifact.platform}:${artifact.arch}:${artifact.kind}`,
  );
  if (new Set(identities).size !== identities.length)
    throw new Error("Release manifest contains duplicate platform artifacts.");
  return {
    schemaVersion: 1,
    version: input.version,
    publishedAt: input.publishedAt,
    artifacts,
    ...(signature ? { signature } : {}),
  };
}

export function selectReleaseArtifact(
  manifest: ReleaseManifest,
  platform: NodeJS.Platform,
  arch: string,
): ReleaseArtifact | undefined {
  if (
    !PLATFORMS.has(platform as ReleasePlatform) ||
    !ARCHES.has(arch as ReleaseArch)
  )
    return undefined;
  const preferred: Record<ReleasePlatform, readonly ReleaseArtifactKind[]> = {
    win32: ["nsis"],
    darwin: ["dmg", "zip"],
    linux: ["appimage", "deb"],
  };
  for (const kind of preferred[platform as ReleasePlatform]) {
    const artifact = manifest.artifacts.find(
      (candidate) =>
        candidate.platform === platform &&
        candidate.arch === arch &&
        candidate.kind === kind,
    );
    if (artifact) return artifact;
  }
  return undefined;
}

export function parseLocalReleaseManifest(
  value: unknown,
  manifestPath: string,
): ReleaseManifest {
  if (!isAbsolute(manifestPath))
    throw new Error("Local release manifest path must be absolute.");
  const parsed = parseReleaseManifest(
    value,
    "http://localhost/release-manifest.json",
  );
  const input = record(value)!;
  const artifacts = parsed.artifacts.map((artifact, index) => {
    const original = record((input.artifacts as unknown[])[index])!;
    if (original.url !== artifact.file && original.url !== `./${artifact.file}`)
      throw new Error(
        "Local release artifacts must be files beside the manifest.",
      );
    return {
      ...artifact,
      url: pathToFileURL(join(dirname(manifestPath), artifact.file)).href,
    };
  });
  return { ...parsed, artifacts };
}

async function localFileResponse(
  path: string,
  maximum = MAX_ARTIFACT_BYTES,
  expectedSize?: number,
): Promise<Response> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Local update source is not a file.");
  if (info.size > maximum)
    throw new Error("Local update source exceeds its size limit.");
  if (expectedSize !== undefined && info.size !== expectedSize)
    throw new Error("Update size does not match its release manifest.");
  return new Response(
    Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
    {
      headers: { "content-length": String(info.size) },
    },
  );
}

async function boundedText(
  response: Response,
  maximum: number,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum)
    throw new Error("Release response exceeds its size limit.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maximum) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Release response exceeds its size limit.");
    }
    chunks.push(part.value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function replaceDownloadedArtifact(
  temporary: string,
  destination: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        (code !== "EPERM" && code !== "EACCES") ||
        attempt >= 7
      )
        throw error;
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, Math.min(10 * 2 ** attempt, 250)),
      );
    }
  }
}

export class ReleaseUpdateManager {
  #status: ReleaseUpdateStatus;
  #manifest: ReleaseManifest | undefined;
  #artifact: ReleaseArtifact | undefined;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly currentVersion: string,
    private readonly updateDirectory: string,
    private manifestUrl?: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly arch: string = process.arch,
    private readonly trustedManifestPublicKey?: string | Buffer,
    private localManifestPath?: string,
  ) {
    if (localManifestPath && !isAbsolute(localManifestPath))
      throw new Error("Local release manifest path must be absolute.");
    this.#status = {
      phase: manifestUrl || localManifestPath ? "idle" : "unconfigured",
      currentVersion,
      ...this.#sourceStatus(),
    };
  }

  configure(
    manifestUrl?: string,
    localManifestPath = this.localManifestPath,
  ): ReleaseUpdateStatus {
    if (["checking", "downloading", "installing"].includes(this.#status.phase))
      throw new Error("Wait for the current update operation to finish.");
    if (localManifestPath && !isAbsolute(localManifestPath))
      throw new Error("Local release manifest path must be absolute.");
    this.manifestUrl = manifestUrl;
    this.localManifestPath = localManifestPath;
    this.#manifest = undefined;
    this.#artifact = undefined;
    this.#status = {
      phase: manifestUrl || this.localManifestPath ? "idle" : "unconfigured",
      currentVersion: this.currentVersion,
      ...this.#sourceStatus(),
    };
    return this.#status;
  }

  status(): ReleaseUpdateStatus {
    return this.#status;
  }

  markInstalling(): ReleaseUpdateStatus {
    if (this.#status.phase !== "ready")
      throw new Error("A verified update is not ready to install.");
    this.#status = { ...this.#status, phase: "installing" };
    return this.#status;
  }

  verifyReadyArtifact(): Promise<ReleaseUpdateStatus> {
    return this.#serialize(async () => {
      const status = this.#status;
      if (
        status.phase !== "ready" ||
        !status.downloadedPath ||
        !status.artifact
      )
        throw new Error("A verified update is not ready to install.");
      try {
        const info = await stat(status.downloadedPath);
        if (!info.isFile() || info.size !== status.artifact.size)
          throw new Error("Downloaded update size changed after verification.");
        const hash = createHash("sha256");
        const handle = await open(status.downloadedPath, "r");
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        try {
          for (;;) {
            const { bytesRead } = await handle.read(
              buffer,
              0,
              buffer.length,
              null,
            );
            if (bytesRead === 0) break;
            hash.update(buffer.subarray(0, bytesRead));
          }
        } finally {
          await handle.close();
        }
        if (hash.digest("hex") !== status.artifact.sha256)
          throw new Error(
            "Downloaded update checksum changed after verification.",
          );
        return status;
      } catch (error) {
        const message = updateErrorMessage(
          error,
          "Downloaded update verification failed.",
        );
        this.#status = {
          ...status,
          phase: "failed",
          error: message,
        };
        throw new Error(message, { cause: error });
      }
    });
  }

  markReadyAfterLaunchFailure(error: unknown): ReleaseUpdateStatus {
    if (!this.#status.downloadedPath || !this.#status.artifact)
      throw new Error("A verified update is not available.");
    this.#status = {
      ...this.#status,
      phase: "ready",
      error: updateErrorMessage(error, "Update launch failed."),
    };
    return this.#status;
  }

  check(fetcher: typeof fetch = fetch): Promise<ReleaseUpdateStatus> {
    return this.#serialize(async () => {
      if (!this.manifestUrl && !this.localManifestPath)
        throw new Error("Update manifest URL is not configured.");
      this.#status = {
        phase: "checking",
        currentVersion: this.currentVersion,
        ...this.#sourceStatus(),
      };
      try {
        const { response, sourceUrl } = this.manifestUrl
          ? await fetchReleaseResponse(this.manifestUrl, fetcher, {
              headers: {
                accept: "application/json",
                "cache-control": "no-cache",
              },
              signal: AbortSignal.timeout(15_000),
            })
          : {
              response: await localFileResponse(
                this.localManifestPath!,
                MAX_MANIFEST_BYTES,
              ),
              sourceUrl: "",
            };
        if (!response.ok)
          throw new Error(`Update check failed with HTTP ${response.status}.`);
        const manifestValue: unknown = JSON.parse(
          await boundedText(response, MAX_MANIFEST_BYTES),
        );
        const verifiedSignature = this.trustedManifestPublicKey
          ? verifyReleaseManifestSignature(
              manifestValue,
              this.trustedManifestPublicKey,
            )
          : undefined;
        const manifest = this.manifestUrl
          ? parseReleaseManifest(manifestValue, sourceUrl)
          : parseLocalReleaseManifest(manifestValue, this.localManifestPath!);
        const artifact = selectReleaseArtifact(
          manifest,
          this.platform,
          this.arch,
        );
        if (!artifact)
          throw new Error(
            `No update artifact supports ${this.platform}/${this.arch}.`,
          );
        this.#manifest = manifest;
        this.#artifact = artifact;
        const available =
          compareReleaseVersions(manifest.version, this.currentVersion) > 0;
        this.#status = {
          phase: available ? "available" : "up-to-date",
          currentVersion: this.currentVersion,
          ...this.#sourceStatus(),
          availableVersion: manifest.version,
          artifact,
          checkedAt: new Date().toISOString(),
          ...(verifiedSignature
            ? {
                manifestSignatureVerified: true,
                manifestKeyId: verifiedSignature.keyId,
              }
            : {}),
        };
        return this.#status;
      } catch (error) {
        const message = updateErrorMessage(error, "Update check failed.");
        this.#status = {
          ...this.#status,
          phase: "failed",
          error: message,
        };
        throw new Error(message, { cause: error });
      }
    });
  }

  download(fetcher: typeof fetch = fetch): Promise<ReleaseUpdateStatus> {
    return this.#serialize(async () => {
      if (
        !this.#manifest ||
        !this.#artifact ||
        this.#status.phase !== "available"
      )
        throw new Error("Check for an available update before downloading.");
      const artifact = this.#artifact;
      this.#status = {
        phase: "downloading",
        currentVersion: this.currentVersion,
        ...this.#sourceStatus(),
        availableVersion: this.#manifest.version,
        artifact,
        ...(this.#status.checkedAt
          ? { checkedAt: this.#status.checkedAt }
          : {}),
      };
      await mkdir(this.updateDirectory, { recursive: true });
      const destination = join(this.updateDirectory, artifact.file);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        let response: Response;
        if (!this.manifestUrl && this.localManifestPath) {
          const path = await realpath(fileURLToPath(artifact.url));
          if (
            dirname(path) !== (await realpath(dirname(this.localManifestPath)))
          )
            throw new Error(
              "Local update artifact escapes its release directory.",
            );
          response = await localFileResponse(
            path,
            MAX_ARTIFACT_BYTES,
            artifact.size,
          );
        } else {
          ({ response } = await fetchReleaseResponse(artifact.url, fetcher, {
            signal: AbortSignal.timeout(10 * 60_000),
          }));
        }
        if (!response.ok)
          throw new Error(
            `Update download failed with HTTP ${response.status}.`,
          );
        const contentLength = response.headers.get("content-length");
        const declared = contentLength === null ? NaN : Number(contentLength);
        if (Number.isFinite(declared) && declared !== artifact.size)
          throw new Error("Update size does not match its release manifest.");
        if (!response.body)
          throw new Error("Update download returned no body.");
        const handle = await open(temporary, "wx", 0o600);
        const hash = createHash("sha256");
        let total = 0;
        try {
          const reader = response.body.getReader();
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            total += part.value.byteLength;
            if (total > artifact.size || total > MAX_ARTIFACT_BYTES) {
              await reader.cancel().catch(() => undefined);
              throw new Error("Update download exceeds its declared size.");
            }
            hash.update(part.value);
            await handle.write(part.value);
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (total !== artifact.size)
          throw new Error("Update size does not match its release manifest.");
        if (hash.digest("hex") !== artifact.sha256)
          throw new Error("Update checksum verification failed.");
        await replaceDownloadedArtifact(temporary, destination);
        this.#status = {
          ...this.#status,
          phase: "ready",
          downloadedPath: destination,
        };
        return this.#status;
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        const message = updateErrorMessage(error, "Update download failed.");
        this.#status = {
          ...this.#status,
          phase: "failed",
          error: message,
        };
        throw new Error(message, { cause: error });
      }
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  #sourceStatus(): Pick<ReleaseUpdateStatus, "manifestUrl" | "manifestPath"> {
    return this.manifestUrl
      ? { manifestUrl: this.manifestUrl }
      : this.localManifestPath
        ? { manifestPath: this.localManifestPath }
        : {};
  }
}
