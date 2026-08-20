import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { measureContext } from "@termkode/shared";
import { createSession, getSession, listSessions, saveSessionMessages } from "../lib/store";
import { compactMessages } from "../lib/compaction";
import { resolveChatModel } from "../lib/models";
import type { TermkodeUIMessage } from "./chat-validation";

const createSessionSchema = z.object({
  title: z.string(),
  cwd: z.string().min(1),
});

const createSessionValidator = zValidator(
  "json",
  createSessionSchema,
  (result, c) => {
    if (!result.success) {
      return c.json({ error: "Invalid request body" }, 400);
    }
  }
);

const compactSchema = z.object({
  model: z.string().min(1),
  /** Optional steer, e.g. "keep the database decisions". */
  instructions: z.string().trim().max(2_000).optional(),
});

const compactValidator = zValidator("json", compactSchema, (result, c) => {
  if (!result.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }
});

const messagesSchema = z.object({
  messages: z.array(z.unknown()),
});

const messagesValidator = zValidator("json", messagesSchema, (result, c) => {
  if (!result.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }
});

const app = new Hono()
  .get("/", (c) => {
    return c.json(listSessions());
  })
  .get("/:id", (c) => {
    const session = getSession(c.req.param("id"));

    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    return c.json(session);
  })
  .post("/", createSessionValidator, (c) => {
    const data = c.req.valid("json");
    return c.json(createSession(data), 201);
  })
  // The headless runner drives the model itself rather than through /chat, so
  // it needs a way to store the transcript it produced. A session written this
  // way reopens in the terminal UI like any other.
  .put("/:id/messages", messagesValidator, (c) => {
    const updated = saveSessionMessages(c.req.param("id"), c.req.valid("json").messages);

    if (!updated) {
      return c.json({ error: "Session not found" }, 404);
    }

    return c.json(updated);
  })
  // How full the context window is, so the status bar can show it before the
  // user runs into a provider error.
  .get("/:id/context", (c) => {
    const session = getSession(c.req.param("id"));
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const model = c.req.query("model") ?? "";
    return c.json(measureContext(session.messages, model));
  })
  // `/compact` - fold the older turns into a summary on demand, instead of
  // waiting for the automatic pass that runs at 80% of the window.
  .post("/:id/compact", compactValidator, async (c) => {
    const session = getSession(c.req.param("id"));
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const { model, instructions } = c.req.valid("json");

    let resolved: Awaited<ReturnType<typeof resolveChatModel>>;
    try {
      resolved = await resolveChatModel(model);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Unsupported model" },
        400,
      );
    }

    const result = await compactMessages({
      messages: session.messages as unknown as TermkodeUIMessage[],
      model: resolved.model,
      modelRef: model,
      force: true,
      ...(instructions ? { instructions } : {}),
    });

    if (result.error) {
      return c.json({ error: result.error }, 502);
    }

    if (result.compacted) {
      saveSessionMessages(session.id, result.messages);
    }

    return c.json({
      compacted: result.compacted,
      removedMessages: result.removedMessages,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      messages: result.messages,
    });
  });

export default app;
