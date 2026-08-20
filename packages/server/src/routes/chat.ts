import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  convertToModelMessages,
  streamText,
  validateUIMessages,
  wrapLanguageModel,
  type LanguageModelUsage,
} from "ai";
import { getToolContracts, measureContext } from "@termkode/shared";
import { buildSystemPrompt } from "../system-prompt";
import { getSession, saveSessionMessages } from "../lib/store";
import { resolveChatModel } from "../lib/models";
import { createMcpRuntime } from "../mcp/runtime";
import { recoverTextToolCalls } from "../lib/text-tool-calls";
import { compactMessages } from "../lib/compaction";
import {
  hasPendingToolCalls,
  submitSchema,
  type TermkodeUIMessage,
} from "./chat-validation";

const submitValidator = zValidator("json", submitSchema, (result, c) => {
  if(!result.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }
})

const app = new Hono()
  .post(
    "/",
    submitValidator,
    async (c) => {
      const { id, messages, mode, model, thinking = false } = c.req.valid("json");

      const session = getSession(id);

      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const startTime = Date.now();
      const localTools = getToolContracts(mode);

      // MCP servers configured for this project contribute their tools for the
      // duration of the response. They run in this process, so they reach the
      // same machine the CLI is on.
      const abortController = new AbortController();
      c.req.raw.signal.addEventListener("abort", () => abortController.abort(), {
        once: true,
      });

      const mcpRuntime = session.cwd
        ? await createMcpRuntime({
            cwd: session.cwd,
            mode,
            abortSignal: abortController.signal,
          }).catch(() => null)
        : null;

      for (const warning of mcpRuntime?.warnings ?? []) {
        console.warn("MCP:", warning);
      }

      const tools = { ...localTools, ...(mcpRuntime?.tools ?? {}) };

      // A missing key, an unknown model, or a local server that is not running
      // is a setup problem, so report it as a plain request error instead of an
      // unhandled server failure.
      let resolvedModel: Awaited<ReturnType<typeof resolveChatModel>>;
      try {
        resolvedModel = await resolveChatModel(model, { thinking });
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : "Unsupported model" },
          400,
        );
      }

      const previousMessages = session.messages as unknown as TermkodeUIMessage[];
      const mergedMessages = [...previousMessages];

      for (const message of messages) {
        const incomingMessage = {
          ...message,
          metadata: {
            ...message.metadata, mode, model, thinking
          }
        } satisfies TermkodeUIMessage;

        const existingMessageIndex = mergedMessages.findIndex((m) => m.id === incomingMessage.id);
        if(existingMessageIndex === -1) {
          mergedMessages.push(incomingMessage);
        } else {
          mergedMessages[existingMessageIndex] = incomingMessage;
        }
      }

      let nextMessages = await validateUIMessages<TermkodeUIMessage>({
        messages: mergedMessages,
        tools: localTools,
      });

      // An agent session outgrows the model's window long before the user is
      // done with it. Folding the older turns into a summary here keeps the
      // work going instead of failing the request outright.
      const budget = measureContext(nextMessages, model);
      let compaction: { removedMessages: number; tokensBefore: number; tokensAfter: number } | null =
        null;

      if (budget.shouldCompact) {
        const result = await compactMessages({
          messages: nextMessages,
          model: resolvedModel.model,
          modelRef: model,
        });

        if (result.compacted) {
          nextMessages = result.messages;
          compaction = {
            removedMessages: result.removedMessages,
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter,
          };
          // Persist immediately: if the reply then fails, the session is still
          // small enough for the next attempt to succeed.
          saveSessionMessages(id, nextMessages);
        } else if (result.error) {
          console.warn("Compaction failed:", result.error);
        }
      }

      const modelMessages = await convertToModelMessages(nextMessages, {
        tools: localTools,
        ignoreIncompleteToolCalls: true,
      });
      let completedUsage: LanguageModelUsage | null = null;

      const result = streamText({
        // Local models frequently print a tool call instead of emitting one;
        // this reads those back so the agent keeps working.
        model: wrapLanguageModel({
          model: resolvedModel.model,
          middleware: recoverTextToolCalls(Object.keys(tools)),
        }),
        system: buildSystemPrompt({ mode, ...(session.cwd ? { cwd: session.cwd } : {}) }),
        messages: modelMessages,
        tools,
        providerOptions: resolvedModel.providerOptions,
        onFinish(event) {
          completedUsage = event.totalUsage;
        },
      });

    return result.toUIMessageStreamResponse<TermkodeUIMessage>({
      originalMessages: nextMessages,
      messageMetadata({ part }) {
          if(part.type === "start") {
            return { mode, model, thinking, ...(compaction ? { compaction } : {}) };
          }

          if(part.type !== "finish") return undefined;

          return {
            mode,
            model,
            thinking,
            durationMs: Date.now() - startTime,
            ...(compaction ? { compaction } : {}),
            ...(completedUsage ? { usage: completedUsage } : {}),
          };
        },
        async onFinish(event) {
          await mcpRuntime?.close();

          if(event.isAborted) return;

          if(hasPendingToolCalls(event.responseMessage)) return;

          saveSessionMessages(id, event.messages);
        },
        onError(error) {
          void mcpRuntime?.close();
          return error instanceof Error ? error.message : String(error);
        }
      })
    }
  )

export default app;
