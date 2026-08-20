// TermKode runs tools on the user's own machine with their own permissions.
// `bash` in particular is a real shell, so a model that picks the wrong command
// can destroy work that no provider ever sees. Every risky call is classified
// here, in one place, so the CLI, the headless runner, and the tests all agree
// on what needs a human answer before it runs.

export type PermissionDecision = "allow" | "ask" | "deny";

/**
 * How much damage a call can do if the model got it wrong.
 * - `safe` reads something and changes nothing.
 * - `moderate` writes inside the project, and is undone by a checkpoint.
 * - `dangerous` deletes, overwrites, or reaches outside the project. These are
 *   never remembered as an always-allow rule: they are asked every time.
 */
export type ToolRisk = "safe" | "moderate" | "dangerous";

export type PermissionRules = {
  version: 1;
  /** Rules that let a matching call run without asking. */
  allow: string[];
  /** Rules that refuse a matching call outright. Checked before `allow`. */
  deny: string[];
};

export const EMPTY_PERMISSION_RULES: PermissionRules = {
  version: 1,
  allow: [],
  deny: [],
};

/** Tools that only read, and so never need an answer from the user. */
export const READ_ONLY_TOOL_NAMES = [
  "readFile",
  "listDirectory",
  "glob",
  "grep",
  "fetchUrl",
  "webSearch",
  "readPdf",
  "todoWrite",
] as const;

/** Tools that write to the project and are covered by checkpoints. */
export const WRITE_TOOL_NAMES = ["writeFile", "editFile", "multiEdit"] as const;

// Reading a background command's output, or stopping one, only affects a
// process TermKode itself started and the user already approved. Asking again
// for those would make watching a dev server unusable, so they are never
// prompted - but they are still BUILD-only, because there is nothing to read or
// stop unless `bash` ran first.
const NO_APPROVAL_TOOL_NAMES: readonly string[] = [
  ...READ_ONLY_TOOL_NAMES,
  "bashOutput",
  "killBash",
];

export function isReadOnlyTool(toolName: string) {
  return (READ_ONLY_TOOL_NAMES as readonly string[]).includes(toolName);
}

/** True when a call never needs the user's answer, whatever the stored rules say. */
export function needsNoApproval(toolName: string) {
  return NO_APPROVAL_TOOL_NAMES.includes(toolName);
}

export function isWriteTool(toolName: string) {
  return (WRITE_TOOL_NAMES as readonly string[]).includes(toolName);
}

// A command is judged by every segment it contains: `ls && rm -rf /` is as
// destructive as `rm -rf /` on its own.
const COMMAND_SEPARATORS = /\s*(?:&&|\|\||;|\|)\s*/;

export function splitCommandSegments(command: string): string[] {
  return command
    .split("\n")
    .flatMap((line) => line.split(COMMAND_SEPARATORS))
    .map((segment) => segment.trim())
    .filter(Boolean);
}

type DangerousPattern = { pattern: RegExp; reason: string };

const DANGEROUS_PATTERNS: DangerousPattern[] = [
  { pattern: /\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[rf]/, reason: "recursive or forced delete" },
  { pattern: /\brmdir\s+\/s/i, reason: "recursive directory delete" },
  { pattern: /\b(?:del|erase)\s+\/[sq]/i, reason: "recursive delete" },
  { pattern: /\bRemove-Item\b[\s\S]*-Recurse/i, reason: "recursive delete" },
  { pattern: /\bmkfs\b|\bfdisk\b|\bdiskpart\b|\bformat\s+[a-z]:/i, reason: "disk formatting" },
  { pattern: /\bdd\s+[^\n]*\bof=/, reason: "raw disk write" },
  { pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/, reason: "shuts the machine down" },
  { pattern: /\b(?:kill|killall|pkill)\s+-9\b|\bStop-Computer\b/i, reason: "force-kills processes" },
  {
    pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*[fd]|push\s+[^\n]*--force(?!-with-lease))/,
    reason: "discards git history or work",
  },
  { pattern: /\bgit\s+checkout\s+--\s+\./, reason: "discards uncommitted changes" },
  {
    pattern: /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[\s\S]*\|\s*(?:ba|z|d|k)?sh\b/i,
    reason: "pipes a download into a shell",
  },
  { pattern: /\bchmod\s+(?:-R\s+)?0?777\b/, reason: "world-writable permissions" },
  { pattern: /\b(?:sudo|doas|runas)\b/i, reason: "runs with elevated privileges" },
  {
    pattern: /\b(?:npm|yarn|bun|pnpm|cargo)\s+publish\b/,
    reason: "publishes a package",
  },
  { pattern: />\s*\/dev\/(?:sd|nvme|hd)/, reason: "writes to a raw device" },
  { pattern: /:\(\)\s*\{[^}]*\};\s*:/, reason: "fork bomb" },
];

// Deleting or overwriting outside the project is worse than inside it, and the
// project directory is the one place a checkpoint can undo.
const OUTSIDE_PROJECT_PATTERN =
  /(?:^|\s)(?:\/(?:etc|usr|bin|sbin|var|boot|dev|sys|proc|System|Windows)\b|[A-Za-z]:[\\/](?:Windows|Program Files)|~\/|\$HOME\b)/;

export type BashClassification = {
  risk: ToolRisk;
  /** Why it was flagged, phrased for the approval prompt. */
  reason?: string;
};

export function classifyBashCommand(command: string): BashClassification {
  const segments = splitCommandSegments(command);

  // The whole command is checked as well as its parts: piping a download into a
  // shell is only recognisable with the pipe still in it, and a pattern that
  // matches too eagerly costs one extra prompt rather than a lost repository.
  for (const candidate of [command, ...segments]) {
    for (const { pattern, reason } of DANGEROUS_PATTERNS) {
      if (pattern.test(candidate)) return { risk: "dangerous", reason };
    }
  }

  for (const segment of segments) {
    if (
      /\b(?:rm|mv|cp|del|Remove-Item)\b/i.test(segment) &&
      OUTSIDE_PROJECT_PATTERN.test(segment)
    ) {
      return { risk: "dangerous", reason: "touches files outside the project" };
    }
  }

  return { risk: "moderate" };
}

// Environment assignments and wrapper commands are not what the user is
// agreeing to, so they never become part of a remembered rule.
const PREFIX_NOISE = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*|command|nohup|time|env)$/;

/**
 * The short, recognisable head of a command - `git status`, `npm run`, `ls` -
 * used as the body of an always-allow rule. Subcommands are kept because
 * `git status` and `git push` deserve different answers.
 */
export function bashCommandPrefix(command: string): string {
  const [segment = ""] = splitCommandSegments(command);
  const tokens = segment
    .split(/\s+/)
    .filter(Boolean)
    .filter((token, index) => !(index === 0 && PREFIX_NOISE.test(token)));

  const head = tokens[0];
  if (!head) return "";

  const second = tokens[1];
  // A flag is not a subcommand, and a path argument is too specific to remember.
  if (
    second &&
    /^[a-z][a-z0-9:_-]*$/i.test(second) &&
    !second.includes("/") &&
    !second.includes(".")
  ) {
    return `${head} ${second}`;
  }

  return head;
}

/**
 * Rules are plain strings so `~/.termkode/permissions.json` stays readable:
 * - `writeFile` - any call to that tool
 * - `bash:git status` - bash commands starting with that prefix
 *
 * MCP tools are not covered here: they are already allow-listed per tool in
 * `.termkode/mcp.json`, and they run in the server process rather than through
 * the client's tool runner.
 */
export function ruleMatches(rule: string, toolName: string, input: unknown): boolean {
  const trimmed = rule.trim();
  if (!trimmed) return false;

  if (trimmed.startsWith("bash:")) {
    if (toolName !== "bash") return false;
    const command = readCommand(input);
    if (!command) return false;

    const wanted = trimmed.slice("bash:".length).trim();
    if (!wanted) return false;

    // Every segment must be covered, so an allowed prefix cannot smuggle in a
    // second command after `&&`.
    return splitCommandSegments(command).every((segment) =>
      segmentMatchesPrefix(segment, wanted),
    );
  }

  return trimmed === toolName;
}

function segmentMatchesPrefix(segment: string, prefix: string) {
  const normalized = segment.replace(/\s+/g, " ").trim();
  const wanted = prefix.replace(/\s+/g, " ").trim();
  if (normalized === wanted) return true;
  return normalized.startsWith(`${wanted} `);
}

function readCommand(input: unknown): string | null {
  if (input && typeof input === "object" && "command" in input) {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string") return command;
  }
  return null;
}

export type PermissionRequest = {
  toolName: string;
  input: unknown;
  rules: PermissionRules;
  /** Set by --yolo. Skips every prompt, including dangerous ones. */
  skipPrompts?: boolean;
};

export type PermissionEvaluation = {
  decision: PermissionDecision;
  risk: ToolRisk;
  reason?: string;
  /** The rule "always allow" would store, or null when it must not be offered. */
  suggestedRule: string | null;
  /** The rule that decided an automatic allow or deny, for the activity log. */
  matchedRule?: string;
};

export function evaluatePermission({
  toolName,
  input,
  rules,
  skipPrompts = false,
}: PermissionRequest): PermissionEvaluation {
  const bash = toolName === "bash" ? classifyBashCommand(readCommand(input) ?? "") : null;
  const risk: ToolRisk = bash ? bash.risk : needsNoApproval(toolName) ? "safe" : "moderate";
  const suggestedRule =
    risk === "dangerous"
      ? null
      : toolName === "bash"
        ? bashPrefixRule(readCommand(input) ?? "")
        : toolName;

  const base = {
    risk,
    ...(bash?.reason ? { reason: bash.reason } : {}),
    suggestedRule,
  };

  const denyRule = rules.deny.find((rule) => ruleMatches(rule, toolName, input));
  if (denyRule) {
    return { ...base, decision: "deny", matchedRule: denyRule };
  }

  if (needsNoApproval(toolName)) {
    return { ...base, decision: "allow" };
  }

  if (skipPrompts) {
    return { ...base, decision: "allow" };
  }

  // A dangerous call is always worth a human answer, even when an earlier
  // "always allow" would otherwise cover it.
  if (risk === "dangerous") {
    return { ...base, decision: "ask" };
  }

  const allowRule = rules.allow.find((rule) => ruleMatches(rule, toolName, input));
  if (allowRule) {
    return { ...base, decision: "allow", matchedRule: allowRule };
  }

  return { ...base, decision: "ask" };
}

function bashPrefixRule(command: string) {
  const prefix = bashCommandPrefix(command);
  return prefix ? `bash:${prefix}` : null;
}

export function addAllowRule(rules: PermissionRules, rule: string): PermissionRules {
  const trimmed = rule.trim();
  if (!trimmed || rules.allow.includes(trimmed)) return rules;
  return { ...rules, allow: [...rules.allow, trimmed] };
}

export function addDenyRule(rules: PermissionRules, rule: string): PermissionRules {
  const trimmed = rule.trim();
  if (!trimmed || rules.deny.includes(trimmed)) return rules;
  return { ...rules, deny: [...rules.deny, trimmed] };
}

export function removeRule(rules: PermissionRules, rule: string): PermissionRules {
  return {
    ...rules,
    allow: rules.allow.filter((entry) => entry !== rule),
    deny: rules.deny.filter((entry) => entry !== rule),
  };
}

/** A one-line description of what the model is asking to do. */
export function describeToolCall(toolName: string, input: unknown): string {
  if (toolName === "bash") {
    const command = readCommand(input);
    if (!command) return "bash";

    const normalized = command.replace(/\s+/g, " ").trim();
    // Approving a background command is approving something that keeps running
    // after the reply ends, so the prompt has to say so.
    const background =
      input && typeof input === "object" && (input as { background?: unknown }).background === true;

    return background ? `${normalized} (keeps running in the background)` : normalized;
  }

  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const path = record.path ?? record.file ?? record.filePath;
    if (typeof path === "string") return `${toolName} ${path}`;

    if (Array.isArray(record.edits)) {
      const files = [
        ...new Set(
          record.edits
            .map((edit) =>
              edit && typeof edit === "object" ? (edit as { path?: unknown }).path : null,
            )
            .filter((value): value is string => typeof value === "string"),
        ),
      ];
      return `${toolName} ${files.join(", ") || `${record.edits.length} edits`}`;
    }
  }

  return toolName;
}
