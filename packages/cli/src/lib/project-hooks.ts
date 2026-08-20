import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getShellCommand } from "@termkode/server";

// Some rules cannot live in a prompt: run the formatter after every edit, refuse
// any write to the generated directory, add the current ticket to every prompt.
// A hook is a command the project owns, so those rules hold whether or not the
// model felt like following them.
//
// Configured in .termkode/hooks.json:
//
// {
//   "version": 1,
//   "hooks": {
//     "preToolUse":  [{ "matcher": "writeFile|editFile", "command": "bun run lint" }],
//     "postToolUse": [{ "matcher": "writeFile", "command": "bun run format" }],
//     "userPromptSubmit": [{ "command": "git branch --show-current" }],
//     "sessionStart": [{ "command": "cat .termkode/context.md" }]
//   }
// }

export const HOOKS_CONFIG_RELATIVE_PATH = ".termkode/hooks.json";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARACTERS = 4_000;

/** Exit code that means "do not run this tool call". */
export const HOOK_BLOCK_EXIT_CODE = 2;

const hookSchema = z
  .object({
    /** Regex tested against the tool name. Omitted means every tool. */
    matcher: z.string().trim().min(1).optional(),
    command: z.string().trim().min(1),
    timeout: z.number().int().positive().max(600_000).optional(),
  })
  .strict();

const hooksConfigSchema = z
  .object({
    version: z.literal(1),
    hooks: z
      .object({
        preToolUse: z.array(hookSchema).default([]),
        postToolUse: z.array(hookSchema).default([]),
        userPromptSubmit: z.array(hookSchema).default([]),
        sessionStart: z.array(hookSchema).default([]),
      })
      .default({
        preToolUse: [],
        postToolUse: [],
        userPromptSubmit: [],
        sessionStart: [],
      }),
  })
  .strict();

export type HookEvent = keyof z.infer<typeof hooksConfigSchema>["hooks"];
export type HookDefinition = z.infer<typeof hookSchema>;
export type HooksConfig = z.infer<typeof hooksConfigSchema>;

const EMPTY_CONFIG: HooksConfig = {
  version: 1,
  hooks: { preToolUse: [], postToolUse: [], userPromptSubmit: [], sessionStart: [] },
};

let cache: { path: string; mtimeMs: number; config: HooksConfig } | null = null;

function loadHooksConfig(cwd = process.cwd()): HooksConfig {
  const path = join(cwd, HOOKS_CONFIG_RELATIVE_PATH);

  if (!existsSync(path)) {
    cache = null;
    return EMPTY_CONFIG;
  }

  try {
    const { mtimeMs } = statSync(path);
    if (cache && cache.path === path && cache.mtimeMs === mtimeMs) {
      return cache.config;
    }

    const parsed = hooksConfigSchema.safeParse(JSON.parse(readFileSync(path, "utf-8")));
    if (!parsed.success) {
      // A broken hooks file must not take the session down with it. The user
      // sees the problem the first time a hook fails to fire.
      console.warn(`Ignoring ${HOOKS_CONFIG_RELATIVE_PATH}: ${parsed.error.issues[0]?.message}`);
      return EMPTY_CONFIG;
    }

    cache = { path, mtimeMs, config: parsed.data };
    return parsed.data;
  } catch {
    return EMPTY_CONFIG;
  }
}

function matches(hook: HookDefinition, toolName: string) {
  if (!hook.matcher) return true;

  try {
    return new RegExp(hook.matcher).test(toolName);
  } catch {
    // An invalid pattern matches nothing rather than everything, so a typo
    // cannot silently block every tool call.
    return false;
  }
}

export type HookPayload = {
  event: HookEvent;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  prompt?: string;
  sessionId?: string;
};

export type HookOutcome = {
  /** True when a preToolUse hook exited with code 2. */
  blocked: boolean;
  /** Why it was blocked, or why it failed. */
  reason?: string;
  /** Anything the hook printed, to be handed back to the model. */
  output: string;
};

function truncate(value: string) {
  const trimmed = value.trim();
  return trimmed.length > MAX_OUTPUT_CHARACTERS
    ? `${trimmed.slice(0, MAX_OUTPUT_CHARACTERS)}\n... (hook output truncated)`
    : trimmed;
}

async function runHook(hook: HookDefinition, payload: HookPayload): Promise<HookOutcome> {
  const serialized = JSON.stringify(payload);

  try {
    const proc = Bun.spawn(getShellCommand(hook.command), {
      cwd: process.cwd(),
      stdin: new TextEncoder().encode(serialized),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TERM: "dumb",
        TERMKODE_HOOK_EVENT: payload.event,
        ...(payload.toolName ? { TERMKODE_TOOL_NAME: payload.toolName } : {}),
        ...(payload.sessionId ? { TERMKODE_SESSION_ID: payload.sessionId } : {}),
      },
    });

    const timer = setTimeout(() => proc.kill(), hook.timeout ?? DEFAULT_TIMEOUT_MS);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);

    if (exitCode === HOOK_BLOCK_EXIT_CODE) {
      return {
        blocked: true,
        reason: truncate(stderr || stdout) || `Blocked by hook: ${hook.command}`,
        output: truncate(stdout),
      };
    }

    if (exitCode !== 0) {
      // A hook that fails for its own reasons is reported, not obeyed: only
      // exit code 2 is a decision about the tool call.
      return {
        blocked: false,
        reason: `Hook "${hook.command}" exited with code ${exitCode}${stderr ? `: ${truncate(stderr)}` : ""}`,
        output: truncate(stdout),
      };
    }

    return { blocked: false, output: truncate(stdout) };
  } catch (error) {
    return {
      blocked: false,
      reason: `Hook "${hook.command}" could not run: ${
        error instanceof Error ? error.message : String(error)
      }`,
      output: "",
    };
  }
}

export type HookRunResult = {
  blocked: boolean;
  /** The reason the first blocking hook gave. */
  reason?: string;
  /** Combined stdout of every hook that ran, for the model to read. */
  output: string;
  /** Non-fatal problems worth surfacing as a toast. */
  warnings: string[];
};

const NOTHING: HookRunResult = { blocked: false, output: "", warnings: [] };

export async function runHooks(
  event: HookEvent,
  payload: Omit<HookPayload, "event">,
): Promise<HookRunResult> {
  const config = loadHooksConfig();
  const hooks = config.hooks[event].filter((hook) => matches(hook, payload.toolName ?? ""));

  if (hooks.length === 0) return NOTHING;

  const outputs: string[] = [];
  const warnings: string[] = [];

  for (const hook of hooks) {
    const outcome = await runHook(hook, { ...payload, event });

    if (outcome.output) outputs.push(outcome.output);

    if (outcome.blocked) {
      return {
        blocked: true,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        output: outputs.join("\n"),
        warnings,
      };
    }

    if (outcome.reason) warnings.push(outcome.reason);
  }

  return { blocked: false, output: outputs.join("\n"), warnings };
}
