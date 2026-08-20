import { generateText, type LanguageModel } from "ai";
import { COMPACTION_THRESHOLD, estimateMessagesTokens, getModelContextWindow } from "@termkode/shared";
import type { TermkodeUIMessage } from "../routes/chat-validation";

// An agent session grows in a way a chat never does: a single grep over a large
// repository can outweigh every message before it. Left alone the conversation
// eventually exceeds the model's window and the provider rejects the request,
// which loses the session at the exact moment it was most valuable. Compaction
// replaces the older half with a written handoff and keeps the recent turns
// verbatim, so work continues instead of ending.

/** Fraction of the window the kept-verbatim tail is allowed to occupy. */
const RECENT_FRACTION = 0.25;
/** Never compact away the last few turns, however large they are. */
const MIN_RECENT_MESSAGES = 4;
/** Below this there is nothing worth summarizing. */
const MIN_MESSAGES_TO_COMPACT = 4;
/** Tool output is the bulk of a session; only its head matters in a summary. */
const MAX_TOOL_OUTPUT_CHARACTERS = 600;
const MAX_TEXT_CHARACTERS = 4_000;
const MAX_SUMMARY_SOURCE_CHARACTERS = 120_000;

export type CompactionResult = {
  compacted: boolean;
  messages: TermkodeUIMessage[];
  summary?: string;
  /** How many messages were folded into the summary. */
  removedMessages: number;
  tokensBefore: number;
  tokensAfter: number;
  /** Set when compaction was needed but the summary call failed. */
  error?: string;
};

const SUMMARY_MARKER = "[compacted-context]";

function renderPart(part: TermkodeUIMessage["parts"][number]): string | null {
  if (part.type === "text") {
    return part.text.slice(0, MAX_TEXT_CHARACTERS);
  }

  if (part.type === "reasoning") {
    // Reasoning is the model's scratch work; the conclusion is in the text part.
    return null;
  }

  if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
    const record = part as unknown as {
      toolName?: string;
      type: string;
      input?: unknown;
      output?: unknown;
      errorText?: string;
    };
    const name = record.toolName ?? record.type.replace(/^tool-/, "");
    const input = truncateJson(record.input, 300);
    const output = record.errorText
      ? `error: ${record.errorText}`
      : truncateJson(record.output, MAX_TOOL_OUTPUT_CHARACTERS);

    return `<tool name="${name}" input=${input}>\n${output}\n</tool>`;
  }

  return null;
}

function truncateJson(value: unknown, limit: number): string {
  if (value === undefined) return "";

  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";

  return text.length > limit ? `${text.slice(0, limit)}… (truncated)` : text;
}

function renderMessages(messages: TermkodeUIMessage[]): string {
  const rendered = messages
    .map((message) => {
      const body = message.parts
        .map(renderPart)
        .filter((value): value is string => Boolean(value))
        .join("\n");

      return body.trim() ? `## ${message.role}\n${body}` : null;
    })
    .filter((value): value is string => Boolean(value))
    .join("\n\n");

  return rendered.length > MAX_SUMMARY_SOURCE_CHARACTERS
    ? rendered.slice(rendered.length - MAX_SUMMARY_SOURCE_CHARACTERS)
    : rendered;
}

const SUMMARY_SYSTEM_PROMPT = `You are compacting the earlier part of a coding session so the assistant can
keep working after the transcript is dropped. Everything you leave out is lost.

Write a handoff under these headings, omitting a heading only when it has no
content:

**Goal** - what the user asked for, in their own terms.
**Decisions** - choices already made and the reason for each, so they are not revisited.
**Changes** - every file created, edited, or deleted, with what changed in it.
**Findings** - what was learned about the codebase: paths, APIs, conventions, causes.
**Commands** - commands that were run and what they returned, especially failures.
**Open** - what is still unfinished, blocked, or unverified, and the next step.

Be specific: keep exact file paths, symbol names, commands, and error text.
Drop pleasantries, restatements, and reasoning that led nowhere. Never invent
anything that is not in the transcript. Write it as notes, not prose.`;

function splitMessages(messages: TermkodeUIMessage[], modelRef: string) {
  const window = getModelContextWindow(modelRef);
  const recentBudget = Math.max(1, Math.floor(window * RECENT_FRACTION));

  let used = 0;
  let index = messages.length;

  while (index > 0) {
    const message = messages[index - 1]!;
    const cost = estimateMessagesTokens([message]);
    const kept = messages.length - index + 1;

    if (used + cost > recentBudget && kept > MIN_RECENT_MESSAGES) break;

    used += cost;
    index -= 1;
  }

  // Always leave enough behind to be worth a summary call.
  const splitIndex = Math.min(index, Math.max(0, messages.length - MIN_RECENT_MESSAGES));

  return {
    older: messages.slice(0, splitIndex),
    recent: messages.slice(splitIndex),
  };
}

function buildSummaryMessage(summary: string, removed: number): TermkodeUIMessage {
  return {
    id: `compaction-${Date.now().toString(36)}`,
    role: "user",
    parts: [
      {
        type: "text",
        text: `${SUMMARY_MARKER} The earlier part of this session (${removed} messages) was summarized to stay within the context window. Treat the notes below as established fact and continue from them.\n\n${summary}`,
      },
    ],
  } as TermkodeUIMessage;
}

export type CompactionOptions = {
  messages: TermkodeUIMessage[];
  model: Exclude<LanguageModel, string>;
  modelRef: string;
  /** Compact regardless of how full the window is. Used by `/compact`. */
  force?: boolean;
  /** Extra guidance from the user, e.g. "keep the API design decisions". */
  instructions?: string;
};

export async function compactMessages({
  messages,
  model,
  modelRef,
  force = false,
  instructions,
}: CompactionOptions): Promise<CompactionResult> {
  const tokensBefore = estimateMessagesTokens(messages);
  const window = getModelContextWindow(modelRef);
  const unchanged: CompactionResult = {
    compacted: false,
    messages,
    removedMessages: 0,
    tokensBefore,
    tokensAfter: tokensBefore,
  };

  if (!force && tokensBefore / window < COMPACTION_THRESHOLD) return unchanged;
  if (messages.length < MIN_MESSAGES_TO_COMPACT) return unchanged;

  const { older, recent } = splitMessages(messages, modelRef);
  if (older.length === 0) return unchanged;

  const transcript = renderMessages(older);
  if (!transcript.trim()) return unchanged;

  let summary: string;
  try {
    const result = await generateText({
      model,
      system: SUMMARY_SYSTEM_PROMPT,
      prompt: `${instructions ? `The user asked you to focus on: ${instructions}\n\n` : ""}Transcript to compact:\n\n${transcript}`,
    });
    summary = result.text.trim();
  } catch (error) {
    // A failed summary must not take the session with it: the caller keeps the
    // full history and lets the provider decide.
    return {
      ...unchanged,
      error: error instanceof Error ? error.message : "Could not summarize the conversation",
    };
  }

  if (!summary) return unchanged;

  const nextMessages = [buildSummaryMessage(summary, older.length), ...recent];

  return {
    compacted: true,
    messages: nextMessages,
    summary,
    removedMessages: older.length,
    tokensBefore,
    tokensAfter: estimateMessagesTokens(nextMessages),
  };
}
