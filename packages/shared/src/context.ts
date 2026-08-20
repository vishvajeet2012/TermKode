// A coding agent fills its context faster than a chat does: one `grep` over a
// large repository can cost more tokens than the whole conversation before it.
// Without a budget the session dies mid-task with a provider error, so the
// window is estimated here and the server compacts before it is reached.

export type ContextBudget = {
  usedTokens: number;
  contextWindow: number;
  /** 0-1. What fraction of the window the conversation currently occupies. */
  usedFraction: number;
  /** True once compaction should run before the next request. */
  shouldCompact: boolean;
};

/** Compact while there is still room to send the summary request itself. */
export const COMPACTION_THRESHOLD = 0.8;

const DEFAULT_CONTEXT_WINDOW = 128_000;
const LOCAL_CONTEXT_WINDOW = 32_768;

// Only families whose window is both known and materially different from the
// default are listed. Anything unrecognised gets the conservative default, so a
// model released tomorrow still works.
const CONTEXT_WINDOWS: Array<{ pattern: RegExp; window: number }> = [
  { pattern: /^claude-(?:opus|sonnet|haiku)/, window: 200_000 },
  { pattern: /^gpt-5/, window: 272_000 },
  { pattern: /^gpt-4\.1/, window: 1_000_000 },
  { pattern: /^gpt-4o/, window: 128_000 },
  { pattern: /^o[34]/, window: 200_000 },
  { pattern: /^gemini/, window: 1_000_000 },
  { pattern: /^grok/, window: 131_072 },
  { pattern: /^deepseek/, window: 65_536 },
  { pattern: /^qwen/, window: 131_072 },
  { pattern: /^(?:kimi|moonshot)/, window: 200_000 },
  { pattern: /^glm/, window: 128_000 },
  { pattern: /^minimax/, window: 1_000_000 },
  { pattern: /^mistral|^magistral|^devstral/, window: 128_000 },
  { pattern: /^llama-?4/, window: 1_000_000 },
  { pattern: /^llama/, window: 128_000 },
];

/**
 * The usable window for a `provider/model` reference. Local runtimes get a
 * small default because a quantised model on a laptop rarely has more, and
 * over-estimating there is what produces a hard provider error.
 */
export function getModelContextWindow(modelRef: string): number {
  const separatorIndex = modelRef.indexOf("/");
  const providerId = separatorIndex === -1 ? "" : modelRef.slice(0, separatorIndex);
  const modelId = (separatorIndex === -1 ? modelRef : modelRef.slice(separatorIndex + 1))
    .toLowerCase()
    .trim();

  if (providerId === "local") return LOCAL_CONTEXT_WINDOW;

  for (const { pattern, window } of CONTEXT_WINDOWS) {
    if (pattern.test(modelId)) return window;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Tokens are estimated rather than counted: every provider tokenises
 * differently, and shipping a tokenizer per provider would cost more than the
 * accuracy is worth. Four characters per token is the usual rule of thumb for
 * code and English prose alike.
 */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil((text?.length ?? 0) / 4);
}

export function estimateMessagesTokens(messages: unknown[]): number {
  // A few tokens of role and delimiter overhead ride along with each message.
  return messages.reduce<number>((total, message) => total + estimateTokens(message) + 4, 0);
}

export function measureContext(
  messages: unknown[],
  modelRef: string,
  threshold = COMPACTION_THRESHOLD,
): ContextBudget {
  const contextWindow = getModelContextWindow(modelRef);
  const usedTokens = estimateMessagesTokens(messages);
  const usedFraction = contextWindow > 0 ? usedTokens / contextWindow : 0;

  return {
    usedTokens,
    contextWindow,
    usedFraction,
    shouldCompact: usedFraction >= threshold,
  };
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}
