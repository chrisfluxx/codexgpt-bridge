import { glob, readFile, stat } from "node:fs/promises";
import process from "node:process";

const includePatterns = [
  ".github/**/*",
  "apps/**/*",
  "docs/**/*",
  "packages/**/*",
  "patches/**/*",
  "scripts/**/*",
  "*.json",
  "*.md",
  "*.mjs",
  "*.yaml",
  "*.yml",
];
const excludedFragments = ["/dist/", "/node_modules/", "/release/"];
const signatures = [
  { name: "private key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "OpenAI-style key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
];

const files = new Set();
for (const pattern of includePatterns) {
  for await (const entry of glob(pattern)) {
    const normalized = entry.replaceAll("\\", "/");
    if (excludedFragments.some((fragment) => normalized.includes(fragment)))
      continue;
    if ((await stat(entry)).isFile()) files.add(entry);
  }
}

const findings = [];
for (const file of [...files].sort()) {
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch {
    continue;
  }
  for (const signature of signatures) {
    if (signature.regex.test(content)) {
      findings.push(`${file}: ${signature.name}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`Secret scan failed:\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Secret scan passed (${files.size} files checked).\n`);
}
