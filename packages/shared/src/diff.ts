// A file edit that is applied silently is an edit nobody reviewed. Every write
// tool returns the diff it produced so the terminal can show `+`/`-` lines and
// the model can see exactly what landed instead of guessing from its own input.

export type DiffLineType = "add" | "remove" | "context";

export type DiffLine = {
  type: DiffLineType;
  text: string;
  /** 1-based line number in the file before the edit. */
  oldLine?: number;
  /** 1-based line number in the file after the edit. */
  newLine?: number;
};

export type DiffHunk = {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

export type FileDiff = {
  path: string;
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** Set when the file was too large to diff line by line. */
  truncated?: boolean;
};

export type DiffOptions = {
  /** Unchanged lines kept around each change. */
  context?: number;
  /** Above this many changed lines the diff is cut short. */
  maxLines?: number;
};

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_LINES = 60;
// The line-by-line pass is quadratic, so very large files fall back to a
// summary rather than freezing the terminal on a generated bundle.
const MAX_DIFFABLE_LINES = 4000;

function splitLines(value: string): string[] {
  if (value === "") return [];
  return value.replace(/\r\n/g, "\n").split("\n");
}

/**
 * Longest common subsequence over the lines that actually differ. Shared
 * prefixes and suffixes are trimmed first, which is what keeps a one-line edit
 * in a large file cheap.
 */
function diffLines(before: string[], after: string[]): DiffLine[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }

  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end += 1;
  }

  const middleBefore = before.slice(start, before.length - end);
  const middleAfter = after.slice(start, after.length - end);

  const lines: DiffLine[] = [];

  for (let index = 0; index < start; index += 1) {
    lines.push({
      type: "context",
      text: before[index]!,
      oldLine: index + 1,
      newLine: index + 1,
    });
  }

  for (const line of lcsDiff(middleBefore, middleAfter, start)) {
    lines.push(line);
  }

  for (let index = 0; index < end; index += 1) {
    const oldIndex = before.length - end + index;
    const newIndex = after.length - end + index;
    lines.push({
      type: "context",
      text: before[oldIndex]!,
      oldLine: oldIndex + 1,
      newLine: newIndex + 1,
    });
  }

  return lines;
}

function lcsDiff(before: string[], after: string[], offset: number): DiffLine[] {
  if (before.length === 0 && after.length === 0) return [];

  // Nothing in common to align: report it as a straight replacement.
  if (before.length === 0 || after.length === 0) {
    return [
      ...before.map((text, index) => ({
        type: "remove" as const,
        text,
        oldLine: offset + index + 1,
      })),
      ...after.map((text, index) => ({
        type: "add" as const,
        text,
        newLine: offset + index + 1,
      })),
    ];
  }

  const rows = before.length;
  const columns = after.length;
  const table: Uint32Array[] = Array.from(
    { length: rows + 1 },
    () => new Uint32Array(columns + 1),
  );

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row]![column] =
        before[row] === after[column]
          ? table[row + 1]![column + 1]! + 1
          : Math.max(table[row + 1]![column]!, table[row]![column + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let row = 0;
  let column = 0;

  while (row < rows && column < columns) {
    if (before[row] === after[column]) {
      lines.push({
        type: "context",
        text: before[row]!,
        oldLine: offset + row + 1,
        newLine: offset + column + 1,
      });
      row += 1;
      column += 1;
    } else if (table[row + 1]![column]! >= table[row]![column + 1]!) {
      lines.push({ type: "remove", text: before[row]!, oldLine: offset + row + 1 });
      row += 1;
    } else {
      lines.push({ type: "add", text: after[column]!, newLine: offset + column + 1 });
      column += 1;
    }
  }

  while (row < rows) {
    lines.push({ type: "remove", text: before[row]!, oldLine: offset + row + 1 });
    row += 1;
  }

  while (column < columns) {
    lines.push({ type: "add", text: after[column]!, newLine: offset + column + 1 });
    column += 1;
  }

  return lines;
}

function collectHunks(lines: DiffLine[], context: number): DiffHunk[] {
  const changed = lines
    .map((line, index) => (line.type === "context" ? -1 : index))
    .filter((index) => index >= 0);

  if (changed.length === 0) return [];

  const hunks: DiffHunk[] = [];
  let hunkStart = Math.max(0, changed[0]! - context);
  let hunkEnd = Math.min(lines.length - 1, changed[0]! + context);

  for (const index of changed.slice(1)) {
    if (index - context <= hunkEnd + 1) {
      hunkEnd = Math.min(lines.length - 1, index + context);
      continue;
    }

    hunks.push(buildHunk(lines.slice(hunkStart, hunkEnd + 1)));
    hunkStart = Math.max(0, index - context);
    hunkEnd = Math.min(lines.length - 1, index + context);
  }

  hunks.push(buildHunk(lines.slice(hunkStart, hunkEnd + 1)));
  return hunks;
}

function buildHunk(lines: DiffLine[]): DiffHunk {
  const oldStart = lines.find((line) => line.oldLine != null)?.oldLine ?? 1;
  const newStart = lines.find((line) => line.newLine != null)?.newLine ?? 1;
  return { oldStart, newStart, lines };
}

export function computeFileDiff(
  path: string,
  before: string,
  after: string,
  options: DiffOptions = {},
): FileDiff {
  const context = options.context ?? DEFAULT_CONTEXT;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;

  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  if (before === after) {
    return { path, hunks: [], added: 0, removed: 0 };
  }

  if (beforeLines.length > MAX_DIFFABLE_LINES || afterLines.length > MAX_DIFFABLE_LINES) {
    return {
      path,
      hunks: [],
      added: afterLines.length,
      removed: beforeLines.length,
      truncated: true,
    };
  }

  const lines = diffLines(beforeLines, afterLines);
  const added = lines.filter((line) => line.type === "add").length;
  const removed = lines.filter((line) => line.type === "remove").length;

  const hunks = collectHunks(lines, context);
  let budget = maxLines;
  const trimmed: DiffHunk[] = [];
  let truncated = false;

  for (const hunk of hunks) {
    if (budget <= 0) {
      truncated = true;
      break;
    }

    if (hunk.lines.length > budget) {
      trimmed.push({ ...hunk, lines: hunk.lines.slice(0, budget) });
      budget = 0;
      truncated = true;
      break;
    }

    trimmed.push(hunk);
    budget -= hunk.lines.length;
  }

  return {
    path,
    hunks: trimmed,
    added,
    removed,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Renders a diff the way `git diff` would, for the tool result the model reads. */
export function formatFileDiff(diff: FileDiff): string {
  if (diff.hunks.length === 0) {
    return diff.truncated
      ? `${diff.path}: +${diff.added} -${diff.removed} (file too large to show)`
      : `${diff.path}: no textual change`;
  }

  const body = diff.hunks
    .map((hunk) => {
      const header = `@@ -${hunk.oldStart} +${hunk.newStart} @@`;
      const lines = hunk.lines.map((line) => {
        const marker = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
        return `${marker}${line.text}`;
      });
      return [header, ...lines].join("\n");
    })
    .join("\n");

  return [`${diff.path} (+${diff.added} -${diff.removed})`, body, diff.truncated ? "... diff truncated" : ""]
    .filter(Boolean)
    .join("\n");
}
