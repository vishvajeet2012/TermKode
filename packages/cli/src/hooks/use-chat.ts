import { useCallback, useEffect, useMemo, useRef } from "react";
import { useChat as useAiChat } from "@ai-sdk/react";
import {
    DefaultChatTransport,
    type InferUITools,
    lastAssistantMessageIsCompleteWithToolCalls,
    type LanguageModelUsage,
    type UIMessage,
} from "ai";
import {
    type NeoLensActivityEvent,
    type NeoLensFileStatus,
    type ModeType,
    type ToolContracts,
} from "@termkode/shared";
import { apiClient, localFetch } from "../lib/api-client";
import { isUsingRemoteApi } from "../lib/config";
import { runToolCall } from "../lib/tool-runner";
import { getMaxSteps } from "../lib/runtime-flags";
import { runHooks } from "../lib/project-hooks";
import type { Checkpoint } from "../lib/checkpoints";
import { useNeoLens } from "../providers/neolens";
import { usePermission } from "../providers/permission";

function activityEvent(
    toolCallId: string,
    toolName: string,
    input: unknown,
    phase: "started" | "completed",
    failed = false,
    sessionStartedAt = Date.now(),
    toolStartedAt?: number,
): NeoLensActivityEvent {
    const timestampMs = Date.now();
    const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const filePaths = Object.entries(args)
        .filter(([key, value]) => /^(?:path|file|filePath)$/i.test(key) && typeof value === "string")
        .map(([, value]) => value as string);
    const status: NeoLensFileStatus = failed
        ? "failed"
        : /(?:write|edit|create|delete|remove|update)/i.test(toolName)
          ? "modified"
          : "inspected";
    return {
        id: `${toolCallId}:${phase}`,
        toolCallId,
        toolName,
        phase,
        status,
        filePaths,
        timestampMs,
        offsetMs: Math.max(0, timestampMs - sessionStartedAt),
        ...(phase === "completed" && toolStartedAt
            ? { durationMs: Math.max(0, timestampMs - toolStartedAt) }
            : {}),
        summary: `${status[0]!.toUpperCase()}${status.slice(1)} ${filePaths[0] ?? toolName}`,
    };
}

export type ChatMessageMetadata = {
    mode?: ModeType;
    model?: string;
    thinking?: boolean;
    durationMs?: number;
    usage?: LanguageModelUsage;
    compaction?: {
        removedMessages: number;
        tokensBefore: number;
        tokensAfter: number;
    };
}

type ChatTools = {
    [Name in keyof InferUITools<ToolContracts>]: {
        input: InferUITools<ToolContracts>[Name]['input'],
        output: unknown;
    }
}

export type Message = UIMessage<ChatMessageMetadata, never, ChatTools>;

type UseChatOptions = {
    /** Fired when the agent hits the per-message tool-call cap. */
    onStepLimit?: (steps: number) => void;
    /** Fired after a write tool is checkpointed, so the UI can offer a rewind. */
    onCheckpoint?: (checkpoint: Checkpoint) => void;
    /** Non-fatal problems, such as a project hook that failed to run. */
    onWarning?: (message: string) => void;
};

/**
 * Tool rounds spent on the current user message. A model that keeps calling
 * tools keeps the loop going, so this is what stops a confused one from
 * spending the user's credits on the same failing call forever.
 */
function stepsSinceLastUserMessage(messages: Message[]) {
    let steps = 0;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        if (message.role === "user") break;
        if (message.role !== "assistant") continue;

        steps += message.parts.filter(
            (part) => part.type === "dynamic-tool" || part.type.startsWith("tool-"),
        ).length;
    }

    return steps;
}

export function useChat(
    sessionId: string,
    initialMessages: Message[],
    options: UseChatOptions = {},
) {
    const { recordActivity } = useNeoLens();
    const { requestPermission } = usePermission();
    const sessionStartedAt = useRef(Date.now());
    const toolStartedAt = useRef(new Map<string, number>());
    const optionsRef = useRef(options);
    optionsRef.current = options;
    // A sessionStart hook runs once when the conversation opens; whatever it
    // prints rides along with the first message the user sends.
    const sessionStartContext = useRef<string | null>(null);

    useEffect(() => {
        let ignore = false;

        void runHooks("sessionStart", { sessionId })
            .then((result) => {
                if (ignore) return;
                if (result.output) sessionStartContext.current = result.output;
                for (const warning of result.warnings) optionsRef.current.onWarning?.(warning);
            })
            .catch(() => {
                // A session must open whether or not its hooks do.
            });

        return () => {
            ignore = true;
        };
    }, [sessionId]);

    const transport = useMemo(() => {
        return new DefaultChatTransport<Message>({
            api: apiClient.chat.$url().toString(),
            fetch: isUsingRemoteApi() ? fetch : localFetch,
            prepareSendMessagesRequest({ messages }) {
                const message = messages[messages.length - 1];
                if (!message) throw new Error("No messages to send");

                const metadata = messages.findLast(
                    (m) => m.metadata?.mode && m.metadata?.model
                )?.metadata;

                const previousMessage = messages[messages.length - 1];
                const requestMessages = message.role === "assistant" && previousMessage?.role === "user"
                    ? [previousMessage, message]
                    : [message];

                return {
                    body: {
                        id: sessionId,
                        messages: requestMessages,
                        mode: message.metadata?.mode || metadata?.mode,
                        model: message.metadata?.model || metadata?.model,
                        thinking: message.metadata?.thinking ?? metadata?.thinking ?? false,
                    },
                }
            }
        })
    }, [sessionId]);

    const chat = useAiChat<Message>({
        id: sessionId,
        messages: initialMessages,
        transport,
        onToolCall({ toolCall }) {
            const mode = chat.messages.at(-1)?.metadata?.mode ?? "BUILD";
            const startedAt = Date.now();
            toolStartedAt.current.set(toolCall.toolCallId, startedAt);
            recordActivity(sessionId, activityEvent(
                toolCall.toolCallId,
                toolCall.toolName,
                toolCall.input,
                "started",
                false,
                sessionStartedAt.current,
            ));

            // Every call goes through the runner: it asks the user, runs the
            // project's hooks, and checkpoints the files before anything is
            // written. Nothing here reaches a tool directly.
            void runToolCall({
                sessionId,
                toolName: toolCall.toolName,
                input: toolCall.input,
                mode,
                ask: requestPermission,
                onCheckpoint: (checkpoint) => optionsRef.current.onCheckpoint?.(checkpoint),
                onWarning: (message) => optionsRef.current.onWarning?.(message),
            })
                .then((output) => {
                    recordActivity(sessionId, activityEvent(
                        toolCall.toolCallId,
                        toolCall.toolName,
                        toolCall.input,
                        "completed",
                        false,
                        sessionStartedAt.current,
                        toolStartedAt.current.get(toolCall.toolCallId),
                    ));
                    toolStartedAt.current.delete(toolCall.toolCallId);
                    return chat.addToolOutput({
                        tool: toolCall.toolName as keyof ChatTools,
                        toolCallId: toolCall.toolCallId,
                        output,
                    });
                })
                .catch((error) => {
                recordActivity(sessionId, activityEvent(
                    toolCall.toolCallId,
                    toolCall.toolName,
                    toolCall.input,
                    "completed",
                    true,
                    sessionStartedAt.current,
                    toolStartedAt.current.get(toolCall.toolCallId),
                ));
                toolStartedAt.current.delete(toolCall.toolCallId);
                return chat.addToolOutput({
                    tool: toolCall.toolName as keyof ChatTools,
                    toolCallId: toolCall.toolCallId,
                    state: "output-error",
                    errorText: error instanceof Error ? error.message : String(error),
                });
            });
        },
        sendAutomaticallyWhen: ({ messages }) => {
            if (!lastAssistantMessageIsCompleteWithToolCalls({ messages })) return false;

            const steps = stepsSinceLastUserMessage(messages as Message[]);
            if (steps >= getMaxSteps()) {
                optionsRef.current.onStepLimit?.(steps);
                return false;
            }

            return true;
        },
    });

    const submit = useCallback(
        async (params: {
            userText: string;
            mode: ModeType;
            model: string;
            thinking?: boolean;
        }) => {
            // A userPromptSubmit hook can add context the user should not have
            // to paste every time - the current ticket, a house style note.
            const hookResult = await runHooks("userPromptSubmit", {
                prompt: params.userText,
                sessionId,
            }).catch(() => null);

            for (const warning of hookResult?.warnings ?? []) {
                optionsRef.current.onWarning?.(warning);
            }

            if (hookResult?.blocked) {
                optionsRef.current.onWarning?.(
                    hookResult.reason ?? "A project hook blocked that prompt",
                );
                return;
            }

            const startContext = sessionStartContext.current;
            sessionStartContext.current = null;

            const context = [startContext, hookResult?.output].filter(Boolean).join("\n");
            const text = context
                ? `${params.userText}\n\n<project-context>\n${context}\n</project-context>`
                : params.userText;

            return chat.sendMessage({
                text,
                metadata: {
                    mode: params.mode,
                    model: params.model,
                    thinking: params.thinking ?? false,
                },
            });
        },
        [chat, sessionId],
    );

    return {
        messages: chat.messages,
        status: chat.status,
        error: chat.error,
        submit,
        setMessages: chat.setMessages,
        abort: chat.stop,
        interrupt: chat.stop,
    };
}
