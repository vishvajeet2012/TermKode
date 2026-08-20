import { describeToolCall, isWriteTool, type ToolRisk } from "@termkode/shared";
import { createCheckpoint, type Checkpoint } from "./checkpoints";
import { executeLocalTool } from "./local-tools";
import {
  decidePermission,
  loadPermissionRules,
  rememberAllowRule,
  rememberDenyRule,
} from "./permissions";
import { runHooks } from "./project-hooks";
import { shouldSkipPermissions } from "./runtime-flags";
import type { ModeType } from "@termkode/shared";

// Everything that has to happen around a tool call - ask the user, run the
// project's hooks, snapshot the files it will change - happens here, so no
// caller can reach `executeLocalTool` and skip a step. The terminal UI and the
// headless runner both go through this function.

export type PermissionPrompt = {
  toolName: string;
  input: unknown;
  /** One line describing the call, for the approval dialog. */
  description: string;
  risk: ToolRisk;
  reason?: string;
  /** The rule "always allow" would store, or null when it must not be offered. */
  suggestedRule: string | null;
};

export type PermissionAnswer =
  | "allow-once"
  | "allow-always"
  | "reject"
  | "reject-always";

/** Asks the user. Returning "reject" refuses the call. */
export type PermissionAsk = (prompt: PermissionPrompt) => Promise<PermissionAnswer>;

/**
 * A call the user (or a rule, or a hook) refused. It is reported to the model
 * as a tool error so it can change course, and is never retried automatically.
 */
export class ToolRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRefusedError";
  }
}

export type RunToolCallOptions = {
  sessionId: string;
  toolName: string;
  input: unknown;
  mode: ModeType;
  /** Omitted in headless runs, where there is nobody to ask. */
  ask?: PermissionAsk;
  /** Called once a checkpoint exists, so the UI can offer to rewind to it. */
  onCheckpoint?: (checkpoint: Checkpoint) => void;
  /** Non-fatal hook problems, surfaced as a toast rather than a tool error. */
  onWarning?: (message: string) => void;
};

export async function runToolCall({
  sessionId,
  toolName,
  input,
  mode,
  ask,
  onCheckpoint,
  onWarning,
}: RunToolCallOptions): Promise<unknown> {
  await loadPermissionRules();

  const evaluation = decidePermission(toolName, input);

  if (evaluation.decision === "deny") {
    throw new ToolRefusedError(
      `The user has blocked this call with the rule "${evaluation.matchedRule}". Do not try it again; ask what they would like instead.`,
    );
  }

  if (evaluation.decision === "ask") {
    if (!ask) {
      throw new ToolRefusedError(
        shouldSkipPermissions()
          ? `${toolName} needs approval and this session cannot ask.`
          : `${toolName} needs the user's approval and this session is not interactive. Re-run with --yolo to allow tool calls without asking, or use --mode PLAN for read-only work.`,
      );
    }

    const answer = await ask({
      toolName,
      input,
      description: describeToolCall(toolName, input),
      risk: evaluation.risk,
      ...(evaluation.reason ? { reason: evaluation.reason } : {}),
      suggestedRule: evaluation.suggestedRule,
    });

    if (answer === "reject" || answer === "reject-always") {
      if (answer === "reject-always" && evaluation.suggestedRule) {
        await rememberDenyRule(evaluation.suggestedRule).catch(() => {
          onWarning?.("Could not save that refusal; it applies to this call only.");
        });
      }

      throw new ToolRefusedError(
        "The user rejected this tool call. Stop and ask them how they would like to proceed instead of retrying or working around it.",
      );
    }

    if (answer === "allow-always" && evaluation.suggestedRule) {
      try {
        await rememberAllowRule(evaluation.suggestedRule);
      } catch {
        // Failing to remember the answer is not a reason to refuse the call the
        // user just approved.
        onWarning?.("Could not save that permission; it applies to this call only.");
      }
    }
  }

  const preHooks = await runHooks("preToolUse", { toolName, input, sessionId });
  for (const warning of preHooks.warnings) onWarning?.(warning);

  if (preHooks.blocked) {
    throw new ToolRefusedError(
      `Blocked by a project hook: ${preHooks.reason ?? "no reason given"}`,
    );
  }

  // The snapshot has to exist before the write, not after it.
  if (isWriteTool(toolName)) {
    const checkpoint = createCheckpoint(sessionId, toolName, input);
    if (checkpoint) onCheckpoint?.(checkpoint);
  }

  const output = await executeLocalTool(toolName, input, mode);

  const postHooks = await runHooks("postToolUse", { toolName, input, output, sessionId });
  for (const warning of postHooks.warnings) onWarning?.(warning);

  const hookOutput = [preHooks.output, postHooks.output].filter(Boolean).join("\n");

  return hookOutput && output && typeof output === "object"
    ? { ...output, hookOutput }
    : output;
}
