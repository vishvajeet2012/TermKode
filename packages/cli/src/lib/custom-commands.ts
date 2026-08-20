import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { getTermkodeHome } from "./env";

// The prompts a team reuses - "review this against our API guidelines", "write
// the release notes for this branch" - belong to the project, not to whoever
// remembered to paste them. A markdown file in .termkode/commands becomes a
// slash command, and a file in ~/.termkode/commands follows the user between
// projects.

export const PROJECT_COMMANDS_RELATIVE_PATH = ".termkode/commands";
export const PERSONAL_COMMANDS_DIRECTORY = "commands";

const MAX_COMMAND_CHARACTERS = 20_000;
const MAX_COMMANDS_PER_SOURCE = 100;

export type CustomCommand = {
  name: string;
  description: string;
  /** The prompt sent when the command runs, before argument substitution. */
  prompt: string;
  source: "project" | "personal";
  path: string;
};

/** Replaced with whatever the user typed after the command name. */
const ARGUMENTS_PLACEHOLDER = /\$ARGUMENTS\b/g;

// A minimal front matter reader: only `description` is used, and anything else
// is left in place rather than guessed at.
function parseFrontMatter(contents: string) {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { description: null as string | null, body: contents };

  const description = match[1]
    ?.split(/\r?\n/)
    .map((line) => line.match(/^description\s*:\s*(.+)$/i)?.[1]?.trim())
    .find(Boolean);

  return {
    description: description ? stripQuotes(description) : null,
    body: contents.slice(match[0].length),
  };
}

function stripQuotes(value: string) {
  return value.replace(/^["'](.*)["']$/, "$1").trim();
}

function firstLine(body: string) {
  const line = body
    .split(/\r?\n/)
    .map((entry) => entry.replace(/^#+\s*/, "").trim())
    .find(Boolean);

  if (!line) return "Custom command";
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

function isValidName(name: string) {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(name);
}

function loadDirectory(directory: string, source: CustomCommand["source"]): CustomCommand[] {
  if (!existsSync(directory)) return [];

  const commands: CustomCommand[] = [];

  try {
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".md")) continue;
      if (commands.length >= MAX_COMMANDS_PER_SOURCE) break;

      const name = basename(entry, ".md");
      if (!isValidName(name)) continue;

      const path = join(directory, entry);

      try {
        const contents = readFileSync(path, "utf-8").slice(0, MAX_COMMAND_CHARACTERS);
        const { description, body } = parseFrontMatter(contents);
        const prompt = body.trim();
        if (!prompt) continue;

        commands.push({
          name: name.toLowerCase(),
          description: description ?? firstLine(prompt),
          prompt,
          source,
          path,
        });
      } catch {
        // Skip a command file that cannot be read.
      }
    }
  } catch {
    return [];
  }

  return commands.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Project commands are loaded after personal ones and win on a name clash: the
 * repository's version of `/review` is the one its contributors expect.
 */
export function loadCustomCommands(cwd = process.cwd()): CustomCommand[] {
  const personal = loadDirectory(
    join(getTermkodeHome(), PERSONAL_COMMANDS_DIRECTORY),
    "personal",
  );
  const project = loadDirectory(join(cwd, PROJECT_COMMANDS_RELATIVE_PATH), "project");

  const byName = new Map<string, CustomCommand>();
  for (const command of [...personal, ...project]) {
    byName.set(command.name, command);
  }

  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

let cache: CustomCommand[] | null = null;

/** Loaded once per process, so the command menu never touches the disk mid-keystroke. */
export function getCustomCommands(): CustomCommand[] {
  cache ??= loadCustomCommands();
  return cache;
}

export function findCustomCommand(name: string): CustomCommand | null {
  const wanted = name.toLowerCase();
  return getCustomCommands().find((command) => command.name === wanted) ?? null;
}

/** Fills `$ARGUMENTS` with the text typed after the command name. */
export function renderCustomCommand(command: CustomCommand, args: string) {
  const trimmed = args.trim();

  if (ARGUMENTS_PLACEHOLDER.test(command.prompt)) {
    ARGUMENTS_PLACEHOLDER.lastIndex = 0;
    return command.prompt.replace(ARGUMENTS_PLACEHOLDER, trimmed);
  }

  ARGUMENTS_PLACEHOLDER.lastIndex = 0;
  return trimmed ? `${command.prompt}\n\n${trimmed}` : command.prompt;
}
