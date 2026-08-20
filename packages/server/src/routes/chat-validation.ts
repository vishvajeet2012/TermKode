import {
  type InferUITools,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import {
  modeSchema,
  type ModeType,
  type ToolContracts,
} from "@termkode/shared";
import { z } from "zod";

type ChatMessageMetadata = {
  mode?: ModeType;
  model?: string;
  thinking?: boolean;
  durationMs?: number;
  usage?: LanguageModelUsage;
  /** Present when the older turns were summarized before this reply. */
  compaction?: {
    removedMessages: number;
    tokensBefore: number;
    tokensAfter: number;
  };
};

export type TermkodeUIMessage = UIMessage<
  ChatMessageMetadata,
  never,
  InferUITools<ToolContracts>
>;

export const submitSchema = z.object({
  id: z.string().min(1),
  messages: z
    .array(
      z.custom<TermkodeUIMessage>((value) => {
        return (
          value !== null &&
          typeof value === "object" &&
          "id" in value &&
          "parts" in value &&
          Array.isArray(value.parts)
        );
      }),
    )
    .min(1),
  mode: modeSchema,
  // Models are resolved against the user's configured providers at request
  // time, so any non-empty reference is accepted here.
  model: z.string().min(1),
  // Extended thinking is off by default: on small local models it consumes the
  // whole response budget before the model ever calls a tool.
  thinking: z.boolean().optional(),
});

export function hasPendingToolCalls(message: TermkodeUIMessage) {
  return message.parts.some((part) => {
    if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
      const state = (part as { state?: string }).state;
      return state !== "output-available" && state !== "output-error";
    }
    return false;
  });
}
