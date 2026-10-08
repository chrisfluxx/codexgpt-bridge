import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const publicDocuments = new Set([
  "README.md",
  "README.zh-TW.md",
  "README.zh-CN.md",
  "README.ja.md",
  "README.ko.md",
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
]);
const rootFiles = new Set([
  ".gitattributes",
  ".gitignore",
  ".prettierignore",
  "eslint.config.mjs",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
  "THIRD_PARTY_NOTICES.txt",
  ...publicDocuments,
]);
const publicDirectories = new Set([
  ".github",
  "apps",
  "packages",
  "scripts",
  "assets",
  "LICENSES",
  "test-fixtures",
]);
const generatedDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "release",
]);
const publicImages = new Set([
  "assets/bridge-icon.ico",
  "assets/bridge-icon.icns",
  "assets/bridge-icon.png",
  "apps/desktop/src/renderer/public/bridge-icon.png",
]);
const removedProjectIdentifier = /\b(?:codex|code)[-_ ]*chatgpt[-_ ]*web/iu;
const signatures = [
  {
    name: "removed project identifier",
    regex: removedProjectIdentifier,
  },
  { name: "private key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { name: "API key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
  { name: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u },
  {
    name: "GitHub fine-grained token",
    regex: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/u,
  },
  { name: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u },
  {
    name: "personal Windows path",
    regex: /\bC:[\\/]+Users[\\/]+(?:Administrator|ADMINI~1)(?:[\\/]|\b)/iu,
  },
];

function pathProblem(file) {
  if (removedProjectIdentifier.test(file)) return "removed project identifier";
  const parts = file.split("/");
  if (
    parts.some((part) =>
      [
        "docs",
        "research",
        "notes",
        "internal",
        "secrets",
        "credentials",
        "user-data",
        "browser-profiles",
        "chatgpt-profile",
        ".codex",
        ".serena",
        ".playwright",
        "work",
        "backup",
        "reports",
      ].includes(part),
    )
  )
    return "private directory";
  if (/\.(?:md|mdx)$/iu.test(file) && !publicDocuments.has(file))
    return "unapproved document";
  if (
    /(?:^|\/)(?:\.env(?:\.|$)|storage-state.*\.json$|cookies.*\.json$|settings\.json$|chatgpt-conversations.*\.json$|bridge-doctor.*\.json$)|\.(?:pem|key|p12|pfx|log|jsonl|sqlite3?|db|zip|exe|map|tsbuildinfo)$/iu.test(
      file,
    )
  )
    return "private data or generated output";
  if (
    /^scripts\/(?:live-|inspect-|compare-embedded-|apply-webgpt-|launch-bridge-with-|open-live-|prepare-live-|webgpt-session-|test-packaged-|probe-|close-owned-)/u.test(
      file,
    )
  )
    return "personal development helper";
  if (
    /\.(?:png|jpe?g|gif|webp|ico|icns)$/iu.test(file) &&
    !publicImages.has(file)
  )
    return "unapproved image";
  if (parts.length === 1 && !rootFiles.has(file)) return "unapproved root file";
  if (parts.length > 1 && !publicDirectories.has(parts[0]))
    return "unapproved directory";
  return undefined;
}

const findings = new Set();
const diskFiles = new Set();
async function walk(directory = "") {
  for (const entry of await readdir(resolve(root, directory), {
    withFileTypes: true,
  })) {
    const file = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory() && generatedDirectories.has(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      findings.add(`${file}: symbolic link`);
      continue;
    }
    if (entry.isDirectory()) await walk(file);
    else if (entry.isFile() && !entry.name.endsWith(".tsbuildinfo"))
      diskFiles.add(file);
  }
}
await walk();
const gitFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const files = [...new Set([...diskFiles, ...gitFiles])].sort();
for (const file of files) {
  const target = resolve(root, file);
  if (!target.startsWith(root + sep)) {
    findings.add(`${file}: path outside repository`);
    continue;
  }
  const problem = pathProblem(file);
  if (problem) findings.add(`${file}: ${problem}`);
  if (!diskFiles.has(file) || publicImages.has(file)) continue;
  const bytes = await readFile(target);
  if (bytes.includes(0)) {
    findings.add(`${file}: unapproved binary file`);
    continue;
  }
  const content = bytes.toString("utf8");
  for (const signature of signatures) {
    if (signature.regex.test(content))
      findings.add(`${file}: ${signature.name}`);
  }
}
if (findings.size) {
  process.stderr.write(
    `Public content check failed:\n${[...findings].sort().join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Public content check passed (${gitFiles.length} publication files, ${diskFiles.size} source files checked).\n`,
  );
}
