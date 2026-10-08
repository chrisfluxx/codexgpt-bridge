import { Ajv, type ValidateFunction, type Options } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import formatsModule from "ajv-formats";

const options: Options = {
  strict: false,
  allErrors: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  validateFormats: true,
  addUsedSchema: false,
  logger: false,
};
const addFormats = formatsModule.default ?? formatsModule;
const validators = [
  new Ajv(options),
  new Ajv2019(options),
  new Ajv2020(options),
];
for (const validator of validators) addFormats(validator);
const cache = new Map<string, ValidateFunction>();

export function toolArgumentValidator(
  schema: Record<string, unknown>,
): ValidateFunction {
  const key = JSON.stringify(schema);
  const cached = cache.get(key);
  if (cached) return cached;
  const dialect = schema.$schema;
  const index =
    typeof dialect === "string" && dialect.includes("2020-12")
      ? 2
      : typeof dialect === "string" && dialect.includes("2019-09")
        ? 1
        : 0;
  const engine = validators[index]!;
  let validate: ValidateFunction;
  try {
    validate = engine.compile(schema);
    if ("$async" in validate && validate.$async)
      throw new Error("Async tool schemas are unsupported.");
  } catch {
    throw new Error("Invalid or unsupported Codex tool parameter schema.");
  } finally {
    // Bound both our cache and Ajv's schema-object cache. No remote schema fetching.
    engine.removeSchema(schema);
  }
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(key, validate);
  return validate;
}

export function responseFormatValidator(
  schema: Record<string, unknown>,
): ValidateFunction {
  try {
    return toolArgumentValidator(schema);
  } catch (error) {
    throw new Error("Invalid or unsupported Responses output schema.", {
      cause: error,
    });
  }
}

export function validateToolArguments(
  name: string,
  schema: Record<string, unknown>,
  args: unknown,
): void {
  const validate = toolArgumentValidator(schema);
  if (!validate(args)) {
    const error = validate.errors?.[0];
    // Report the rule and path, never echo argument values (commands may contain secrets).
    throw new Error(
      `Codex tool ${name} arguments failed schema validation: ${error?.instancePath || "/"} ${error?.keyword ?? "invalid"}.`,
    );
  }
}
