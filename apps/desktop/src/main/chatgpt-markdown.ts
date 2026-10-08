export interface ChatGptDomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly textContent?: string | null;
  readonly childNodes?: ArrayLike<ChatGptDomNode>;
  getAttribute?(name: string): string | null;
}

/**
 * Reconstruct Markdown from ChatGPT's rendered response DOM.
 *
 * This function is intentionally self-contained because its source is injected into the
 * ChatGPT renderer with `Function#toString`. Keep all helpers nested inside this function.
 */
export function chatGptDomToMarkdown(root: ChatGptDomNode): string {
  const literalBlocks: string[] = [];
  function childrenOf(node: ChatGptDomNode): ChatGptDomNode[] {
    return node.childNodes ? Array.from(node.childNodes) : [];
  }

  function tagOf(node: ChatGptDomNode): string {
    return (node.nodeName || "").toLowerCase();
  }

  function rawText(node: ChatGptDomNode): string {
    if (node.nodeType === 3) return node.textContent || "";
    if (tagOf(node) === "br") return "\n";
    return childrenOf(node).map(rawText).join("");
  }

  function hasClass(node: ChatGptDomNode, name: string): boolean {
    return (node.getAttribute?.("class") || "").split(/\s+/u).includes(name);
  }

  function protectLiteral(value: string): string {
    const index = literalBlocks.push(value) - 1;
    return `\u0000BRIDGE_LITERAL_${index}\u0000`;
  }

  function mathSource(node: ChatGptDomNode): string | undefined {
    const sources: string[] = [];
    function collect(parent: ChatGptDomNode): void {
      if (
        tagOf(parent) === "annotation" &&
        parent.getAttribute?.("encoding") === "application/x-tex"
      ) {
        sources.push(rawText(parent));
        return;
      }
      for (const child of childrenOf(parent)) collect(child);
    }
    collect(node);
    return sources.length === 1 ? sources[0] : undefined;
  }

  function codeIn(node: ChatGptDomNode): ChatGptDomNode | undefined {
    if (tagOf(node) === "code") return node;
    for (const child of childrenOf(node)) {
      const code = codeIn(child);
      if (code) return code;
    }
    return undefined;
  }

  function inlineCode(value: string): string {
    const longestRun = Math.max(
      0,
      ...Array.from(value.matchAll(/`+/gu), (match) => match[0].length),
    );
    const fence = "`".repeat(Math.max(1, longestRun + 1));
    const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
    return `${fence}${padding}${value}${padding}${fence}`;
  }

  function codeBlock(node: ChatGptDomNode): string {
    // Current ChatGPT blocks can use nested scroll wrappers with or without pre.
    // Language labels and toolbar controls are not part of the code source.
    const codeNode = codeIn(node);
    const code = rawText(codeNode ?? node)
      .replace(/\r\n?/gu, "\n")
      .trimEnd();
    const longestRun = Math.max(
      0,
      ...Array.from(code.matchAll(/`+/gu), (match) => match[0].length),
    );
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    const className =
      codeNode?.getAttribute?.("class") || node.getAttribute?.("class") || "";
    const language = className.match(/(?:^|\s)language-([^\s]+)/u)?.[1] || "";
    return `\n\n${protectLiteral(`${fence}${language}\n${code}\n${fence}`)}\n\n`;
  }

  function renderChildren(node: ChatGptDomNode, listDepth: number): string {
    return childrenOf(node)
      .map((child) => render(child, listDepth))
      .join("");
  }

  function renderTable(node: ChatGptDomNode, listDepth: number): string {
    const rows: ChatGptDomNode[] = [];
    function collectRows(parent: ChatGptDomNode): void {
      for (const child of childrenOf(parent)) {
        if (tagOf(child) === "tr") rows.push(child);
        else collectRows(child);
      }
    }
    collectRows(node);
    if (rows.length === 0) return "";

    const rowCells = rows.map((row) =>
      childrenOf(row).filter((child) => {
        const tag = tagOf(child);
        return tag === "th" || tag === "td";
      }),
    );
    const columnCount = Math.max(0, ...rowCells.map((cells) => cells.length));
    if (columnCount === 0) return "";

    const values = rowCells.map((cells) =>
      Array.from({ length: columnCount }, (_, index) => {
        const cell = cells[index];
        if (!cell) return "";
        return renderChildren(cell, listDepth)
          .trim()
          .replace(/\|/gu, "\\|")
          .replace(/\s*\n+\s*/gu, "<br>");
      }),
    );
    const hasHeader =
      rowCells[0]?.some((cell) => tagOf(cell) === "th") ?? false;
    const header = hasHeader
      ? (values[0] ?? Array.from({ length: columnCount }, () => ""))
      : Array.from({ length: columnCount }, () => "");
    const body = hasHeader ? values.slice(1) : values;
    const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
    return `\n\n${[
      line(header),
      line(Array.from({ length: columnCount }, () => "---")),
      ...body.map(line),
    ].join("\n")}\n\n`;
  }

  function render(node: ChatGptDomNode, listDepth: number): string {
    if (node.nodeType === 3) {
      return (node.textContent || "")
        .replace(/\u00a0/gu, " ")
        .replace(/\s+/gu, " ");
    }
    if (node.nodeType !== 1) return "";

    const tag = tagOf(node);
    const children = () => renderChildren(node, listDepth);
    // Modern blocks have a copy boundary but can omit both pre and language classes.
    // Read the code source once, excluding the localized header and toolbar.
    if (node.getAttribute?.("data-markdown-copy") === "code-block")
      return codeBlock(node);
    // KaTeX exposes visual HTML, accessibility MathML and a TeX annotation.
    // Reconstruct one formula from the annotation rather than concatenating layers.
    const displayMath = hasClass(node, "katex-display");
    if (displayMath || hasClass(node, "katex")) {
      const source = mathSource(node);
      if (source !== undefined) {
        return displayMath
          ? `\n\n${protectLiteral(`\\[\n${source}\n\\]`)}\n\n`
          : protectLiteral(`\\(${source}\\)`);
      }
    }
    // Current ChatGPT renders inline code as a span with this copy marker.
    if (node.getAttribute?.("data-markdown-copy") === "inline-code")
      return inlineCode(rawText(node));
    switch (tag) {
      case "br":
        return "\n";
      case "hr":
        return "\n\n---\n\n";
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const level = Number(tag.slice(1));
        return `\n\n${"#".repeat(level)} ${children().trim()}\n\n`;
      }
      case "p":
      case "div":
      case "section":
      case "article":
      case "main":
      case "header":
      case "footer": {
        const content = children().trim();
        return content ? `\n\n${content}\n\n` : "";
      }
      case "strong":
      case "b": {
        const content = children().trim();
        return content ? `**${content}**` : "";
      }
      case "em":
      case "i": {
        const content = children().trim();
        return content ? `*${content}*` : "";
      }
      case "del":
      case "s": {
        const content = children().trim();
        return content ? `~~${content}~~` : "";
      }
      case "code":
        if (
          /(?:^|\s)language-[^\s]+/u.test(node.getAttribute?.("class") ?? "") ||
          /[\r\n]/u.test(rawText(node))
        )
          return codeBlock(node);
        return inlineCode(rawText(node));
      case "pre":
        return codeBlock(node);
      case "blockquote": {
        const content = children().trim();
        return content
          ? `\n\n${content
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n")}\n\n`
          : "";
      }
      case "ul":
      case "ol": {
        const ordered = tag === "ol";
        const start =
          Number.parseInt(node.getAttribute?.("start") || "1", 10) || 1;
        const items = childrenOf(node).filter((child) => tagOf(child) === "li");
        const lines = items.map((item, index) => {
          const marker = ordered ? `${start + index}. ` : "- ";
          const indent = " ".repeat(marker.length);
          const content = renderChildren(item, listDepth + 1).trim();
          return `${marker}${content.replace(/\n/gu, `\n${indent}`)}`;
        });
        return lines.length > 0 ? `\n\n${lines.join("\n")}\n\n` : "";
      }
      case "li":
        return children();
      case "table":
        return renderTable(node, listDepth);
      case "a": {
        const content = children().trim();
        const href = node.getAttribute?.("href") || "";
        if (!content || !href || /^javascript:/iu.test(href)) return content;
        return `[${content}](${href})`;
      }
      case "img":
      case "button":
      case "svg":
      case "script":
      case "style":
        return "";
      case "sup":
      case "sub":
      case "kbd": {
        const content = children().trim();
        return content ? `<${tag}>${content}</${tag}>` : "";
      }
      default:
        return children();
    }
  }

  return render(root, 0)
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .replace(
      // eslint-disable-next-line no-control-regex -- Internal sentinels protect code and TeX whitespace from prose normalization.
      /\u0000BRIDGE_LITERAL_(\d+)\u0000/g,
      (_match, index: string, offset: number, body: string) => {
        const prefix = body.slice(
          body.lastIndexOf("\n", offset - 1) + 1,
          offset,
        );
        const indent = /^[ \t]*$/u.test(prefix) ? prefix : "";
        return (literalBlocks[Number(index)] ?? "").replace(
          /\n/gu,
          `\n${indent}`,
        );
      },
    );
}
