import { Mode, type ModeType } from "@termkode/shared";

// The terminal UI, the tool runner, and the headless runner all need the same
// answers about how this invocation was started. Flags are parsed once and put
// in the environment, so any module can read them without threading options
// through every call.

const YOLO_ENV_VAR = "TERMKODE_SKIP_PERMISSIONS";
const MAX_STEPS_ENV_VAR = "TERMKODE_MAX_STEPS";
const MODE_ENV_VAR = "TERMKODE_MODE";

/**
 * How many tool rounds the agent may take for one user message before it stops
 * and asks. A confused model - a small local one especially - will otherwise
 * loop on the same failing call until the user notices, spending real money.
 */
export const DEFAULT_MAX_STEPS = 40;
const MAX_STEPS_CEILING = 500;

export type CliOptions = {
  /** Set by -p / --print: run once, print the answer, and exit. */
  prompt?: string;
  mode: ModeType;
  /** --yolo: run every tool without asking. */
  skipPermissions: boolean;
  maxSteps: number;
  /** --json: machine-readable headless output. */
  json: boolean;
};

export type ParsedArgs =
  | { kind: "run"; options: CliOptions }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

function parseMaxSteps(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), MAX_STEPS_CEILING);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const options: CliOptions = {
    mode: Mode.BUILD,
    skipPermissions: false,
    maxSteps: DEFAULT_MAX_STEPS,
    json: false,
  };

  let promptSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;

    switch (arg) {
      case "-h":
      case "--help":
        return { kind: "help" };
      case "-v":
      case "--version":
        return { kind: "version" };
      case "-p":
      case "--print": {
        const value = argv[index + 1];
        if (!value || value.startsWith("-")) {
          return { kind: "error", message: "--print needs a prompt, for example: termkode -p \"fix the failing test\"" };
        }
        options.prompt = value;
        promptSeen = true;
        index += 1;
        break;
      }
      case "--mode": {
        const value = argv[index + 1]?.toUpperCase();
        if (value !== Mode.BUILD && value !== Mode.PLAN) {
          return { kind: "error", message: "--mode must be BUILD or PLAN" };
        }
        options.mode = value;
        index += 1;
        break;
      }
      case "--plan":
        options.mode = Mode.PLAN;
        break;
      case "--build":
        options.mode = Mode.BUILD;
        break;
      case "--yolo":
      case "--dangerously-skip-permissions":
        options.skipPermissions = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--max-steps": {
        const value = argv[index + 1];
        if (!value || Number.isNaN(Number(value))) {
          return { kind: "error", message: "--max-steps needs a number" };
        }
        options.maxSteps = parseMaxSteps(value, DEFAULT_MAX_STEPS);
        index += 1;
        break;
      }
      default:
        // A bare argument after nothing else is the prompt, so
        // `termkode -p "..."` and `termkode --print "..."` both read naturally
        // and an unknown flag is still reported.
        if (arg.startsWith("-")) {
          return { kind: "error", message: `Unknown option: ${arg}` };
        }
        if (promptSeen) {
          return { kind: "error", message: `Unexpected argument: ${arg}` };
        }
        options.prompt = arg;
        promptSeen = true;
    }
  }

  if (options.json && !options.prompt) {
    return { kind: "error", message: "--json only applies with --print" };
  }

  return { kind: "run", options };
}

/** Publishes the parsed flags so the rest of the process can read them. */
export function applyRuntimeFlags(options: CliOptions) {
  if (options.skipPermissions) process.env[YOLO_ENV_VAR] = "1";
  process.env[MAX_STEPS_ENV_VAR] = String(options.maxSteps);
  process.env[MODE_ENV_VAR] = options.mode;
}

export function shouldSkipPermissions() {
  return process.env[YOLO_ENV_VAR] === "1";
}

export function getMaxSteps() {
  return parseMaxSteps(process.env[MAX_STEPS_ENV_VAR], DEFAULT_MAX_STEPS);
}

export function getInitialMode(): ModeType {
  return process.env[MODE_ENV_VAR] === Mode.PLAN ? Mode.PLAN : Mode.BUILD;
}
