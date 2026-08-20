import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import sessions from "./routes/sessions";
import chat from "./routes/chat";
import mcp from "./routes/mcp";
import neolens from "./routes/neolens";
import permissions from "./routes/permissions";
import providers from "./routes/providers";

// TermKode runs entirely on the user's machine. The CLI mounts this app in its
// own process, so there is no account system, no remote API, and no billing:
// requests never leave the device except for the calls made to the AI provider
// with the user's own API key.
export const app = new Hono();

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json({
      error: error.message || "Request failed",
    }, error.status);
  }

  console.error("Unhandled server error", error);
  return c.json({
    error: error instanceof Error ? error.message : "Internal Server Error"
  }, 500);
});

const routes = app
  .route("/sessions", sessions)
  .route("/chat", chat)
  .route("/mcp", mcp)
  .route("/neolens", neolens)
  .route("/permissions", permissions)
  .route("/providers", providers);

export type AppType = typeof routes;

export { describeEnvironment, getShell, getShellCommand } from "./lib/environment";
export { getHomeDirectory } from "./lib/paths";
export { COMMIT_PROMPT, describeGitContext, readGitContext } from "./lib/git";
export { resolveChatModel, ModelResolutionError } from "./lib/models";
export { readSettings } from "./lib/settings";
export { createMcpRuntime } from "./mcp/runtime";
export { buildInitPrompt, loadProjectInstructions } from "./lib/project-instructions";
export { buildSystemPrompt } from "./system-prompt";

// idleTimeout must be high otherwise LLM tool calls might not complete
export default { port: 3000, fetch: app.fetch, idleTimeout: 255 };
