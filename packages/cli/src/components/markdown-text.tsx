import { Fragment, useMemo } from "react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../providers/theme";
import type { ThemeColors } from "../theme";
import {
  parseMarkdown,
  spansToText,
  type InlineSpan,
  type MarkdownBlock,
} from "../lib/markdown";

// Renders the blocks the parser produced. Everything is built from <text> and
// its inline modifiers, which is the one thing the terminal renderer is certain
// to draw - see the note at the top of lib/markdown.ts for why the built-in
// <markdown> element is not used.

type Props = {
  content: string;
};

/** Beyond this a table is left as plain rows rather than squeezed into columns. */
const MAX_TABLE_WIDTH = 100;

function spanColor(span: InlineSpan, colors: ThemeColors) {
  if (span.code) return colors.info;
  if (span.link) return colors.selection;
  return undefined;
}

function spanAttributes(span: InlineSpan) {
  let attributes = 0;
  if (span.bold) attributes |= TextAttributes.BOLD;
  if (span.italic) attributes |= TextAttributes.ITALIC;
  if (span.strike) attributes |= TextAttributes.STRIKETHROUGH;
  if (span.link) attributes |= TextAttributes.UNDERLINE;
  return attributes || undefined;
}

function Inline({ spans, colors }: { spans: InlineSpan[]; colors: ThemeColors }) {
  return (
    <>
      {spans.map((span, index) => (
        <span
          key={index}
          fg={spanColor(span, colors)}
          attributes={spanAttributes(span)}
        >
          {span.text}
        </span>
      ))}
    </>
  );
}

// A link is only useful if its destination is visible: the terminal cannot be
// clicked through to one.
function linkTargets(spans: InlineSpan[]) {
  return [...new Set(spans.map((span) => span.link).filter((link): link is string => Boolean(link)))];
}

function cellWidth(cell: InlineSpan[]) {
  return spansToText(cell).length;
}

function TableBlock({
  block,
  colors,
}: {
  block: Extract<MarkdownBlock, { kind: "table" }>;
  colors: ThemeColors;
}) {
  const widths = useMemo(() => {
    const columns = Math.max(
      block.header.length,
      ...block.rows.map((row) => row.length),
      1,
    );

    const measured = Array.from({ length: columns }, (_, column) =>
      Math.max(
        cellWidth(block.header[column] ?? []),
        ...block.rows.map((row) => cellWidth(row[column] ?? [])),
        1,
      ),
    );

    // Shrink the widest columns first when the table would overflow, so a
    // single long cell does not squeeze every other column to nothing.
    let total = measured.reduce((sum, width) => sum + width + 2, 0);
    while (total > MAX_TABLE_WIDTH) {
      const widest = measured.indexOf(Math.max(...measured));
      if (measured[widest]! <= 8) break;
      measured[widest] = measured[widest]! - 1;
      total -= 1;
    }

    return measured;
  }, [block]);

  const renderRow = (cells: InlineSpan[][], header: boolean) => (
    <box flexDirection="row">
      {widths.map((width, column) => {
        const cell = cells[column] ?? [];
        const text = spansToText(cell);
        const clipped = text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text;

        return (
          <box key={column} width={width + 2} overflow="hidden">
            <text
              fg={header ? colors.primary : undefined}
              attributes={header ? TextAttributes.BOLD : undefined}
            >
              {clipped.padEnd(width)}
            </text>
          </box>
        );
      })}
    </box>
  );

  return (
    <box flexDirection="column">
      {renderRow(block.header, true)}
      <text fg={colors.dimSeparator} attributes={TextAttributes.DIM}>
        {widths.map((width) => "─".repeat(width)).join("  ")}
      </text>
      {block.rows.map((row, index) => (
        <Fragment key={index}>{renderRow(row, false)}</Fragment>
      ))}
    </box>
  );
}

function Block({ block, colors }: { block: MarkdownBlock; colors: ThemeColors }) {
  switch (block.kind) {
    case "heading":
      return (
        <text
          fg={block.level <= 2 ? colors.primary : undefined}
          attributes={TextAttributes.BOLD}
        >
          <Inline spans={block.spans} colors={colors} />
        </text>
      );

    case "paragraph": {
      const links = linkTargets(block.spans);
      return (
        <box flexDirection="column">
          <text>
            <Inline spans={block.spans} colors={colors} />
          </text>
          {links.map((link) => (
            <text key={link} fg={colors.dimSeparator} attributes={TextAttributes.DIM}>
              {link}
            </text>
          ))}
        </box>
      );
    }

    case "list-item":
      return (
        <box flexDirection="row" paddingLeft={block.depth * 2}>
          <text fg={colors.primary}>{block.marker} </text>
          <box flexGrow={1}>
            <text>
              <Inline spans={block.spans} colors={colors} />
            </text>
          </box>
        </box>
      );

    case "code":
      return (
        <box
          flexDirection="column"
          paddingX={1}
          backgroundColor={colors.surface}
        >
          {block.language ? (
            <text fg={colors.dimSeparator} attributes={TextAttributes.DIM}>
              {block.language}
            </text>
          ) : null}
          {block.lines.map((line, index) => (
            <text key={index} fg={colors.info}>
              {line || " "}
            </text>
          ))}
        </box>
      );

    case "quote":
      return (
        <box flexDirection="row">
          <text fg={colors.dimSeparator}>│ </text>
          <box flexGrow={1}>
            <text attributes={TextAttributes.ITALIC} fg={colors.dimSeparator}>
              <Inline spans={block.spans} colors={colors} />
            </text>
          </box>
        </box>
      );

    case "table":
      return <TableBlock block={block} colors={colors} />;

    case "rule":
      return (
        <text fg={colors.dimSeparator} attributes={TextAttributes.DIM}>
          ────────────────
        </text>
      );
  }
}

// Blocks are separated by a blank line, except that consecutive list items
// belong to one list and the first block should not push the reply down.
function spacingBefore(block: MarkdownBlock, previous: MarkdownBlock | undefined) {
  if (!previous) return 0;
  if (block.kind === "list-item" && previous.kind === "list-item") return 0;
  return 1;
}

export function MarkdownText({ content }: Props) {
  const { colors } = useTheme();
  const blocks = useMemo(() => parseMarkdown(content), [content]);

  return (
    <box flexDirection="column" width="100%">
      {blocks.map((block, index) => (
        <box key={index} width="100%" paddingTop={spacingBefore(block, blocks[index - 1])}>
          <Block block={block} colors={colors} />
        </box>
      ))}
    </box>
  );
}
