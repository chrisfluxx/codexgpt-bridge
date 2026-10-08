import { Buffer } from "node:buffer";
import { createHash, verify as verifyPayload } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseDirectory = join(root, "release");
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const manifest = JSON.parse(
  await readFile(join(releaseDirectory, "release-manifest.json"), "utf8"),
);
const publicKeyArgument = process.argv.indexOf("--public-key");
const publicKeyPath =
  publicKeyArgument >= 0 ? process.argv[publicKeyArgument + 1] : undefined;
if (
  manifest?.schemaVersion !== 1 ||
  manifest.version !== packageJson.version ||
  typeof manifest.publishedAt !== "string" ||
  !Number.isFinite(Date.parse(manifest.publishedAt)) ||
  !Array.isArray(manifest.artifacts) ||
  manifest.artifacts.length === 0 ||
  manifest.artifacts.length > 32
)
  throw new Error("Release manifest schema is invalid.");
if (manifest.signature !== undefined) {
  if (
    manifest.signature?.algorithm !== "ed25519" ||
    typeof manifest.signature.keyId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(manifest.signature.keyId) ||
    typeof manifest.signature.value !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/u.test(manifest.signature.value)
  )
    throw new Error("Release manifest signature is invalid.");
}
if (publicKeyPath) {
  if (!manifest.signature)
    throw new Error("Release manifest signature is required.");
  const publicKey = await readFile(resolve(publicKeyPath), "utf8");
  const unsigned = {
    schemaVersion: manifest.schemaVersion,
    version: manifest.version,
    publishedAt: manifest.publishedAt,
    artifacts: manifest.artifacts.map((artifact) => ({
      platform: artifact.platform,
      arch: artifact.arch,
      kind: artifact.kind,
      file: artifact.file,
      size: artifact.size,
      sha256: artifact.sha256,
      url: artifact.url,
    })),
  };
  if (
    !verifyPayload(
      null,
      Buffer.from(JSON.stringify(unsigned), "utf8"),
      publicKey,
      Buffer.from(manifest.signature.value, "base64"),
    )
  )
    throw new Error("Release manifest signature verification failed.");
}
const identities = new Set();
const platforms = new Set(["win32", "darwin", "linux"]);
const arches = new Set(["x64", "arm64"]);
const kinds = new Set(["nsis", "dmg", "zip", "appimage", "deb"]);
async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
for (const artifact of manifest.artifacts) {
  if (
    !artifact ||
    typeof artifact !== "object" ||
    !platforms.has(artifact.platform) ||
    !arches.has(artifact.arch) ||
    !kinds.has(artifact.kind) ||
    typeof artifact.file !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+()-]{0,199}$/u.test(artifact.file) ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size <= 0 ||
    typeof artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
    typeof artifact.url !== "string"
  )
    throw new Error("Release artifact fields are invalid.");
  const remote = new URL(
    artifact.url,
    "https://updates.example.invalid/release-manifest.json",
  );
  if (remote.protocol !== "https:" || remote.username || remote.password)
    throw new Error(`Unsafe release artifact URL: ${artifact.file}`);
  const identity = `${artifact.platform}:${artifact.arch}:${artifact.kind}`;
  if (identities.has(identity))
    throw new Error(`Duplicate release artifact identity: ${identity}`);
  identities.add(identity);
  const path = join(releaseDirectory, artifact.file);
  const size = (await stat(path)).size;
  const sha256 = await sha256File(path);
  if (size !== artifact.size || sha256 !== artifact.sha256)
    throw new Error(`Release artifact verification failed: ${artifact.file}`);
  const checksum = await readFile(`${path}.sha256`, "utf8");
  if (checksum !== `${sha256}  ${artifact.file}\n`)
    throw new Error(`Adjacent checksum verification failed: ${artifact.file}`);
}
if (process.argv.includes("--require-complete")) {
  const expected = [
    "win32:x64:nsis",
    ...["x64", "arm64"].flatMap((arch) => [
      `darwin:${arch}:dmg`,
      `darwin:${arch}:zip`,
      `linux:${arch}:appimage`,
      `linux:${arch}:deb`,
    ]),
  ];
  const missing = expected.filter((identity) => !identities.has(identity));
  if (missing.length)
    throw new Error(`Release artifacts are missing: ${missing.join(", ")}`);
}
process.stdout.write(
  `Verified ${manifest.artifacts.length} release artifact(s).\n`,
);
