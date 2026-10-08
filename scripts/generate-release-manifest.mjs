import { Buffer } from "node:buffer";
import { createHash, sign as signPayload } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseDirectory = join(root, "release");
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const baseUrlValue = argumentValue("--base-url");
const baseUrl = baseUrlValue ? new URL(baseUrlValue) : undefined;
const signingKeyPath = argumentValue("--signing-key");
const signingKeyId = argumentValue("--key-id");
if ((signingKeyPath && !signingKeyId) || (!signingKeyPath && signingKeyId))
  throw new Error("--signing-key and --key-id must be provided together.");
if (signingKeyId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(signingKeyId))
  throw new Error("Release signing key id is invalid.");
if (baseUrl && baseUrl.protocol !== "https:")
  throw new Error("Release artifact base URLs must use HTTPS.");
const versionPattern = packageJson.version.replace(
  /[.*+?^${}()|[\]\\]/gu,
  "\\$&",
);

function artifactIdentity(file) {
  if (
    new RegExp(`^CodexGPT-Bridge-Setup-${versionPattern}\\.exe$`, "u").test(
      file,
    )
  )
    return { platform: "win32", arch: "x64", kind: "nsis" };
  const match = new RegExp(
    `^CodexGPT-Bridge-${versionPattern}-(x64|amd64|x86_64|arm64)\\.(dmg|zip|AppImage|deb)$`,
    "u",
  ).exec(file);
  if (!match) return undefined;
  const extension = match[2];
  return {
    platform: extension === "dmg" || extension === "zip" ? "darwin" : "linux",
    arch: ["amd64", "x86_64"].includes(match[1]) ? "x64" : match[1],
    kind: extension === "AppImage" ? "appimage" : extension,
  };
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const files = (await readdir(releaseDirectory)).sort();
const artifacts = [];
for (const file of files) {
  const identity = artifactIdentity(file);
  if (!identity) continue;
  const path = join(releaseDirectory, file);
  const sha256 = await sha256File(path);
  const size = (await stat(path)).size;
  await writeFile(`${path}.sha256`, `${sha256}  ${basename(path)}\n`, "utf8");
  artifacts.push({
    ...identity,
    file,
    size,
    sha256,
    url: baseUrl
      ? new URL(encodeURIComponent(file), baseUrl).toString()
      : `./${file}`,
  });
}
if (artifacts.length === 0)
  throw new Error("No packaged release artifacts were found.");
const epoch = process.env.SOURCE_DATE_EPOCH;
const publishedAt = epoch
  ? new Date(Number.parseInt(epoch, 10) * 1_000).toISOString()
  : new Date().toISOString();
const manifest = {
  schemaVersion: 1,
  version: packageJson.version,
  publishedAt,
  artifacts,
};
if (signingKeyPath && signingKeyId) {
  const privateKey = await readFile(resolve(signingKeyPath), "utf8");
  const signature = signPayload(
    null,
    Buffer.from(JSON.stringify(manifest), "utf8"),
    privateKey,
  ).toString("base64");
  manifest.signature = {
    algorithm: "ed25519",
    keyId: signingKeyId,
    value: signature,
  };
}
await writeFile(
  join(releaseDirectory, "release-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
process.stdout.write(
  `Release manifest written for ${artifacts.length} artifact(s).\n`,
);
