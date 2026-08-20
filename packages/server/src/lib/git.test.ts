import { describe, expect, test } from "bun:test";
import { describeGitContext, readGitContext, type GitContext } from "./git";

const base: GitContext = {
  isRepository: true,
  branch: "main",
  staged: [],
  unstaged: [],
  untracked: [],
  recentCommits: [],
};

describe("describeGitContext", () => {
  test("says nothing when the directory is not a repository", () => {
    expect(describeGitContext({ ...base, isRepository: false })).toBeNull();
  });

  test("reports a clean tree explicitly, so the model does not assume otherwise", () => {
    const described = describeGitContext(base)!;

    expect(described).toContain("Branch: main");
    expect(described).toContain("Working tree is clean");
  });

  test("separates staged, modified, and untracked files", () => {
    const described = describeGitContext({
      ...base,
      staged: [{ code: "A ", path: "added.ts" }],
      unstaged: [{ code: " M", path: "changed.ts" }],
      untracked: [{ code: "??", path: "new.ts" }],
    })!;

    expect(described).toContain("Staged: A added.ts");
    expect(described).toContain("Modified: M changed.ts");
    expect(described).toContain("Untracked: new.ts");
    expect(described).not.toContain("Working tree is clean");
  });

  test("includes how far the branch has drifted from its upstream", () => {
    const described = describeGitContext({ ...base, ahead: 2, behind: 1 })!;
    expect(described).toContain("(2 ahead, 1 behind)");
  });

  test("lists recent commits", () => {
    const described = describeGitContext({
      ...base,
      recentCommits: ["abc1234 fix the parser"],
    })!;

    expect(described).toContain("abc1234 fix the parser");
  });

  test("says when the change list was cut short", () => {
    const described = describeGitContext({
      ...base,
      unstaged: [{ code: " M", path: "a.ts" }],
      truncated: true,
    })!;

    expect(described).toContain("more changes not listed");
  });
});

describe("readGitContext", () => {
  test("reports a directory with no repository instead of throwing", () => {
    const context = readGitContext(process.env.TEMP ?? "/tmp");
    expect(typeof context.isRepository).toBe("boolean");
    expect(context.staged).toEqual([]);
  });
});
