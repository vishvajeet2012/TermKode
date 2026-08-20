import { describe, expect, test } from "bun:test";
import { computeFileDiff, formatFileDiff } from "./diff";

describe("computeFileDiff", () => {
  test("reports no change when the content is identical", () => {
    const diff = computeFileDiff("a.ts", "one\ntwo\n", "one\ntwo\n");
    expect(diff.hunks).toEqual([]);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });

  test("counts a single replaced line", () => {
    const diff = computeFileDiff("a.ts", "one\ntwo\nthree", "one\nTWO\nthree");
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.hunks).toHaveLength(1);
  });

  test("keeps surrounding context around a change in a long file", () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    const after = before.replace("line 20", "line twenty");
    const diff = computeFileDiff("a.ts", before, after, { context: 2 });

    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    // Two context lines either side of one changed pair.
    expect(diff.hunks[0]!.lines).toHaveLength(6);
  });

  test("separates changes that are far apart into their own hunks", () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    const after = before.replace("line 2\n", "changed 2\n").replace("line 30", "changed 30");
    const diff = computeFileDiff("a.ts", before, after, { context: 1 });

    expect(diff.hunks.length).toBe(2);
  });

  test("treats an added line as an addition only", () => {
    const diff = computeFileDiff("a.ts", "one\ntwo", "one\nmiddle\ntwo");
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
  });

  test("handles a file that had no content before", () => {
    const diff = computeFileDiff("a.ts", "", "one\ntwo");
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(0);
  });

  test("normalizes line endings so a CRLF file is not reported as fully rewritten", () => {
    const diff = computeFileDiff("a.ts", "one\r\ntwo\r\n", "one\ntwo\n");
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });

  test("stops after the line budget instead of dumping a whole rewrite", () => {
    const before = Array.from({ length: 200 }, (_, index) => `old ${index}`).join("\n");
    const after = Array.from({ length: 200 }, (_, index) => `new ${index}`).join("\n");
    const diff = computeFileDiff("a.ts", before, after, { maxLines: 10 });

    expect(diff.truncated).toBe(true);
    expect(diff.hunks.reduce((total, hunk) => total + hunk.lines.length, 0)).toBeLessThanOrEqual(10);
  });

  test("summarizes instead of diffing a file that is too large", () => {
    const before = Array.from({ length: 5000 }, (_, index) => `line ${index}`).join("\n");
    const diff = computeFileDiff("big.ts", before, `${before}\nextra`);

    expect(diff.truncated).toBe(true);
    expect(diff.hunks).toEqual([]);
  });
});

describe("formatFileDiff", () => {
  test("renders markers the way git does", () => {
    const output = formatFileDiff(computeFileDiff("a.ts", "one\ntwo", "one\nTWO"));

    expect(output).toContain("a.ts (+1 -1)");
    expect(output).toContain("-two");
    expect(output).toContain("+TWO");
    expect(output).toContain(" one");
  });

  test("says so when nothing changed", () => {
    expect(formatFileDiff(computeFileDiff("a.ts", "same", "same"))).toContain("no textual change");
  });
});
