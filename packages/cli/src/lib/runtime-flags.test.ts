import { describe, expect, test } from "bun:test";
import { Mode } from "@termkode/shared";
import { DEFAULT_MAX_STEPS, parseArgs } from "./runtime-flags";

function run(argv: string[]) {
  const parsed = parseArgs(argv);
  if (parsed.kind !== "run") throw new Error(`expected a run, got ${parsed.kind}`);
  return parsed.options;
}

describe("parseArgs", () => {
  test("starts interactive in build mode by default", () => {
    const options = run([]);
    expect(options.prompt).toBeUndefined();
    expect(options.mode).toBe(Mode.BUILD);
    expect(options.skipPermissions).toBe(false);
    expect(options.maxSteps).toBe(DEFAULT_MAX_STEPS);
  });

  test("reads a print prompt", () => {
    expect(run(["-p", "fix the failing test"]).prompt).toBe("fix the failing test");
    expect(run(["--print", "fix it"]).prompt).toBe("fix it");
  });

  test("accepts a bare prompt", () => {
    expect(run(["review this repo"]).prompt).toBe("review this repo");
  });

  test("rejects a print flag with no prompt", () => {
    expect(parseArgs(["-p"]).kind).toBe("error");
    expect(parseArgs(["-p", "--json"]).kind).toBe("error");
  });

  test("reads the mode in every spelling", () => {
    expect(run(["--plan"]).mode).toBe(Mode.PLAN);
    expect(run(["--mode", "plan"]).mode).toBe(Mode.PLAN);
    expect(run(["--mode", "BUILD"]).mode).toBe(Mode.BUILD);
    expect(parseArgs(["--mode", "sideways"]).kind).toBe("error");
  });

  test("takes both spellings of the approval bypass", () => {
    expect(run(["--yolo"]).skipPermissions).toBe(true);
    expect(run(["--dangerously-skip-permissions"]).skipPermissions).toBe(true);
  });

  test("clamps the step cap", () => {
    expect(run(["--max-steps", "5"]).maxSteps).toBe(5);
    expect(run(["--max-steps", "99999"]).maxSteps).toBe(500);
    expect(run(["--max-steps", "0"]).maxSteps).toBe(DEFAULT_MAX_STEPS);
    expect(parseArgs(["--max-steps", "many"]).kind).toBe("error");
  });

  test("only allows json output alongside a printed prompt", () => {
    expect(run(["-p", "hi", "--json"]).json).toBe(true);
    expect(parseArgs(["--json"]).kind).toBe("error");
  });

  test("reports help, version, and unknown flags", () => {
    expect(parseArgs(["--help"]).kind).toBe("help");
    expect(parseArgs(["-v"]).kind).toBe("version");
    expect(parseArgs(["--nonsense"]).kind).toBe("error");
  });

  test("rejects a second bare prompt rather than silently dropping it", () => {
    expect(parseArgs(["-p", "one", "two"]).kind).toBe("error");
  });
});
