import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInitPrompt, loadProjectInstructions } from "./project-instructions";

let project: string;
let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.TERMKODE_HOME;
  project = mkdtempSync(join(tmpdir(), "termkode-project-"));
  home = mkdtempSync(join(tmpdir(), "termkode-home-"));
  process.env.TERMKODE_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.TERMKODE_HOME;
  } else {
    process.env.TERMKODE_HOME = originalHome;
  }

  rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("loadProjectInstructions", () => {
  test("returns nothing when the project has no instructions", () => {
    const loaded = loadProjectInstructions(project);
    expect(loaded.text).toBe("");
    expect(loaded.sources).toEqual([]);
  });

  test("reads AGENTS.md from the project root", () => {
    writeFileSync(join(project, "AGENTS.md"), "Use Bun, never npm.");

    const loaded = loadProjectInstructions(project);

    expect(loaded.text).toContain("Use Bun, never npm.");
    expect(loaded.sources).toHaveLength(1);
  });

  test("accepts the other supported filenames", () => {
    writeFileSync(join(project, "CLAUDE.md"), "House rule.");
    expect(loadProjectInstructions(project).text).toContain("House rule.");
  });

  test("prefers AGENTS.md when a directory has more than one", () => {
    writeFileSync(join(project, "AGENTS.md"), "the agents file");
    writeFileSync(join(project, "CLAUDE.md"), "the claude file");

    const loaded = loadProjectInstructions(project);

    expect(loaded.text).toContain("the agents file");
    expect(loaded.text).not.toContain("the claude file");
  });

  test("includes the personal instructions file as well", () => {
    writeFileSync(join(home, "AGENTS.md"), "Always explain the why.");
    writeFileSync(join(project, "AGENTS.md"), "Use Bun.");

    const loaded = loadProjectInstructions(project);

    expect(loaded.text).toContain("Always explain the why.");
    expect(loaded.text).toContain("Use Bun.");
    // The project file is closest to the work, so it has the last word.
    expect(loaded.text.indexOf("Use Bun.")).toBeGreaterThan(
      loaded.text.indexOf("Always explain the why."),
    );
  });

  test("walks up to a parent instructions file, stopping at the repository root", () => {
    writeFileSync(join(project, "AGENTS.md"), "monorepo rules");
    mkdirSync(join(project, ".git"));
    const nested = join(project, "packages", "web");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "AGENTS.md"), "package rules");

    const loaded = loadProjectInstructions(nested);

    expect(loaded.text).toContain("monorepo rules");
    expect(loaded.text).toContain("package rules");
    expect(loaded.text.indexOf("package rules")).toBeGreaterThan(
      loaded.text.indexOf("monorepo rules"),
    );
  });

  test("ignores an empty instructions file", () => {
    writeFileSync(join(project, "AGENTS.md"), "   \n\n");
    expect(loadProjectInstructions(project).text).toBe("");
  });

  test("truncates a file that would crowd out the conversation", () => {
    writeFileSync(join(project, "AGENTS.md"), "x".repeat(50_000));

    const loaded = loadProjectInstructions(project);

    expect(loaded.text).toContain("instructions truncated");
    expect(loaded.text.length).toBeLessThan(20_000);
  });
});

describe("buildInitPrompt", () => {
  test("names the file it should write and the directory it belongs in", () => {
    const prompt = buildInitPrompt("/tmp/example");
    expect(prompt).toContain("AGENTS.md");
    expect(prompt).toContain("/tmp/example");
  });
});
