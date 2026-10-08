import { createRequire } from "node:module";
import process from "node:process";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const seen = new Set();
const sections = [];
async function visit(directory) {
  directory = await realpath(directory);
  if (seen.has(directory)) return;
  seen.add(directory);
  const manifest = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  );
  if (
    !manifest.name.startsWith("@codexgpt-bridge/") &&
    manifest.name !== "codexgpt-bridge"
  ) {
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter(
        (file) =>
          file.isFile() &&
          /^(licen[sc]e|copying|notice)(?:[._-]|$)/i.test(file.name),
      )
      .map((file) => file.name)
      .sort();
    if (
      !files.length &&
      manifest.name === "tiktoken" &&
      manifest.version === "1.0.22"
    )
      files.push("bridge-license-override");
    if (!files.length)
      throw new Error(
        `License text missing for ${manifest.name}@${manifest.version}`,
      );
    const text = await Promise.all(
      files.map(
        async (file) =>
          `${file}\n${await readFile(file === "bridge-license-override" ? join(root, "LICENSES", "tiktoken-MIT.txt") : join(directory, file), "utf8")}`,
      ),
    );
    sections.push(
      `${manifest.name}@${manifest.version} (${typeof manifest.license === "string" ? manifest.license : (manifest.license?.type ?? "see license")})\n${text.join("\n\n")}`,
    );
  }
  const require = createRequire(join(directory, "package.json"));
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    let dependencyDirectory;
    try {
      dependencyDirectory = dirname(
        require.resolve(`${dependency}/package.json`),
      );
    } catch (error) {
      if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
      dependencyDirectory = dirname(require.resolve(dependency));
      while (true) {
        try {
          if (
            JSON.parse(
              await readFile(join(dependencyDirectory, "package.json"), "utf8"),
            ).name === dependency
          )
            break;
        } catch {
          /* entry point is nested */
        }
        const parent = dirname(dependencyDirectory);
        if (parent === dependencyDirectory)
          throw new Error(`Package root missing: ${dependency}`, {
            cause: error,
          });
        dependencyDirectory = parent;
      }
    }
    await visit(dependencyDirectory);
  }
}
await visit(root);
await visit(join(root, "apps", "desktop"));
sections.sort();
await writeFile(
  join(root, "THIRD_PARTY_NOTICES.txt"),
  `CodexGPT Bridge — third-party notices\n\nRuntime dependencies and bundled renderer dependencies. Electron and Chromium notices are provided in resources/licenses.\n\n${sections.join("\n\n" + "=".repeat(80) + "\n\n")}\n`,
  "utf8",
);
process.stdout.write(`Generated notices for ${sections.length} packages.\n`);
