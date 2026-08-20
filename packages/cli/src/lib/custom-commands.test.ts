import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROJECT_COMMANDS_RELATIVE_PATH,
  loadCustomCommands,
  renderCustomCommand,
  type CustomCommand,
} from "./custom-commands";

let project: string;
let home: string;
let originalHome: string | undefined;

function writeProjectCommand(name: string, contents: string) {
  const directory = join(project, PROJECT_COMMANDS_RELATIVE_PATH);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), contents);
}

function writePersonalCommand(name: string, contents: string) {
  const directory = join(home, "commands");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), contents);
}

beforeEach(() => {
  originalHome = process.env.TERMKODE_HOME;
  project = mkdtempSync(join(tmpdir(), "termkode-commands-"));
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

describe("loadCustomCommands", () => {
  test("finds nothing in a project with no command files", () => {
    expect(loadCustomCommands(project)).toEqual([]);
  });

  test("reads a command and its front matter description", () => {
    writeProjectCommand(
      "review.md",
      "---\ndescription: Review against our guidelines\n---\nReview the change.",
    );

    const [command] = loadCustomCommands(project);

    expect(command!.name).toBe("review");
    expect(command!.description).toBe("Review against our guidelines");
    expect(command!.prompt).toBe("Review the change.");
    expect(command!.source).toBe("project");
  });

  test("falls back to the first meaningful line as the description", () => {
    writeProjectCommand("notes.md", "# Write release notes\n\nDo the thing.");
    expect(loadCustomCommands(project)[0]!.description).toBe("Write release notes");
  });

  test("includes personal commands", () => {
    writePersonalCommand("standup.md", "Summarize what I did today.");

    const names = loadCustomCommands(project).map((command) => command.name);
    expect(names).toContain("standup");
  });

  test("lets the project override a personal command of the same name", () => {
    writePersonalCommand("review.md", "personal version");
    writeProjectCommand("review.md", "project version");

    const commands = loadCustomCommands(project);
    const review = commands.find((command) => command.name === "review");

    expect(commands.filter((command) => command.name === "review")).toHaveLength(1);
    expect(review!.prompt).toBe("project version");
  });

  test("skips files that are empty or badly named", () => {
    writeProjectCommand("blank.md", "---\ndescription: nothing\n---\n\n");
    writeProjectCommand("has space.md", "content");
    writeProjectCommand("notes.txt", "content");

    expect(loadCustomCommands(project)).toEqual([]);
  });
});

describe("renderCustomCommand", () => {
  const command: CustomCommand = {
    name: "review",
    description: "Review",
    prompt: "Review $ARGUMENTS against the guidelines.",
    source: "project",
    path: "review.md",
  };

  test("substitutes the arguments placeholder", () => {
    expect(renderCustomCommand(command, "src/app.ts")).toBe(
      "Review src/app.ts against the guidelines.",
    );
  });

  test("substitutes every occurrence", () => {
    const repeated = { ...command, prompt: "$ARGUMENTS then $ARGUMENTS" };
    expect(renderCustomCommand(repeated, "x")).toBe("x then x");
  });

  test("appends the arguments when there is no placeholder", () => {
    const plain = { ...command, prompt: "Review the change." };
    expect(renderCustomCommand(plain, "src/app.ts")).toBe(
      "Review the change.\n\nsrc/app.ts",
    );
  });

  test("leaves the prompt alone when nothing was typed", () => {
    const plain = { ...command, prompt: "Review the change." };
    expect(renderCustomCommand(plain, "  ")).toBe("Review the change.");
  });
});
