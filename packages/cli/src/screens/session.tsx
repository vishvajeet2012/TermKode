import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useParams, useLocation, useNavigate } from "react-router";
import { z } from "zod";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { formatTokenCount, type ModeType } from "@termkode/shared";
import type { InferResponseType } from "hono/client";

import { SessionShell } from "../components/session-shell";
import {
  UserMessage,
  BotMessage,
  ErrorMessage,
} from "../components/messages";
import { apiClient } from "../lib/api-client";
import { useChat } from "../hooks/use-chat";
import { usePromptConfig } from "../providers/prompt-config";
import type { Message } from "../hooks/use-chat";
import { useToast } from "../providers/toast";
import { getErrorMessage } from "../lib/http-errors";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { useDialog } from "../providers/dialog";
import { NeoLensDialogContent } from "../components/dialogs/neolens-dialog";
import { SessionActionsProvider } from "../providers/session-actions";

type SessionData = InferResponseType<(typeof apiClient.sessions)[":id"]["$get"], 200>;

const initialPromptSchema = z.object({
  message: z.string(),
  mode: z.custom<ModeType>(),
  model: z.string(),
  thinking: z.boolean().optional(),
});

type InitialPrompt = z.infer<typeof initialPromptSchema>;

const sessionLocationSchema = z.object({
  session: z.custom<SessionData>((val) => val != null && typeof val === "object" && "messages" in val && Array.isArray((val as any).messages)),
  initialPrompt: initialPromptSchema.optional(),
});

function ChatMessage(
  { msg } : {
    msg: Message
  }
) {
  if (msg.role === "user") {
    const text = msg.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");

    return <UserMessage message={text} mode={msg.metadata?.mode ?? "BUILD"} />;
  }

  const compaction = msg.metadata?.compaction;

  return (
    <>
      {compaction ? (
        <box paddingX={3} paddingBottom={1} width="100%">
          <text attributes={TextAttributes.DIM}>
            Context was full, so {compaction.removedMessages} earlier messages were
            summarized ({formatTokenCount(compaction.tokensBefore)} →{" "}
            {formatTokenCount(compaction.tokensAfter)} tokens).
          </text>
        </box>
      ) : null}
      <BotMessage
        parts={msg.parts}
        model={msg.metadata?.model ?? "unknown"}
        mode={msg.metadata?.mode ?? "BUILD"}
        durationMs={msg.metadata?.durationMs}
        streaming={false}
      />
    </>
  );
}

function SessionChat({
  session,
  initialPrompt,
}: {
  session: SessionData;
  initialPrompt?: InitialPrompt;
}) {
  const [initialMessages] = useState(() => session.messages as unknown as Message[]);
  const { model, mode, thinking } = usePromptConfig();
  const { isTopLayer } = useKeyboardLayer();
  const dialog = useDialog();
  const toast = useToast();
  const hasSubmittedInitialPromptRef = useRef(false);
  // The model in effect right now, so /compact does not depend on the picker
  // having been touched since the session was opened.
  const modelRef = useRef(model);
  modelRef.current = model;

  const { messages, status, submit, abort, interrupt, error, setMessages } = useChat(
    session.id,
    initialMessages,
    {
      onStepLimit: (steps) => {
        toast.show({
          variant: "info",
          duration: 8000,
          message: `Stopped after ${steps} tool calls for one message. Send another message to continue, or raise the cap with --max-steps.`,
        });
      },
      onCheckpoint: (checkpoint) => {
        toast.show({
          duration: 2000,
          message: `Checkpoint saved before ${checkpoint.label} - /rewind to undo`,
        });
      },
      onWarning: (message) => {
        toast.show({ variant: "error", message });
      },
    },
  );

  // Stop the pending reply when the user leaves this session.
  useEffect(() => {
    return () => void abort();
  }, [abort]);

  const compact = useCallback(
    async (instructions?: string) => {
      toast.show({ message: "Summarizing the earlier turns…", duration: 2000 });

      try {
        const response = await apiClient.sessions[":id"].compact.$post({
          param: { id: session.id },
          json: {
            model: modelRef.current,
            ...(instructions ? { instructions } : {}),
          },
        });

        if (!response.ok) throw new Error(await getErrorMessage(response));

        const result = await response.json();

        if (!result.compacted) {
          toast.show({ message: "Nothing to compact yet - the conversation is short." });
          return;
        }

        setMessages(result.messages as unknown as Message[]);
        toast.show({
          variant: "success",
          duration: 6000,
          message: `Compacted ${result.removedMessages} messages: ${formatTokenCount(result.tokensBefore)} → ${formatTokenCount(result.tokensAfter)} tokens.`,
        });
      } catch (err) {
        toast.show({
          variant: "error",
          message: err instanceof Error ? err.message : "Could not compact the conversation",
        });
      }
    },
    [session.id, setMessages, toast],
  );

  const reload = useCallback(async () => {
    try {
      const response = await apiClient.sessions[":id"].$get({ param: { id: session.id } });
      if (!response.ok) return;

      const reloaded = await response.json();
      setMessages(reloaded.messages as unknown as Message[]);
    } catch {
      // A failed reload leaves the in-memory conversation as it was.
    }
  }, [session.id, setMessages]);

  const sessionActions = useMemo(
    () => ({ sessionId: session.id, compact, reload }),
    [session.id, compact, reload],
  );

  // Let the user cancel a reply even before the first streamed chunk arrives.
  useKeyboard((key) => {
    if (key.name === "l" && key.ctrl && isTopLayer("base")) {
      key.preventDefault();
      dialog.open({
        title: "NeoLens",
        size: "fullscreen",
        children: <NeoLensDialogContent sessionId={session.id} />,
      });
      return;
    }
    if (key.name === "escape" && isTopLayer("base") && status === "streaming") {
      key.preventDefault();
      interrupt();
    }
  });

  useEffect(() => {
    if (!initialPrompt || hasSubmittedInitialPromptRef.current) return;

    hasSubmittedInitialPromptRef.current = true;

    void submit({
      userText: initialPrompt.message,
      mode: initialPrompt.mode,
      model: initialPrompt.model,
      thinking: initialPrompt.thinking,
    });
  }, [initialPrompt, submit]);

  return (
    <SessionActionsProvider value={sessionActions}>
      <SessionShell
        onSubmit={(text) => {
          void submit({ userText: text, mode, model, thinking });
        }}
        loading={status === "submitted" || status === "streaming"}
        interruptible={status === "submitted" || status === "streaming"}
      >
        {messages.map((msg) => (
          <ChatMessage key={msg.id} msg={msg} />
        ))}
        {error && <ErrorMessage message={error.message} />}
      </SessionShell>
    </SessionActionsProvider>
  );
}

export function Session() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();

  const prefetched = useMemo(() => {
    const parsed = sessionLocationSchema.safeParse(location.state);
    return parsed.success ? parsed.data : null;
  }, [location.state]);

  const [session, setSession] = useState<SessionData | null>(
    prefetched?.session ?? null
  );

  useEffect(() => {
    // Skip fetch if session was passed via location state
    if (prefetched?.session) return;

    setSession(null);

    if (!id) return;

    let ignore = false;
    const fetchSession = async () => {
      try {
        const res = await apiClient.sessions[":id"].$get({
          param: { id },
        });
        if (ignore) return;
        if (!res.ok) throw new Error(await getErrorMessage(res));
        const resolved = await res.json();
        setSession(resolved);
      } catch (err) {
        if (ignore) return;
        toast.show({
          variant: "error",
          message: err instanceof Error ? err.message : "Failed to load session",
        });
        navigate("/", { replace: true });
      }
    };
    fetchSession();
    return () => {
      ignore = true;
    };
  }, [id, toast, navigate, prefetched]);

  if (!session) {
    return <SessionShell onSubmit={() => {}} inputDisabled loading />;
  }

  return <SessionChat key={session.id} session={session} initialPrompt={prefetched?.initialPrompt}/>;
}
