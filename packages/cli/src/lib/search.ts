import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { isGitIgnored, loadGitIgnoreRules, type IgnoreRule } from "@termkode/shared";

// The grep tool used to spawn the `grep` binary. That binary is not on the
// PATH of a plain Windows install - not even one with Git Bash, whose grep
// lives on Git Bash's PATH rather than the system one - so one of the agent's
// two search tools failed there, silently, in PLAN mode as well as BUILD.
//
// Searching in TypeScript removes the dependency entirely: the tool now behaves
// the same on every machine TermKode runs on, and it can honour .gitignore,
// which the spawned grep never did. A generated `dist/` full of matches costs
// context and answers questions about code nobody wrote.

/** Files larger than this are skipped: they are data, not source. */
const MAX_FILE_BYTES = 2_000_000;
/** A bound on the walk, so a huge tree cannot hang a tool call. */
const MAX_FILES_SCANNED = 20_000;
/** Enough of a line to read in a result without flooding the context. */
const MAX_LINE_LENGTH = 400;

// Always skipped, whether or not the project has a .gitignore.
const ALWAYS_SKIPPED = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "coverage",
  "out",
  "vendor",
  "__pycache__",
  ".venv",
  "target",
]);

export type SearchMatch = {
  file: string;
  line: number;
  content: string;
};

export type SearchResult = {
  matches: SearchMatch[];
  /** Set when the match limit stopped the search early. */
  truncated?: boolean;
  filesScanned: number;
};

export type SearchOptions = {
  /** Directory to search, already resolved and known to be inside the project. */
  root: string;
  /** The project root, so results are reported the way the user refers to files. */
  cwd: string;
  pattern: string;
  /** Glob applied to the file name, e.g. "*.ts". */
  include?: string;
  maxMatches: number;
};

export class InvalidPatternError extends Error {
  constructor(pattern: string, cause: string) {
    super(`Invalid regular expression ${JSON.stringify(pattern)}: ${cause}`);
    this.name = "InvalidPatternError";
  }
}

/**
 * A file whose first bytes contain a NUL is binary. Matching inside one
 * produces unreadable results, and reading it wastes the context it fills.
 */
function looksBinary(contents: string) {
  return contents.slice(0, 1_000).includes("\0");
}

// The `include` filter is a file-name glob, not a path glob, which is how
// grep's own --include behaves.
function compileInclude(include: string | undefined) {
  if (!include) return null;

  const source = include
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*")
    .replaceAll("?", ".");

  try {
    return new RegExp(`^${source}$`);
  } catch {
    return null;
  }
}

function truncateLine(line: string) {
  const trimmed = line.replace(/\r$/, "");
  return trimmed.length > MAX_LINE_LENGTH
    ? `${trimmed.slice(0, MAX_LINE_LENGTH)}…`
    : trimmed;
}

export async function searchFiles(options: SearchOptions): Promise<SearchResult> {
  let expression: RegExp;
  try {
    // Per line, so `^` and `$` mean what the caller expects.
    expression = new RegExp(options.pattern);
  } catch (error) {
    throw new InvalidPatternError(
      options.pattern,
      error instanceof Error ? error.message : "could not be compiled",
    );
  }

  const includeFilter = compileInclude(options.include);
  const ignoreRules: IgnoreRule[] = await loadGitIgnoreRules(options.cwd);

  const matches: SearchMatch[] = [];
  let filesScanned = 0;
  let truncated = false;

  const walk = async (directory: string): Promise<void> => {
    if (truncated || filesScanned >= MAX_FILES_SCANNED) return;

    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(directory, { withFileTypes: true }) as never;
    } catch {
      // An unreadable directory is skipped rather than failing the search.
      return;
    }

    for (const entry of entries as unknown as Array<{
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }>) {
      if (truncated || filesScanned >= MAX_FILES_SCANNED) return;
      if (ALWAYS_SKIPPED.has(entry.name)) continue;

      const absolute = join(directory, entry.name);
      const projectPath = relative(options.cwd, absolute).split("\\").join("/");
      const isDirectory = entry.isDirectory();

      if (isGitIgnored(projectPath, isDirectory, ignoreRules)) continue;

      if (isDirectory) {
        await walk(absolute);
        continue;
      }

      if (!entry.isFile()) continue;
      if (includeFilter && !includeFilter.test(entry.name)) continue;

      try {
        const info = await stat(absolute);
        if (info.size > MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }

      let contents: string;
      try {
        contents = await readFile(absolute, "utf-8");
      } catch {
        continue;
      }

      filesScanned += 1;
      if (looksBinary(contents)) continue;

      const lines = contents.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        // A global or sticky pattern would carry lastIndex between lines, so
        // the expression is rebuilt without those flags above.
        if (!expression.test(lines[index]!)) continue;

        matches.push({
          file: projectPath,
          line: index + 1,
          content: truncateLine(lines[index]!),
        });

        if (matches.length >= options.maxMatches) {
          truncated = true;
          return;
        }
      }
    }
  };

  await walk(resolve(options.root));

  return {
    matches,
    ...(truncated ? { truncated: true } : {}),
    filesScanned,
  };
}
