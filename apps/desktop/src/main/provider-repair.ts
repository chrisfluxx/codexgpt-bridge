const START = "# >>> CodexGPT Bridge managed Web provider";
const END = "# <<< CodexGPT Bridge managed Web provider";

export interface ProviderRepairPlan {
  readonly previousRoute: string;
  readonly previousRouteUrl: string;
  readonly nextBlock: string;
  readonly preservedText: string;
}

/** An explicit repair changes only Bridge's two assignments; added settings survive removal. */
export function planProviderRepair(
  block: string,
  baseUrl: string,
  catalogPath: string,
): ProviderRepairPlan {
  const ending = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.trimEnd().split(/\r?\n/u);
  if (lines.shift() !== START || lines.pop() !== END) {
    throw new Error("The Bridge provider block is incomplete.");
  }
  let previousRoute: string | undefined;
  let previousRouteUrl = "";
  let catalog: string | undefined;
  const preserved: string[] = [];
  for (const line of lines) {
    if (/^\s*\[/u.test(line)) {
      throw new Error(
        "A TOML table was added inside the Bridge provider block; repair cannot move it safely.",
      );
    }
    const assignment =
      /^\s*(openai_base_url|model_catalog_json)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/u.exec(
        line,
      );
    if (!assignment) {
      if (/^\s*(openai_base_url|model_catalog_json)\s*=/u.test(line)) {
        throw new Error(
          "The Bridge route or catalog assignment is not a supported TOML string.",
        );
      }
      preserved.push(line);
      continue;
    }
    const literal = assignment[2]!;
    const value = literal.startsWith("'")
      ? literal.slice(1, -1)
      : (JSON.parse(literal) as string);
    if (assignment[1] === "openai_base_url") {
      if (previousRoute !== undefined)
        throw new Error("Duplicate Codex route assignments prevent repair.");
      previousRoute = `${line}${ending}`;
      previousRouteUrl = value;
    } else {
      if (catalog !== undefined)
        throw new Error("Duplicate Codex catalog assignments prevent repair.");
      catalog = value;
    }
  }
  if (previousRoute === undefined || catalog !== catalogPath) {
    throw new Error(
      "The active model catalog no longer belongs to Bridge; repair cannot replace it.",
    );
  }
  return {
    previousRoute,
    previousRouteUrl,
    nextBlock: [
      START,
      `openai_base_url = ${JSON.stringify(baseUrl)}`,
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      END,
      "",
    ].join(ending),
    preservedText: preserved.length ? preserved.join(ending) + ending : "",
  };
}
