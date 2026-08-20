import { describe, expect, test } from "bun:test";
import {
  parseInline,
  parseMarkdown,
  spansToText,
  type InlineSpan,
  type MarkdownBlock,
} from "./markdown";

function kinds(blocks: MarkdownBlock[]) {
  return blocks.map((block) => block.kind);
}

/** Reads the inline content of a block, failing loudly if it carries none. */
function spansOf(block: MarkdownBlock | undefined): InlineSpan[] {
  if (!block || !("spans" in block)) {
    throw new Error(`expected a block with spans, got ${block?.kind ?? "nothing"}`);
  }
  return block.spans;
}

describe("parseInline", () => {
  test("marks bold text and drops its markers", () => {
    const spans = parseInline("Total: **16 GB usable** today");

    expect(spansToText(spans)).toBe("Total: 16 GB usable today");
    expect(spans.find((span) => span.bold)?.text).toBe("16 GB usable");
  });

  test("handles both bold spellings", () => {
    expect(parseInline("__bold__").find((span) => span.bold)?.text).toBe("bold");
    expect(parseInline("**bold**").find((span) => span.bold)?.text).toBe("bold");
  });

  test("marks italic text", () => {
    expect(parseInline("an *emphasised* word").find((span) => span.italic)?.text).toBe(
      "emphasised",
    );
  });

  test("leaves snake_case identifiers alone", () => {
    const spans = parseInline("call read_file_sync now");

    expect(spansToText(spans)).toBe("call read_file_sync now");
    expect(spans.some((span) => span.italic)).toBe(false);
  });

  test("leaves a bare asterisk alone", () => {
    expect(spansToText(parseInline("2 * 3 = 6"))).toBe("2 * 3 = 6");
  });

  test("marks inline code and keeps its contents literal", () => {
    const spans = parseInline("run `bun test --watch` now");

    expect(spans.find((span) => span.code)?.text).toBe("bun test --watch");
    expect(spansToText(spans)).toBe("run bun test --watch now");
  });

  test("does not treat markers inside code as markup", () => {
    const spans = parseInline("`**not bold**`");

    expect(spans).toHaveLength(1);
    expect(spans[0]!.code).toBe(true);
    expect(spans[0]!.text).toBe("**not bold**");
  });

  test("keeps both styles when they nest", () => {
    const spans = parseInline("**bold with `code` inside**");

    expect(spans.every((span) => span.bold)).toBe(true);
    expect(spans.find((span) => span.code)?.text).toBe("code");
  });

  test("marks strikethrough", () => {
    expect(parseInline("~~gone~~").find((span) => span.strike)?.text).toBe("gone");
  });

  test("keeps a link label and records its target", () => {
    const spans = parseInline("see [the docs](https://example.com/x) for more");

    expect(spansToText(spans)).toBe("see the docs for more");
    expect(spans.find((span) => span.link)?.link).toBe("https://example.com/x");
  });

  test("honours a backslash escape", () => {
    expect(spansToText(parseInline("literal \\*stars\\*"))).toBe("literal *stars*");
  });

  test("leaves an unclosed marker as text, which is what streaming produces", () => {
    expect(spansToText(parseInline("**half written"))).toBe("**half written");
  });
});

describe("parseMarkdown", () => {
  test("reads headings and their level", () => {
    const [heading] = parseMarkdown("### Your installed RAM");

    expect(heading).toMatchObject({ kind: "heading", level: 3 });
    expect(spansToText(spansOf(heading))).toBe("Your installed RAM");
  });

  test("joins wrapped lines into one paragraph", () => {
    const blocks = parseMarkdown("first line\nsecond line\n\nnew paragraph");

    expect(kinds(blocks)).toEqual(["paragraph", "paragraph"]);
    expect(spansToText(spansOf(blocks[0]))).toBe("first line second line");
  });

  test("reads bullet lists", () => {
    const blocks = parseMarkdown("- **Total:** 16 GB\n- **Speed:** 2400 MHz");

    expect(kinds(blocks)).toEqual(["list-item", "list-item"]);
    expect(blocks[0]).toMatchObject({ marker: "•", depth: 0 });
  });

  test("keeps the number of an ordered list", () => {
    expect(parseMarkdown("1. first\n2. second")[1]).toMatchObject({ marker: "2." });
  });

  test("reads nested list depth from indentation", () => {
    const blocks = parseMarkdown("- outer\n  - inner\n    - deeper");

    expect(blocks.map((block) => (block as { depth: number }).depth)).toEqual([0, 1, 2]);
  });

  test("keeps a fenced code block verbatim", () => {
    const [code] = parseMarkdown("```sh\nbun run dev\n# **not bold**\n```");

    expect(code).toMatchObject({
      kind: "code",
      language: "sh",
      lines: ["bun run dev", "# **not bold**"],
    });
  });

  test("closes an unterminated fence at the end of the reply", () => {
    const [code] = parseMarkdown("```\nstill streaming");

    expect(code).toMatchObject({ kind: "code", lines: ["still streaming"] });
  });

  test("reads block quotes", () => {
    const [quote] = parseMarkdown("> quoted line\n> second line");

    expect(quote!.kind).toBe("quote");
    expect(spansToText(spansOf(quote))).toBe("quoted line second line");
  });

  test("reads horizontal rules", () => {
    expect(kinds(parseMarkdown("above\n\n---\n\nbelow"))).toEqual([
      "paragraph",
      "rule",
      "paragraph",
    ]);
  });

  test("reads a table with its header", () => {
    const [table] = parseMarkdown(
      "| Tool | Mode |\n| --- | --- |\n| bash | BUILD |\n| grep | PLAN |",
    );

    expect(table!.kind).toBe("table");
    const typed = table as Extract<MarkdownBlock, { kind: "table" }>;
    expect(typed.header.map(spansToText)).toEqual(["Tool", "Mode"]);
    expect(typed.rows).toHaveLength(2);
    expect(typed.rows[1]!.map(spansToText)).toEqual(["grep", "PLAN"]);
  });

  test("leaves pipes alone when there is no divider row", () => {
    expect(kinds(parseMarkdown("| not | a table |\njust text"))).toEqual(["paragraph"]);
  });

  test("reads a whole reply the way a model writes one", () => {
    const blocks = parseMarkdown(
      [
        "I checked your RAM.",
        "",
        "### Your installed RAM",
        "- **Total:** 16 GB usable",
        "- **Speed:** 2400 MHz",
        "",
        "```sh",
        "wmic memorychip get speed",
        "```",
        "",
        "That is a basic test.",
      ].join("\n"),
    );

    expect(kinds(blocks)).toEqual([
      "paragraph",
      "heading",
      "list-item",
      "list-item",
      "code",
      "paragraph",
    ]);
  });

  test("returns nothing for empty content", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n  \n")).toEqual([]);
  });
});
