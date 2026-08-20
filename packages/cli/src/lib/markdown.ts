// Models answer in markdown whether or not anything renders it, so an unstyled
// reply reaches the user as literal `**bold**` and `### Heading`.
//
// OpenTUI ships a <markdown> element, but it renders every block through a
// CodeRenderable that needs web-tree-sitter and its wasm grammars. That is a
// peer dependency TermKode does not carry, and shipping wasm assets inside a
// `bun build --compile` binary is exactly the kind of thing that works locally
// and fails on a user's machine. This parser covers the subset models actually
// emit, in plain TypeScript, with nothing to load at runtime.

export type InlineStyle = {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  /** Set on the text of a link; the URL is rendered after the label. */
  link?: string;
};

export type InlineSpan = InlineStyle & { text: string };

export type MarkdownBlock =
  | { kind: "heading"; level: number; spans: InlineSpan[] }
  | { kind: "paragraph"; spans: InlineSpan[] }
  | { kind: "list-item"; marker: string; depth: number; spans: InlineSpan[] }
  | { kind: "code"; language: string; lines: string[] }
  | { kind: "quote"; spans: InlineSpan[] }
  | { kind: "table"; header: InlineSpan[][]; rows: InlineSpan[][][] }
  | { kind: "rule" };

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_DIVIDER = /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/;

// A tab is worth this many columns when working out how deeply a list nests.
const TAB_WIDTH = 4;
const INDENT_PER_LEVEL = 2;

function indentWidth(indent: string) {
  let width = 0;
  for (const character of indent) {
    width += character === "\t" ? TAB_WIDTH : 1;
  }
  return width;
}

function splitTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

/**
 * Splits a line into styled runs. Nesting is handled by recursion, so
 * `**bold with `code`**` keeps both styles on the inner run.
 */
export function parseInline(text: string, base: InlineStyle = {}): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let buffer = "";
  let index = 0;

  const flush = () => {
    if (buffer) {
      spans.push({ ...base, text: buffer });
      buffer = "";
    }
  };

  const push = (inner: string, style: InlineStyle) => {
    flush();
    spans.push(...parseInline(inner, { ...base, ...style }));
  };

  while (index < text.length) {
    const rest = text.slice(index);

    // A backslash escape is the author saying "this marker is literal".
    if (rest.startsWith("\\") && rest.length > 1) {
      buffer += rest[1];
      index += 2;
      continue;
    }

    // Code spans win over everything: their content is never markup.
    const code = rest.match(/^(`+)([\s\S]*?)\1/);
    if (code?.[2] !== undefined) {
      flush();
      spans.push({ ...base, code: true, text: code[2] });
      index += code[0].length;
      continue;
    }

    const link = rest.match(/^\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/);
    if (link?.[1] !== undefined && link[2]) {
      push(link[1], { link: link[2] });
      index += link[0].length;
      continue;
    }

    const bold = rest.match(/^(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/);
    if (bold?.[2]) {
      push(bold[2], { bold: true });
      index += bold[0].length;
      continue;
    }

    const strike = rest.match(/^~~(?=\S)([\s\S]+?)(?<=\S)~~/);
    if (strike?.[1]) {
      push(strike[1], { strike: true });
      index += strike[0].length;
      continue;
    }

    const asteriskItalic = rest.match(/^\*(?=\S)([^*]+?)(?<=\S)\*/);
    if (asteriskItalic?.[1]) {
      push(asteriskItalic[1], { italic: true });
      index += asteriskItalic[0].length;
      continue;
    }

    // `snake_case_names` are far more common in a coding session than
    // underscore emphasis, so `_` only opens emphasis at a word boundary.
    const previous = index === 0 ? "" : text[index - 1]!;
    if (!/[A-Za-z0-9_]/.test(previous)) {
      const underscoreItalic = rest.match(/^_(?=\S)([^_]+?)(?<=\S)_(?![A-Za-z0-9_])/);
      if (underscoreItalic?.[1]) {
        push(underscoreItalic[1], { italic: true });
        index += underscoreItalic[0].length;
        continue;
      }
    }

    buffer += rest[0];
    index += 1;
  }

  flush();
  return spans;
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];

  let paragraph: string[] = [];
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", spans: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };

  const flushQuote = () => {
    if (quote.length === 0) return;
    blocks.push({ kind: "quote", spans: parseInline(quote.join(" ")) });
    quote = [];
  };

  const flushAll = () => {
    flushParagraph();
    flushQuote();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    const fence = line.match(FENCE);
    if (fence?.[1]) {
      flushAll();

      const marker = fence[1][0]!;
      const closing = new RegExp(`^ {0,3}${marker === "`" ? "`" : "~"}{${fence[1].length},}\\s*$`);
      const body: string[] = [];

      index += 1;
      while (index < lines.length && !closing.test(lines[index]!)) {
        body.push(lines[index]!);
        index += 1;
      }

      blocks.push({ kind: "code", language: fence[2] ?? "", lines: body });
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    if (RULE.test(line)) {
      flushAll();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading?.[1]) {
      flushAll();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        spans: parseInline(heading[2] ?? ""),
      });
      continue;
    }

    const quoted = line.match(QUOTE);
    if (quoted) {
      flushParagraph();
      quote.push(quoted[1] ?? "");
      continue;
    }

    // A table needs its divider row to be a table at all; without one the
    // pipes are just characters in a paragraph.
    if (TABLE_ROW.test(line) && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]!)) {
      flushAll();

      const header = splitTableRow(line).map((cell) => parseInline(cell));
      const rows: InlineSpan[][][] = [];
      index += 2;

      while (index < lines.length && TABLE_ROW.test(lines[index]!)) {
        rows.push(splitTableRow(lines[index]!).map((cell) => parseInline(cell)));
        index += 1;
      }
      index -= 1;

      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item?.[2]) {
      flushAll();
      blocks.push({
        kind: "list-item",
        marker: /\d/.test(item[2]) ? item[2] : "•",
        depth: Math.floor(indentWidth(item[1] ?? "") / INDENT_PER_LEVEL),
        spans: parseInline(item[3] ?? ""),
      });
      continue;
    }

    flushQuote();
    paragraph.push(line.trim());
  }

  flushAll();
  return blocks;
}

/** Flattens spans back to plain text, for widths and for tests. */
export function spansToText(spans: InlineSpan[]): string {
  return spans.map((span) => span.text).join("");
}
