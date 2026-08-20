import { Hono } from "hono";
import { inspectMcpServers } from "../mcp/runtime";
import { McpConfigError } from "../mcp/config";
import { getSession } from "../lib/store";

const app = new Hono().get("/:sessionId", async (c) => {
  const session = getSession(c.req.param("sessionId"));

  if (!session) return c.json({ error: "Session not found" }, 404);
  if (!session.cwd) return c.json({ error: "Session has no project directory" }, 409);

  try {
    return c.json(await inspectMcpServers(session.cwd));
  } catch (error) {
    if (error instanceof McpConfigError) {
      return c.json({ error: error.message, configPath: error.configPath }, 422);
    }
    throw error;
  }
});

export default app;
