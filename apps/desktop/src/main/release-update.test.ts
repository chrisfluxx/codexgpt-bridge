import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  ReleaseUpdateManager,
  compareReleaseVersions,
  parseReleaseManifest,
  parseLocalReleaseManifest,
  selectReleaseArtifact,
} from "./release-update.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function manifest(
  bytes: Uint8Array,
  sha256 = createHash("sha256").update(bytes).digest("hex"),
) {
  return {
    schemaVersion: 1,
    version: "0.2.0",
    publishedAt: "2026-09-29T00:00:00.000Z",
    artifacts: [
      {
        platform: "win32",
        arch: "x64",
        kind: "nsis",
        file: "CodexGPT-Bridge-Setup-0.2.0.exe",
        size: bytes.byteLength,
        sha256,
        url: "./CodexGPT-Bridge-Setup-0.2.0.exe",
      },
    ],
  };
}

function signedManifest(
  value: ReturnType<typeof manifest>,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  keyId = "release-2026",
) {
  return {
    ...value,
    signature: {
      algorithm: "ed25519" as const,
      keyId,
      value: sign(
        null,
        Buffer.from(JSON.stringify(value), "utf8"),
        privateKey,
      ).toString("base64"),
    },
  };
}

describe("release update verification", () => {
  it("reports missing local manifests without disclosing their absolute path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-private-update-"));
    directories.push(directory);
    const manager = new ReleaseUpdateManager(
      "0.1.68",
      join(directory, "downloaded"),
      undefined,
      "win32",
      "x64",
      undefined,
      join(directory, "private-folder", "release-manifest.json"),
    );
    await assert.rejects(manager.check(), {
      message: "Update file was not found. Check the update source.",
    });
    assert.equal(manager.status().phase, "failed");
    assert.equal(
      manager.status().error,
      "Update file was not found. Check the update source.",
    );
    assert.ok(!manager.status().error?.includes(directory));
  });

  it("keeps missing installers and launch errors free of absolute paths", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "bridge-private-installer-"),
    );
    directories.push(directory);
    const bytes = new TextEncoder().encode("local installer fixture");
    const value = manifest(bytes);
    const manifestPath = join(directory, "release-manifest.json");
    await writeFile(manifestPath, JSON.stringify(value));
    await writeFile(join(directory, value.artifacts[0]!.file), bytes);
    const manager = new ReleaseUpdateManager(
      "0.1.68",
      join(directory, "downloaded"),
      undefined,
      "win32",
      "x64",
      undefined,
      manifestPath,
    );
    await manager.check();
    const ready = await manager.download();
    const failure = Object.assign(
      new Error(`Permission denied: ${ready.downloadedPath!}`),
      { code: "EACCES" },
    );
    const failedLaunch = manager.markReadyAfterLaunchFailure(failure);
    assert.equal(failedLaunch.phase, "ready");
    assert.ok(!failedLaunch.error?.includes(directory));
    assert.match(failedLaunch.error ?? "", /EACCES/u);
    await rm(ready.downloadedPath!, { force: true });
    await assert.rejects(manager.verifyReadyArtifact(), {
      message: "Update file was not found. Check the update source.",
    });
    assert.ok(!manager.status().error?.includes(directory));
  });

  it("checks a local release directory without HTTP and verifies copied installer bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-local-update-"));
    directories.push(directory);
    const bytes = new TextEncoder().encode("local installer fixture");
    const value = manifest(bytes);
    const manifestPath = join(directory, "release-manifest.json");
    await writeFile(manifestPath, JSON.stringify(value));
    await writeFile(join(directory, value.artifacts[0]!.file), bytes);
    const manager = new ReleaseUpdateManager(
      "0.1.68",
      join(directory, "downloaded"),
      undefined,
      "win32",
      "x64",
      undefined,
      manifestPath,
    );
    const noNetwork = (() => {
      throw new Error("Local updates must not use HTTP");
    }) as typeof fetch;
    const status = await manager.check(noNetwork);
    assert.equal(status.phase, "available");
    assert.equal(status.manifestPath, manifestPath);
    const ready = await manager.download(noNetwork);
    assert.equal(ready.phase, "ready");
    assert.deepEqual(await readFile(ready.downloadedPath!), Buffer.from(bytes));
    await manager.verifyReadyArtifact();
    const fallback = manager.configure();
    assert.equal(fallback.phase, "idle");
    assert.equal(fallback.manifestPath, manifestPath);
  });

  it("rejects local release traversal, remote redirection and absolute artifact URLs", () => {
    const value = manifest(new TextEncoder().encode("fixture"));
    for (const url of [
      "../bad.exe",
      "file:///tmp/bad.exe",
      "https://example.test/bad.exe",
      "./nested/bad.exe",
    ]) {
      assert.throws(() =>
        parseLocalReleaseManifest(
          { ...value, artifacts: [{ ...value.artifacts[0], url }] },
          join(tmpdir(), "release-manifest.json"),
        ),
      );
    }
  });

  it("prefers a configured online feed over the local fallback", async () => {
    const manager = new ReleaseUpdateManager(
      "0.1.68",
      "unused",
      "https://updates.example.test/release-manifest.json",
      "win32",
      "x64",
      undefined,
      join(tmpdir(), "missing-release.json"),
    );
    const status = await manager.check(
      (async () =>
        new Response(
          JSON.stringify(manifest(new Uint8Array([1]))),
        )) as typeof fetch,
    );
    assert.equal(status.phase, "available");
    assert.equal(status.manifestPath, undefined);
  });

  it("rejects an oversized local manifest before opening a body stream", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "bridge-large-local-update-"),
    );
    directories.push(directory);
    const manifestPath = join(directory, "release-manifest.json");
    await writeFile(manifestPath, " ".repeat(1_000_001));
    const manager = new ReleaseUpdateManager(
      "0.1.68",
      directory,
      undefined,
      "win32",
      "x64",
      undefined,
      manifestPath,
    );
    await assert.rejects(manager.check(), /size limit/);
  });

  it("can switch or remove the configured manifest source", () => {
    const manager = new ReleaseUpdateManager(
      "0.1.64",
      "unused",
      undefined,
      "win32",
      "x64",
    );
    assert.equal(manager.status().phase, "unconfigured");
    assert.equal(
      manager.configure("https://updates.example.test/release-manifest.json")
        .phase,
      "idle",
    );
    assert.equal(manager.configure().phase, "unconfigured");
  });

  it("compares versions and selects a platform-native installer", () => {
    assert.equal(compareReleaseVersions("0.2.0", "0.1.64"), 1);
    assert.equal(compareReleaseVersions("0.1.64", "0.1.64"), 0);
    assert.equal(compareReleaseVersions("0.1.64-beta.1", "0.1.64"), -1);
    const parsed = parseReleaseManifest(
      manifest(new TextEncoder().encode("installer")),
      "https://updates.example.test/release-manifest.json",
    );
    assert.equal(selectReleaseArtifact(parsed, "win32", "x64")?.kind, "nsis");
    assert.equal(selectReleaseArtifact(parsed, "darwin", "arm64"), undefined);
  });

  it("rejects credentials, traversal, duplicates and malformed checksums", () => {
    const bytes = new TextEncoder().encode("installer");
    for (const mutate of [
      (value: ReturnType<typeof manifest>) => ({
        ...value,
        artifacts: [{ ...value.artifacts[0]!, file: "../bad.exe" }],
      }),
      (value: ReturnType<typeof manifest>) => ({
        ...value,
        artifacts: [{ ...value.artifacts[0]!, sha256: "bad" }],
      }),
      (value: ReturnType<typeof manifest>) => ({
        ...value,
        artifacts: [...value.artifacts, value.artifacts[0]!],
      }),
      (value: ReturnType<typeof manifest>) => ({
        ...value,
        artifacts: [
          { ...value.artifacts[0]!, url: "http://example.test/bad.exe" },
        ],
      }),
    ]) {
      assert.throws(() =>
        parseReleaseManifest(
          mutate(manifest(bytes)),
          "https://updates.example.test/release-manifest.json",
        ),
      );
    }
  });

  it("requires and verifies an Ed25519 manifest signature when a trust key is configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexgpt-update-signed-"));
    directories.push(directory);
    const bytes = new TextEncoder().encode("signed installer");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const signed = signedManifest(manifest(bytes), privateKey);
    const manager = new ReleaseUpdateManager(
      "0.1.65",
      directory,
      "https://updates.example.test/release-manifest.json",
      "win32",
      "x64",
      publicKeyPem,
    );
    const fetcher = async () => new Response(JSON.stringify(signed));
    const status = await manager.check(fetcher as typeof fetch);
    assert.equal(status.phase, "available");
    assert.equal(status.manifestSignatureVerified, true);
    assert.equal(status.manifestKeyId, "release-2026");

    const missing = new ReleaseUpdateManager(
      "0.1.65",
      directory,
      "https://updates.example.test/release-manifest.json",
      "win32",
      "x64",
      publicKeyPem,
    );
    await assert.rejects(
      missing.check(
        (async () =>
          new Response(JSON.stringify(manifest(bytes)))) as typeof fetch,
      ),
      /signature is required/i,
    );

    const tampered = new ReleaseUpdateManager(
      "0.1.65",
      directory,
      "https://updates.example.test/release-manifest.json",
      "win32",
      "x64",
      publicKeyPem,
    );
    await assert.rejects(
      tampered.check(
        (async () =>
          new Response(
            JSON.stringify({ ...signed, version: "0.2.1" }),
          )) as typeof fetch,
      ),
      /signature verification failed/i,
    );
  });

  it("downloads only exact-size, checksum-matching artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexgpt-update-"));
    directories.push(directory);
    const bytes = new TextEncoder().encode("verified installer");
    const manager = new ReleaseUpdateManager(
      "0.1.64",
      directory,
      "https://updates.example.test/release-manifest.json",
      "win32",
      "x64",
    );
    const fetcher = async (url: string | URL | Request) =>
      String(url).endsWith("release-manifest.json")
        ? new Response(JSON.stringify(manifest(bytes)), {
            headers: { "content-type": "application/json" },
          })
        : new Response(bytes, {
            headers: { "content-length": String(bytes.byteLength) },
          });
    assert.equal(
      (await manager.check(fetcher as typeof fetch)).phase,
      "available",
    );
    const ready = await manager.download(fetcher as typeof fetch);
    assert.equal(ready.phase, "ready");
    assert.deepEqual(
      new Uint8Array(await readFile(ready.downloadedPath!)),
      bytes,
    );
  });

  it("follows GitHub latest and asset redirects for manifests and installers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-github-update-"));
    directories.push(directory);
    const bytes = new TextEncoder().encode("verified GitHub installer");
    const value = manifest(bytes);
    const latest =
      "https://github.com/example/bridge/releases/latest/download/release-manifest.json";
    const tagged =
      "https://github.com/example/bridge/releases/download/v0.2.0/";
    const manifestAsset =
      "https://release-assets.githubusercontent.com/manifest";
    const installerAsset =
      "https://release-assets.githubusercontent.com/installer";
    const calls: string[] = [];
    const signals: AbortSignal[] = [];
    const fetcher: typeof fetch = async (input, options) => {
      const url = String(input);
      calls.push(url);
      assert.equal(options?.redirect, "manual");
      assert.equal(options?.credentials, "omit");
      signals.push(options!.signal!);
      if (url === latest)
        return new Response(null, {
          status: 302,
          headers: { location: tagged + "release-manifest.json" },
        });
      if (url === tagged + "release-manifest.json")
        return new Response(null, {
          status: 302,
          headers: { location: manifestAsset },
        });
      if (url === manifestAsset) return new Response(JSON.stringify(value));
      if (url === tagged + value.artifacts[0]!.file)
        return new Response(null, {
          status: 302,
          headers: { location: installerAsset },
        });
      assert.equal(url, installerAsset);
      return new Response(bytes);
    };
    const manager = new ReleaseUpdateManager(
      "0.1.92",
      directory,
      latest,
      "win32",
      "x64",
    );
    const available = await manager.check(fetcher);
    assert.equal(available.phase, "available");
    assert.equal(available.manifestUrl, latest);
    assert.equal(available.artifact?.url, tagged + value.artifacts[0]!.file);
    const ready = await manager.download(fetcher);
    assert.equal(ready.phase, "ready");
    assert.deepEqual(await readFile(ready.downloadedPath!), Buffer.from(bytes));
    assert.equal(calls.length, 5);
    assert.equal(signals[0], signals[1]);
    assert.equal(signals[1], signals[2]);
    assert.equal(signals[3], signals[4]);
    await manager.verifyReadyArtifact();
    assert.equal(manager.markInstalling().phase, "installing");
  });

  it("rejects insecure, credential-bearing and untrusted redirect destinations before fetching them", async () => {
    const source =
      "https://github.com/example/bridge/releases/latest/download/release-manifest.json";
    for (const location of [
      "http://github.com/example/bridge/manifest.json",
      "https://user:password@release-assets.githubusercontent.com/manifest",
      "https://release-assets.githubusercontent.com.example.test/manifest",
      "https://example.test/manifest",
      "http://127.0.0.1/manifest",
    ]) {
      let calls = 0;
      const manager = new ReleaseUpdateManager(
        "0.1.92",
        "unused",
        source,
        "win32",
        "x64",
      );
      const fetcher: typeof fetch = async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location } });
      };
      await assert.rejects(
        manager.check(fetcher),
        /HTTPS|credentials|not allowed/u,
      );
      assert.equal(calls, 1);
      assert.equal(manager.status().phase, "failed");
    }
  });

  it("rejects missing redirect destinations and redirect loops", async () => {
    for (const location of [undefined, "/release-manifest.json"]) {
      let calls = 0;
      const manager = new ReleaseUpdateManager(
        "0.1.92",
        "unused",
        "https://updates.example.test/release-manifest.json",
        "win32",
        "x64",
      );
      const fetcher: typeof fetch = async () => {
        calls += 1;
        return new Response(null, {
          status: 302,
          headers: location ? { location } : {},
        });
      };
      await assert.rejects(
        manager.check(fetcher),
        /no destination|redirect limit/u,
      );
      assert.equal(calls, location ? 6 : 1);
    }
  });

  it("does not let a GitHub CDN redirect an installer to an unrelated host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-redirect-reject-"));
    directories.push(directory);
    const value = manifest(new TextEncoder().encode("installer"));
    const source =
      "https://github.com/example/bridge/releases/download/v0.2.0/release-manifest.json";
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === source) return new Response(JSON.stringify(value));
      const location = url.startsWith("https://github.com/")
        ? "https://release-assets.githubusercontent.com/installer"
        : "https://example.test/installer";
      return new Response(null, { status: 302, headers: { location } });
    };
    const manager = new ReleaseUpdateManager(
      "0.1.92",
      directory,
      source,
      "win32",
      "x64",
    );
    await manager.check(fetcher);
    await assert.rejects(manager.download(fetcher), /not allowed/u);
    assert.equal(calls.length, 3);
    assert.deepEqual(await readdir(directory), []);
    assert.equal(manager.status().phase, "failed");
  });

  it("checks, downloads and verifies a redirected HTTP release, then detects the installed and next versions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-http-update-"));
    directories.push(directory);
    const bytes = new TextEncoder().encode("chunked installer fixture");
    let version = "0.2.0";
    const server = createServer((request, response) => {
      const file = `CodexGPT-Bridge-Setup-${version}.exe`;
      if (request.url === "/latest/release-manifest.json") {
        response.writeHead(302, {
          location: `/download/v${version}/release-manifest.json`,
        });
        response.end();
      } else if (
        request.url === `/download/v${version}/release-manifest.json`
      ) {
        const value = manifest(bytes);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            ...value,
            version,
            artifacts: [{ ...value.artifacts[0], file, url: `./${file}` }],
          }),
        );
      } else if (request.url === `/download/v${version}/${file}`) {
        response.write(bytes.subarray(0, 5));
        response.end(bytes.subarray(5));
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const source = `http://127.0.0.1:${address.port}/latest/release-manifest.json`;
      const manager = new ReleaseUpdateManager(
        "0.1.92",
        directory,
        source,
        "win32",
        "x64",
      );
      assert.equal((await manager.check()).phase, "available");
      const ready = await manager.download();
      assert.equal(ready.phase, "ready");
      assert.deepEqual(
        await readFile(ready.downloadedPath!),
        Buffer.from(bytes),
      );
      await manager.verifyReadyArtifact();
      assert.equal(manager.markInstalling().phase, "installing");
      const installed = new ReleaseUpdateManager(
        "0.2.0",
        directory,
        source,
        "win32",
        "x64",
      );
      assert.equal((await installed.check()).phase, "up-to-date");
      version = "0.3.0";
      const next = await installed.check();
      assert.equal(next.phase, "available");
      assert.equal(next.availableVersion, "0.3.0");
      assert.equal((await installed.download()).phase, "ready");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("fails closed and leaves no installer on checksum mismatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexgpt-update-bad-"));
    directories.push(directory);
    const bytes = new TextEncoder().encode("tampered");
    const manager = new ReleaseUpdateManager(
      "0.1.64",
      directory,
      "https://updates.example.test/release-manifest.json",
      "win32",
      "x64",
    );
    const fetcher = async (url: string | URL | Request) =>
      String(url).endsWith("release-manifest.json")
        ? new Response(JSON.stringify(manifest(bytes, "0".repeat(64))))
        : new Response(bytes, {
            headers: { "content-length": String(bytes.byteLength) },
          });
    await manager.check(fetcher as typeof fetch);
    await assert.rejects(
      manager.download(fetcher as typeof fetch),
      /checksum/i,
    );
    assert.equal(manager.status().phase, "failed");
  });

  it("re-verifies the downloaded artifact immediately before install", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexgpt-update-recheck-"));
    directories.push(directory);
    const bytes = new TextEncoder().encode("verified installer");
    const manager = new ReleaseUpdateManager(
      "0.1.64",
      directory,
      "https://updates.example.test/release-manifest.json",
      "win32",
      "x64",
    );
    const fetcher = async (url: string | URL | Request) =>
      String(url).endsWith("release-manifest.json")
        ? new Response(JSON.stringify(manifest(bytes)))
        : new Response(bytes, {
            headers: { "content-length": String(bytes.byteLength) },
          });
    await manager.check(fetcher as typeof fetch);
    const ready = await manager.download(fetcher as typeof fetch);
    await writeFile(ready.downloadedPath!, "tampered");
    await assert.rejects(manager.verifyReadyArtifact(), /changed/i);
    assert.equal(manager.status().phase, "failed");
  });
});
