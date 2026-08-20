import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectTargetPaths,
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  rewindTo,
} from "./checkpoints";

const SESSION = "session-under-test";

let workspace: string;
let home: string;
let originalCwd: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  originalHome = process.env.TERMKODE_HOME;

  workspace = mkdtempSync(join(tmpdir(), "termkode-checkpoint-"));
  home = mkdtempSync(join(tmpdir(), "termkode-home-"));

  process.env.TERMKODE_HOME = home;
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);

  if (originalHome === undefined) {
    delete process.env.TERMKODE_HOME;
  } else {
    process.env.TERMKODE_HOME = originalHome;
  }

  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("collectTargetPaths", () => {
  test("reads the path a write tool will touch", () => {
    expect(collectTargetPaths("writeFile", { path: "a.ts" })).toEqual(["a.ts"]);
    expect(collectTargetPaths("editFile", { path: "a.ts" })).toEqual(["a.ts"]);
  });

  test("deduplicates the files in a multi-edit", () => {
    expect(
      collectTargetPaths("multiEdit", {
        edits: [{ path: "a.ts" }, { path: "b.ts" }, { path: "a.ts" }],
      }),
    ).toEqual(["a.ts", "b.ts"]);
  });

  test("ignores tools that do not write", () => {
    expect(collectTargetPaths("bash", { command: "ls" })).toEqual([]);
  });
});

describe("createCheckpoint", () => {
  test("does nothing for a read-only tool", () => {
    expect(createCheckpoint(SESSION, "readFile", { path: "a.ts" })).toBeNull();
  });

  test("records the content of an existing file", () => {
    writeFileSync(join(workspace, "a.ts"), "before");

    const checkpoint = createCheckpoint(SESSION, "editFile", { path: "a.ts" });

    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.files[0]!.existed).toBe(true);
    expect(checkpoint!.files[0]!.content).toBe("before");
  });

  test("records a file that does not exist yet, so it can be removed again", () => {
    const checkpoint = createCheckpoint(SESSION, "writeFile", { path: "new.ts" });
    expect(checkpoint!.files[0]!.existed).toBe(false);
  });

  test("refuses a path outside the project", () => {
    expect(createCheckpoint(SESSION, "writeFile", { path: "../escape.ts" })).toBeNull();
  });
});

describe("restoreCheckpoint", () => {
  test("puts an edited file back", () => {
    const file = join(workspace, "a.ts");
    writeFileSync(file, "before");

    const checkpoint = createCheckpoint(SESSION, "editFile", { path: "a.ts" })!;
    writeFileSync(file, "after");

    const result = restoreCheckpoint(SESSION, checkpoint.id);

    expect(result.restored).toEqual(["a.ts"]);
    expect(readFileSync(file, "utf-8")).toBe("before");
  });

  test("deletes a file the agent created", () => {
    const checkpoint = createCheckpoint(SESSION, "writeFile", { path: "new.ts" })!;
    writeFileSync(join(workspace, "new.ts"), "generated");

    const result = restoreCheckpoint(SESSION, checkpoint.id);

    expect(result.deleted).toEqual(["new.ts"]);
    expect(existsSync(join(workspace, "new.ts"))).toBe(false);
  });

  test("restores a file in a directory the agent created", () => {
    const checkpoint = createCheckpoint(SESSION, "writeFile", { path: "src/deep/new.ts" })!;
    mkdirSync(join(workspace, "src", "deep"), { recursive: true });
    writeFileSync(join(workspace, "src", "deep", "new.ts"), "generated");

    restoreCheckpoint(SESSION, checkpoint.id);
    expect(existsSync(join(workspace, "src", "deep", "new.ts"))).toBe(false);
  });

  test("reports a checkpoint that is gone rather than failing silently", () => {
    expect(() => restoreCheckpoint(SESSION, "nope")).toThrow();
  });
});

describe("listCheckpoints", () => {
  test("is empty for a session that has written nothing", () => {
    expect(listCheckpoints("unused-session")).toEqual([]);
  });

  test("lists the newest first", () => {
    writeFileSync(join(workspace, "a.ts"), "one");
    createCheckpoint(SESSION, "editFile", { path: "a.ts" });
    writeFileSync(join(workspace, "b.ts"), "two");
    createCheckpoint(SESSION, "editFile", { path: "b.ts" });

    const summaries = listCheckpoints(SESSION);

    expect(summaries).toHaveLength(2);
    expect(summaries[0]!.label).toContain("b.ts");
  });
});

describe("rewindTo", () => {
  test("undoes every edit made after the chosen checkpoint", () => {
    const file = join(workspace, "a.ts");
    writeFileSync(file, "v1");

    const first = createCheckpoint(SESSION, "editFile", { path: "a.ts" })!;
    writeFileSync(file, "v2");

    createCheckpoint(SESSION, "editFile", { path: "a.ts" });
    writeFileSync(file, "v3");

    rewindTo(SESSION, first.id);

    expect(readFileSync(file, "utf-8")).toBe("v1");
  });

  test("removes a file created after the chosen checkpoint", () => {
    writeFileSync(join(workspace, "a.ts"), "v1");
    const first = createCheckpoint(SESSION, "editFile", { path: "a.ts" })!;
    writeFileSync(join(workspace, "a.ts"), "v2");

    createCheckpoint(SESSION, "writeFile", { path: "generated.ts" });
    writeFileSync(join(workspace, "generated.ts"), "generated");

    const result = rewindTo(SESSION, first.id);

    expect(readFileSync(join(workspace, "a.ts"), "utf-8")).toBe("v1");
    expect(existsSync(join(workspace, "generated.ts"))).toBe(false);
    expect(result.deleted).toContain("generated.ts");
  });
});
