import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidPatternError, searchFiles } from "./search";

// These cover the reason the tool was rewritten: it used to spawn `grep`, which
// is absent from a plain Windows PATH, so the tool failed there entirely.
// Searching in TypeScript means these run - and pass - on every platform.

let workspace: string;

function write(path: string, contents: string) {
  const absolute = join(workspace, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, contents);
}

async function search(pattern: string, options: { include?: string; root?: string } = {}) {
  return searchFiles({
    root: options.root ? join(workspace, options.root) : workspace,
    cwd: workspace,
    pattern,
    ...(options.include ? { include: options.include } : {}),
    maxMatches: 50,
  });
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "termkode-search-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("searchFiles", () => {
  test("finds a match and reports its file and line", async () => {
    write("src/app.ts", "const a = 1;\nexport function start() {}\n");

    const { matches } = await search("export function");

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ file: "src/app.ts", line: 2 });
    expect(matches[0]!.content).toContain("export function start");
  });

  test("reports paths with forward slashes on every platform", async () => {
    write("src/deep/nested.ts", "needle\n");

    const { matches } = await search("needle");
    expect(matches[0]!.file).toBe("src/deep/nested.ts");
  });

  test("says how many files it looked at when nothing matched", async () => {
    write("src/app.ts", "nothing here\n");

    const result = await search("definitely-absent");
    expect(result.matches).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  test("treats the pattern as a regular expression", async () => {
    write("src/app.ts", "const value = 42;\nconst other = 7;\n");

    const { matches } = await search("=\\s*\\d\\d;");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.line).toBe(1);
  });

  test("reports an unparseable pattern rather than finding nothing", async () => {
    write("src/app.ts", "anything\n");

    await expect(search("(unclosed")).rejects.toThrow(InvalidPatternError);
  });

  test("filters by file name with include", async () => {
    write("src/app.ts", "needle\n");
    write("src/app.js", "needle\n");
    write("README.md", "needle\n");

    const { matches } = await search("needle", { include: "*.ts" });

    expect(matches.map((match) => match.file)).toEqual(["src/app.ts"]);
  });

  test("searches only below the directory it was given", async () => {
    write("src/app.ts", "needle\n");
    write("other/app.ts", "needle\n");

    const { matches } = await search("needle", { root: "src" });

    expect(matches.map((match) => match.file)).toEqual(["src/app.ts"]);
  });

  test("skips node_modules and build output without being asked", async () => {
    write("src/app.ts", "needle\n");
    write("node_modules/pkg/index.js", "needle\n");
    write("dist/bundle.js", "needle\n");

    const { matches } = await search("needle");

    expect(matches.map((match) => match.file)).toEqual(["src/app.ts"]);
  });

  test("honours .gitignore, which the spawned grep never did", async () => {
    write(".gitignore", "generated/\nsecret.txt\n");
    write("src/app.ts", "needle\n");
    write("generated/output.ts", "needle\n");
    write("secret.txt", "needle\n");

    const { matches } = await search("needle");

    expect(matches.map((match) => match.file)).toEqual(["src/app.ts"]);
  });

  test("skips binary files instead of printing noise", async () => {
    write("src/app.ts", "needle\n");
    writeFileSync(join(workspace, "image.bin"), Buffer.from([0x6e, 0x00, 0x65, 0x65]));

    const { matches } = await search("n");

    expect(matches.every((match) => match.file === "src/app.ts")).toBe(true);
  });

  test("reports one result per line, the way grep does", async () => {
    write("src/app.ts", "needle needle needle\n");

    const { matches } = await search("needle");
    expect(matches).toHaveLength(1);
  });

  test("stops at the match limit and says so", async () => {
    write("src/app.ts", Array.from({ length: 40 }, () => "needle").join("\n"));

    const result = await searchFiles({
      root: workspace,
      cwd: workspace,
      pattern: "needle",
      maxMatches: 5,
    });

    expect(result.matches).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  test("truncates a very long matching line", async () => {
    write("src/app.ts", `const x = "${"a".repeat(2_000)}needle";\n`);

    const { matches } = await search("needle");
    expect(matches[0]!.content.length).toBeLessThan(500);
  });

  test("survives a directory it cannot read", async () => {
    write("src/app.ts", "needle\n");

    const result = await searchFiles({
      root: join(workspace, "does-not-exist"),
      cwd: workspace,
      pattern: "needle",
      maxMatches: 50,
    });

    expect(result.matches).toEqual([]);
  });
});
