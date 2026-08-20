import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// Almost every request in a coding session is about work in progress: which
// branch it is on, what is already staged, what was changed but not committed.
// Without it the model asks for a `git status` it could have been handed, or
// worse, assumes a clean tree and overwrites something.

export type GitStatusEntry = {
  /** Two-character porcelain code, e.g. " M", "A ", "??". */
  code: string;
  path: string;
};

export type GitContext = {
  isRepository: boolean;
  branch?: string;
  /** Commits ahead of / behind the upstream branch, when one is configured. */
  ahead?: number;
  behind?: number;
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: GitStatusEntry[];
  recentCommits: string[];
  /** True when the change list was cut short. */
  truncated?: boolean;
};

const NOT_A_REPOSITORY: GitContext = {
  isRepository: false,
  staged: [],
  unstaged: [],
  untracked: [],
  recentCommits: [],
};

// A slow or hung git call must never hold up a chat request.
const GIT_TIMEOUT_MS = 2_000;
const MAX_STATUS_ENTRIES = 20;
const MAX_COMMITS = 5;

function runGit(cwd: string, args: string[]): string | null {
  try {
    const result = spawnSync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf-8",
      windowsHide: true,
      // Some git subcommands page or prompt; neither can be answered here.
      env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
    });

    if (result.error || result.status !== 0) return null;
    return result.stdout ?? "";
  } catch {
    return null;
  }
}

function findRepositoryRoot(cwd: string): string | null {
  let directory = resolve(cwd);

  for (let level = 0; level < 24; level += 1) {
    if (existsSync(join(directory, ".git"))) return directory;

    const parent = resolve(directory, "..");
    if (parent === directory) return null;
    directory = parent;
  }

  return null;
}

function parseStatus(output: string) {
  const staged: GitStatusEntry[] = [];
  const unstaged: GitStatusEntry[] = [];
  const untracked: GitStatusEntry[] = [];
  let truncated = false;

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;

    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (!path) continue;

    if (staged.length + unstaged.length + untracked.length >= MAX_STATUS_ENTRIES) {
      truncated = true;
      break;
    }

    if (code === "??") {
      untracked.push({ code, path });
      continue;
    }

    // The first column is the index, the second the working tree, so a file can
    // legitimately appear in both lists.
    if (code[0] !== " " && code[0] !== "?") staged.push({ code, path });
    if (code[1] !== " " && code[1] !== "?") unstaged.push({ code, path });
  }

  return { staged, unstaged, untracked, truncated };
}

function parseTracking(branchLine: string) {
  const ahead = branchLine.match(/ahead (\d+)/)?.[1];
  const behind = branchLine.match(/behind (\d+)/)?.[1];

  return {
    ...(ahead ? { ahead: Number(ahead) } : {}),
    ...(behind ? { behind: Number(behind) } : {}),
  };
}

export function readGitContext(cwd?: string): GitContext {
  const workingDirectory = cwd ?? process.cwd();
  if (!findRepositoryRoot(workingDirectory)) return NOT_A_REPOSITORY;

  const status = runGit(workingDirectory, ["status", "--porcelain=v1", "--branch"]);
  if (status === null) return NOT_A_REPOSITORY;

  const [branchLine = "", ...statusLines] = status.split("\n");
  const branch = branchLine.match(/^## (?:No commits yet on )?([^.\s]+)/)?.[1];
  const { staged, unstaged, untracked, truncated } = parseStatus(statusLines.join("\n"));

  const log = runGit(workingDirectory, [
    "log",
    `-${MAX_COMMITS}`,
    "--no-merges",
    "--pretty=format:%h %s",
  ]);

  return {
    isRepository: true,
    ...(branch ? { branch } : {}),
    ...parseTracking(branchLine),
    staged,
    unstaged,
    untracked,
    recentCommits: (log ?? "").split("\n").filter(Boolean),
    ...(truncated ? { truncated: true } : {}),
  };
}

/** The git section of the system prompt, or null when this is not a repository. */
export function describeGitContext(context: GitContext): string | null {
  if (!context.isRepository) return null;

  const lines: string[] = [];
  const tracking = [
    context.ahead ? `${context.ahead} ahead` : null,
    context.behind ? `${context.behind} behind` : null,
  ]
    .filter(Boolean)
    .join(", ");

  lines.push(`- Branch: ${context.branch ?? "detached HEAD"}${tracking ? ` (${tracking})` : ""}`);

  const describe = (entries: GitStatusEntry[]) =>
    entries.map((entry) => `${entry.code.trim() || "M"} ${entry.path}`).join(", ");

  if (context.staged.length > 0) lines.push(`- Staged: ${describe(context.staged)}`);
  if (context.unstaged.length > 0) lines.push(`- Modified: ${describe(context.unstaged)}`);
  if (context.untracked.length > 0) {
    lines.push(`- Untracked: ${context.untracked.map((entry) => entry.path).join(", ")}`);
  }
  if (context.truncated) lines.push("- (more changes not listed)");

  if (
    context.staged.length === 0 &&
    context.unstaged.length === 0 &&
    context.untracked.length === 0
  ) {
    lines.push("- Working tree is clean");
  }

  if (context.recentCommits.length > 0) {
    lines.push(`- Recent commits:\n${context.recentCommits.map((commit) => `  ${commit}`).join("\n")}`);
  }

  return lines.join("\n");
}

/** The prompt behind `/commit`, so the message matches this repository's style. */
export const COMMIT_PROMPT = `Commit the current work in this repository.

1. Run git status, git diff, and git diff --staged to see everything that changed,
   and git log -10 --oneline to learn the message style this repository uses.
2. Stage the files that belong in this commit. Leave out anything unrelated,
   generated, or secret, and say so if you skip something.
3. Write a commit message that matches the existing style and explains why the
   change was made, not just what changed.
4. Commit, then run git status to confirm the result.

Do not push, do not amend an existing commit, and do not add a co-author or tool
attribution line unless this repository's history already uses one.`;
