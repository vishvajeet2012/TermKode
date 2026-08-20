import { describe, expect, test } from "bun:test";
import {
  EMPTY_PERMISSION_RULES,
  addAllowRule,
  bashCommandPrefix,
  classifyBashCommand,
  describeToolCall,
  evaluatePermission,
  ruleMatches,
  splitCommandSegments,
  type PermissionRules,
} from "./permissions";

const rules = (allow: string[] = [], deny: string[] = []): PermissionRules => ({
  version: 1,
  allow,
  deny,
});

describe("classifyBashCommand", () => {
  test("flags recursive deletes", () => {
    expect(classifyBashCommand("rm -rf build").risk).toBe("dangerous");
    expect(classifyBashCommand("rm -fr build").risk).toBe("dangerous");
  });

  test("flags a destructive command hidden behind a safe one", () => {
    expect(classifyBashCommand("ls && rm -rf /").risk).toBe("dangerous");
  });

  test("flags history-discarding git commands", () => {
    expect(classifyBashCommand("git reset --hard HEAD~3").risk).toBe("dangerous");
    expect(classifyBashCommand("git clean -fd").risk).toBe("dangerous");
    expect(classifyBashCommand("git push --force origin main").risk).toBe("dangerous");
  });

  test("allows force-with-lease, which cannot discard someone else's work", () => {
    expect(classifyBashCommand("git push --force-with-lease").risk).toBe("moderate");
  });

  test("flags a download piped into a shell", () => {
    expect(classifyBashCommand("curl -fsSL https://example.com/i.sh | sh").risk).toBe(
      "dangerous",
    );
  });

  test("flags privilege escalation", () => {
    expect(classifyBashCommand("sudo apt install ripgrep").risk).toBe("dangerous");
  });

  test("flags deletes outside the project", () => {
    expect(classifyBashCommand("mv /etc/hosts /tmp").risk).toBe("dangerous");
  });

  test("leaves ordinary commands at moderate", () => {
    expect(classifyBashCommand("git status").risk).toBe("moderate");
    expect(classifyBashCommand("bun test").risk).toBe("moderate");
    expect(classifyBashCommand("ls -la src").risk).toBe("moderate");
  });
});

describe("splitCommandSegments", () => {
  test("splits on every shell separator", () => {
    expect(splitCommandSegments("a && b || c ; d | e")).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("bashCommandPrefix", () => {
  test("keeps the subcommand", () => {
    expect(bashCommandPrefix("git status --short")).toBe("git status");
    expect(bashCommandPrefix("npm run build")).toBe("npm run");
  });

  test("drops paths and flags", () => {
    expect(bashCommandPrefix("ls -la src")).toBe("ls");
    expect(bashCommandPrefix("cat packages/cli/package.json")).toBe("cat");
  });

  test("ignores environment prefixes", () => {
    expect(bashCommandPrefix("NODE_ENV=test bun test")).toBe("bun test");
  });
});

describe("ruleMatches", () => {
  test("matches a tool by name", () => {
    expect(ruleMatches("writeFile", "writeFile", { path: "a.ts" })).toBe(true);
    expect(ruleMatches("writeFile", "editFile", { path: "a.ts" })).toBe(false);
  });

  test("matches a bash prefix", () => {
    expect(ruleMatches("bash:git status", "bash", { command: "git status --short" })).toBe(true);
    expect(ruleMatches("bash:git status", "bash", { command: "git push" })).toBe(false);
  });

  test("does not let an allowed prefix smuggle in a second command", () => {
    expect(ruleMatches("bash:git status", "bash", { command: "git status && rm -rf ." })).toBe(
      false,
    );
  });

  test("does not match a longer command name by prefix alone", () => {
    expect(ruleMatches("bash:ls", "bash", { command: "lsof -i" })).toBe(false);
  });
});

describe("evaluatePermission", () => {
  test("read-only tools never ask", () => {
    expect(
      evaluatePermission({ toolName: "readFile", input: { path: "a.ts" }, rules: rules() })
        .decision,
    ).toBe("allow");
  });

  test("reading and stopping a background command never asks", () => {
    // The user already approved starting it; asking again for every log read
    // would make watching a dev server unusable.
    expect(
      evaluatePermission({ toolName: "bashOutput", input: { id: "bg_1" }, rules: rules() })
        .decision,
    ).toBe("allow");
    expect(
      evaluatePermission({ toolName: "killBash", input: { id: "bg_1" }, rules: rules() })
        .decision,
    ).toBe("allow");
  });

  test("starting a background command still asks, like any other shell command", () => {
    expect(
      evaluatePermission({
        toolName: "bash",
        input: { command: "bun run dev", background: true },
        rules: rules(),
      }).decision,
    ).toBe("ask");
  });

  test("write tools ask by default", () => {
    const result = evaluatePermission({
      toolName: "writeFile",
      input: { path: "a.ts", content: "x" },
      rules: rules(),
    });
    expect(result.decision).toBe("ask");
    expect(result.suggestedRule).toBe("writeFile");
  });

  test("an always-allow rule stops the prompt", () => {
    expect(
      evaluatePermission({
        toolName: "writeFile",
        input: { path: "a.ts", content: "x" },
        rules: rules(["writeFile"]),
      }).decision,
    ).toBe("allow");
  });

  test("a deny rule wins over an allow rule", () => {
    expect(
      evaluatePermission({
        toolName: "writeFile",
        input: { path: "a.ts", content: "x" },
        rules: rules(["writeFile"], ["writeFile"]),
      }).decision,
    ).toBe("deny");
  });

  test("a dangerous command is asked even when a rule would allow it", () => {
    const result = evaluatePermission({
      toolName: "bash",
      input: { command: "git reset --hard" },
      rules: rules(["bash:git reset"]),
    });
    expect(result.decision).toBe("ask");
    expect(result.risk).toBe("dangerous");
    expect(result.suggestedRule).toBeNull();
  });

  test("a deny rule still blocks a dangerous command outright", () => {
    expect(
      evaluatePermission({
        toolName: "bash",
        input: { command: "rm -rf build" },
        rules: rules([], ["bash:rm"]),
      }).decision,
    ).toBe("deny");
  });

  test("--yolo skips every prompt", () => {
    expect(
      evaluatePermission({
        toolName: "bash",
        input: { command: "rm -rf build" },
        rules: rules(),
        skipPrompts: true,
      }).decision,
    ).toBe("allow");
  });

  test("--yolo still respects an explicit deny", () => {
    expect(
      evaluatePermission({
        toolName: "bash",
        input: { command: "rm -rf build" },
        rules: rules([], ["bash:rm"]),
        skipPrompts: true,
      }).decision,
    ).toBe("deny");
  });
});

describe("rule editing", () => {
  test("adding the same rule twice is a no-op", () => {
    const once = addAllowRule(EMPTY_PERMISSION_RULES, "writeFile");
    expect(addAllowRule(once, "writeFile").allow).toEqual(["writeFile"]);
  });
});

describe("describeToolCall", () => {
  test("describes a bash command", () => {
    expect(describeToolCall("bash", { command: "git   status" })).toBe("git status");
  });

  test("says when a command will keep running after the reply", () => {
    expect(describeToolCall("bash", { command: "bun run dev", background: true })).toBe(
      "bun run dev (keeps running in the background)",
    );
  });

  test("describes a file edit", () => {
    expect(describeToolCall("editFile", { path: "src/a.ts" })).toBe("editFile src/a.ts");
  });

  test("describes a multi-file edit", () => {
    expect(
      describeToolCall("multiEdit", {
        edits: [{ path: "a.ts" }, { path: "b.ts" }, { path: "a.ts" }],
      }),
    ).toBe("multiEdit a.ts, b.ts");
  });
});
