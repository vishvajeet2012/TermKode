import { afterEach, describe, expect, test } from "bun:test";
import {
  killBackgroundShell,
  listBackgroundShells,
  readBackgroundOutput,
  resetBackgroundShells,
  startBackgroundShell,
} from "./background-shells";

// The shell differs by platform, so the fixtures are written as portable as
// possible: `echo` and `sleep` exist in Git Bash and in PowerShell alike.
const cwd = process.cwd();

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return check();
}

afterEach(() => {
  resetBackgroundShells();
});

describe("startBackgroundShell", () => {
  test("returns immediately instead of waiting for the command", () => {
    const started = startBackgroundShell("sleep 30", cwd);

    expect(started.id).toMatch(/^bg_\d+$/);
    expect(started.running).toBe(true);
    expect(started.exitCode).toBeNull();
  });

  test("gives each command its own id", () => {
    const first = startBackgroundShell("sleep 30", cwd);
    const second = startBackgroundShell("sleep 30", cwd);

    expect(first.id).not.toBe(second.id);
    expect(listBackgroundShells()).toHaveLength(2);
  });
});

describe("readBackgroundOutput", () => {
  test("collects what the command printed", async () => {
    const { id } = startBackgroundShell("echo hello-from-background", cwd);

    await waitFor(() => readBackgroundOutput(id).stdout.includes("hello-from-background"));

    // The previous read consumed it, so start a fresh command to assert on.
    const second = startBackgroundShell("echo second-line", cwd);
    await waitFor(() => !readBackgroundOutput(second.id).running);

    const output = readBackgroundOutput(second.id);
    expect(output.running).toBe(false);
    expect(output.exitCode).toBe(0);
  });

  test("returns only what is new since the last read", async () => {
    const { id } = startBackgroundShell("echo one", cwd);

    await waitFor(() => readBackgroundOutput(id).stdout.includes("one"));

    // Everything up to here has been handed over already.
    expect(readBackgroundOutput(id).stdout).toBe("");
  });

  test("reports a command that failed", async () => {
    const { id } = startBackgroundShell("exit 3", cwd);

    await waitFor(() => !readBackgroundOutput(id).running);
    expect(readBackgroundOutput(id).exitCode).toBe(3);
  });

  test("filters output to the lines that matter", async () => {
    const { id } = startBackgroundShell("echo alpha; echo beta", cwd);

    await waitFor(() => !readBackgroundOutput(id).running);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const filtered = readBackgroundOutput(id, "beta");
    expect(filtered.stdout).not.toContain("alpha");
  });

  test("rejects an invalid filter instead of matching nothing silently", async () => {
    const { id } = startBackgroundShell("echo alpha", cwd);
    await waitFor(() => !readBackgroundOutput(id).running);

    expect(() => readBackgroundOutput(id, "(unclosed")).toThrow(
      /not a valid regular expression/,
    );
  });

  test("names the ids it does know when given one it does not", () => {
    startBackgroundShell("sleep 30", cwd);

    expect(() => readBackgroundOutput("bg_does_not_exist")).toThrow(/Known ids/);
  });

  test("says nothing is running when the registry is empty", () => {
    expect(() => readBackgroundOutput("bg_1")).toThrow(/Nothing is running/);
  });
});

describe("killBackgroundShell", () => {
  test("stops a command that would otherwise run on", async () => {
    const { id } = startBackgroundShell("sleep 30", cwd);
    expect(readBackgroundOutput(id).running).toBe(true);

    const result = await killBackgroundShell(id);
    expect(result.running).toBe(false);
  });

  test("is harmless on a command that already finished", async () => {
    const { id } = startBackgroundShell("echo done", cwd);
    await waitFor(() => !readBackgroundOutput(id).running);

    const result = await killBackgroundShell(id);
    expect(result.running).toBe(false);
  });
});
