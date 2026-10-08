import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import vm from "node:vm";
import ts from "typescript";

const sourcePath = resolve("apps/desktop/src/renderer/i18n.ts");
const source = await readFile(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourcePath,
});
const sandbox = { exports: {} };
vm.runInNewContext(compiled.outputText, sandbox, { filename: sourcePath });
const catalogs = sandbox.exports.CATALOGS;
if (!catalogs || typeof catalogs !== "object")
  throw new Error("Unable to load renderer translation catalogs.");

const englishKeys = Object.keys(catalogs.en).sort();
const placeholders = (value) =>
  [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/gu)]
    .map((match) => match[1])
    .sort();
for (const locale of ["zh-TW", "zh-CN", "ja", "ko"]) {
  const catalog = catalogs[locale];
  if (!catalog) throw new Error(`Missing ${locale} catalog.`);
  const keys = Object.keys(catalog).sort();
  if (JSON.stringify(keys) !== JSON.stringify(englishKeys))
    throw new Error(`${locale} catalog keys do not match English.`);
  for (const key of englishKeys) {
    const value = catalog[key];
    if (typeof value !== "string" || value.trim().length === 0)
      throw new Error(`${locale}.${key} is empty.`);
    if (
      JSON.stringify(placeholders(value)) !==
      JSON.stringify(placeholders(catalogs.en[key]))
    )
      throw new Error(`${locale}.${key} has mismatched placeholders.`);
  }
}
process.stdout.write(
  `Verified ${englishKeys.length} translation keys across en, zh-TW, zh-CN, ja and ko.\n`,
);
