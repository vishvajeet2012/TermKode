import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mode } from "@termkode/shared";
import { executeLocalTool } from "./local-tools";

// resolveInsideCwd is the boundary that keeps every file tool inside the
// project. It is the one function in the CLI that, if wrong, lets the agent
// read or overwrite something outside the directory the user opened - and it
// had no test at all. These go through the public tool interface, so they cover
// the boundary as it is actually reached.

let workspace: string;
let outside: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workspace = mkdtempSync(join(tmpdir(), "termkode-tools-"));
  outside = mkdtempSync(join(tmpdir(), "termkode-outside-"));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const ESCAPES = [
  "../escape.txt",
  "../../escape.txt",
  "src/../../escape.txt",
  "./../escape.txt",
];

describe("path sandbox", () => {
  test.each(ESCAPES)("readFile refuses %s", async (path) => {
    await expect(executeLocalTool("readFile", { path }, Mode.BUILD)).rejects.toThrow(
      /outside the project/,
    );
  });

  test.each(ESCAPES)("writeFile refuses %s", async (path) => {
    await expect(
      executeLocalTool("writeFile", { path, content: "x" }, Mode.BUILD),
    ).rejects.toThrow(/outside the project/);
  });

  test("refuses an absolute path outside the project", async () => {
    const target = join(outside, "escape.txt");
    writeFileSync(target, "secret");

    await expect(
      executeLocalTool("readFile", { path: target }, Mode.BUILD),
    ).rejects.toThrow(/outside the project/);
  });

  test("does not create a file outside the project", async () => {
    const target = join(outside, "created.txt");

    await expect(
      executeLocalTool("writeFile", { path: target, content: "x" }, Mode.BUILD),
    ).rejects.toThrow(/outside the project/);

    expect(() => readFileSync(target, "utf-8")).toThrow();
  });

  test("multiEdit refuses a set containing one escaping path", async () => {
    writeFileSync(join(workspace, "inside.ts"), "keep me");
    writeFileSync(join(outside, "escape.ts"), "keep me");

    await expect(
      executeLocalTool(
        "multiEdit",
        {
          edits: [
            { path: "inside.ts", oldString: "keep me", newString: "changed" },
            { path: "../escape.ts", oldString: "keep me", newString: "changed" },
          ],
        },
        Mode.BUILD,
      ),
    ).rejects.toThrow();

    // Nothing is written unless every edit is valid, so the legal one is
    // untouched as well.
    expect(readFileSync(join(workspace, "inside.ts"), "utf-8")).toBe("keep me");
  });

  test("allows a path that stays inside after resolving", async () => {
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "app.ts"), "inside");

    const result = (await executeLocalTool(
      "readFile",
      { path: "src/../src/app.ts" },
      Mode.BUILD,
    )) as { content: string };

    expect(result.content).toBe("inside");
  });
});

describe("PLAN mode", () => {
  test("refuses tools that write", async () => {
    for (const tool of ["writeFile", "editFile", "multiEdit", "bash"]) {
      await expect(executeLocalTool(tool, {}, Mode.PLAN)).rejects.toThrow(
        /not available in PLAN mode/,
      );
    }
  });

  test("still allows reading", async () => {
    writeFileSync(join(workspace, "a.txt"), "readable");

    const result = (await executeLocalTool("readFile", { path: "a.txt" }, Mode.PLAN)) as {
      content: string;
    };

    expect(result.content).toBe("readable");
  });

  test("refuses reading background output, which belongs to bash", async () => {
    await expect(
      executeLocalTool("bashOutput", { id: "bg_1" }, Mode.PLAN),
    ).rejects.toThrow(/not available in PLAN mode/);
  });
});

describe("unknown tools", () => {
  test("are reported rather than ignored", async () => {
    await expect(executeLocalTool("notATool", {}, Mode.BUILD)).rejects.toThrow(
      /Unknown tool/,
    );
  });
});
