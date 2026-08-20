import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { getHomeDirectory } from "./paths";

// A general-purpose system prompt does not know that this repository uses Bun,
// forbids default exports, or runs its tests with a single command. Those facts
// live in the repository itself, so TermKode reads them from an instructions
// file and hands them to the model on every request.

/** Checked in this order in each directory; the first match in a directory wins. */
export const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "TERMKODE.md", "CLAUDE.md"] as const;

/** Personal instructions that apply to every project. */
export const GLOBAL_INSTRUCTION_FILE = "AGENTS.md";

// One oversized file should not crowd out the conversation it is meant to
// guide, so each file and the combined set are capped.
const MAX_FILE_CHARACTERS = 12_000;
const MAX_TOTAL_CHARACTERS = 24_000;
const MAX_PARENT_LEVELS = 8;

export type ProjectInstructions = {
  /** Absolute paths of the files that were read, outermost first. */
  sources: string[];
  /** The combined text, already capped. Empty when nothing was found. */
  text: string;
};

const EMPTY: ProjectInstructions = { sources: [], text: "" };

function readInstructionFile(path: string): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;

    const contents = readFileSync(path, "utf-8").trim();
    if (!contents) return null;

    return contents.length > MAX_FILE_CHARACTERS
      ? `${contents.slice(0, MAX_FILE_CHARACTERS)}\n... (instructions truncated)`
      : contents;
  } catch {
    // An unreadable instructions file should never fail the request.
    return null;
  }
}

function findInDirectory(directory: string): string | null {
  for (const name of INSTRUCTION_FILE_NAMES) {
    const path = join(directory, name);
    if (existsSync(path)) return path;
  }
  return null;
}

// Walking up stops at the repository root: a file above it belongs to a
// different project, or to the user's home directory, which is read separately.
function collectProjectFiles(cwd: string): string[] {
  const found: string[] = [];
  let directory = resolve(cwd);

  for (let level = 0; level <= MAX_PARENT_LEVELS; level += 1) {
    const path = findInDirectory(directory);
    if (path) found.push(path);

    if (existsSync(join(directory, ".git"))) break;

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  // Outermost first, so the file closest to the working directory has the last
  // word when two of them disagree.
  return found.reverse();
}

export function loadProjectInstructions(cwd?: string): ProjectInstructions {
  const workingDirectory = cwd ?? process.cwd();
  const paths: string[] = [];

  const globalPath = join(getHomeDirectory(), GLOBAL_INSTRUCTION_FILE);
  if (existsSync(globalPath)) paths.push(globalPath);

  paths.push(...collectProjectFiles(workingDirectory));

  const sources: string[] = [];
  const sections: string[] = [];
  let total = 0;

  for (const path of paths) {
    const contents = readInstructionFile(path);
    if (!contents) continue;

    const label = path === globalPath ? "~/.termkode/AGENTS.md" : relative(workingDirectory, path) || path;
    const section = `### ${label}\n${contents}`;

    if (total + section.length > MAX_TOTAL_CHARACTERS) break;

    total += section.length;
    sources.push(path);
    sections.push(section);
  }

  if (sections.length === 0) return EMPTY;

  return { sources, text: sections.join("\n\n") };
}

/** The template `/init` writes when a project has no instructions file yet. */
export function buildInitPrompt(cwd: string) {
  return `Create an ${INSTRUCTION_FILE_NAMES[0]} file at the root of this project (${cwd}).

First explore the repository to learn how it actually works, then write the file.
Read the README, the package manifest and its scripts, the CI workflow, the
linter and formatter configuration, and enough source files to see the
conventions the code follows.

The file is loaded into the system prompt of every future request, so it must
be short and factual. Include only what a new engineer could not guess:

- What the project is, in one or two sentences.
- The exact commands for install, dev, build, test, lint, and typecheck.
- The layout: which package or directory owns what.
- Conventions this codebase actually follows - module style, naming, error
  handling, testing, comment style - each stated as a rule.
- Anything that is easy to get wrong here, and the rule that avoids it.

Do not include a file tree, a dependency list, generic advice that would apply
to any repository, or anything you have not verified by reading the code. Aim
for well under 100 lines. Write the file with writeFile, then reply with a short
summary of what you recorded.`;
}
