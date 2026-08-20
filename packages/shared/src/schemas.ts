import { z } from "zod";
import { tool } from "ai";

export const Mode = {
  BUILD: "BUILD",
  PLAN: "PLAN",
} as const;

export const modeSchema = z.enum([Mode.BUILD, Mode.PLAN]);

export type ModeType = (typeof Mode)[keyof typeof Mode];

export const toolInputSchemas = {
  readFile: z.object({
    path: z.string().describe("Relative path to the file to read"),
  }),
  listDirectory: z.object({
    path: z.string().default(".").describe("Relative directory path to list"),
  }),
  glob: z.object({
    pattern: z.string().describe("Glob pattern to match files"),
    path: z.string().default(".").describe("Directory to search from"),
  }),
  grep: z.object({
    pattern: z.string().describe("Regex pattern to search for"),
    path: z.string().default(".").describe("Directory to search from"),
    include: z.string().optional().describe("Optional glob for files to include"),
  }),
  writeFile: z.object({
    path: z.string().describe("Relative path to write"),
    content: z.string().describe("File contents"),
  }),
  editFile: z.object({
    path: z.string().describe("Relative path to edit"),
    oldString: z.string().describe("Exact text to replace; must be unique"),
    newString: z.string().describe("Replacement text"),
  }),
  bash: z.object({
    command: z.string().describe("Shell command to run"),
    description: z.string().optional().describe("Short description of the command"),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds. Ignored when background is true"),
    background: z
      .boolean()
      .optional()
      .describe(
        "Start the command and return immediately instead of waiting for it. Use for dev servers, watchers, and anything that does not exit on its own. Returns a backgroundId to read with bashOutput.",
      ),
  }),
  bashOutput: z.object({
    id: z.string().describe("The backgroundId returned when the command was started"),
    filter: z
      .string()
      .optional()
      .describe("Regular expression; only matching output lines are returned"),
  }),
  killBash: z.object({
    id: z.string().describe("The backgroundId of the process to stop"),
  }),
  multiEdit: z.object({
    edits: z
      .array(
        z.object({
          path: z.string().describe("Relative path to edit"),
          oldString: z.string().describe("Exact text to replace; must be unique in the file"),
          newString: z.string().describe("Replacement text"),
        }),
      )
      .min(1)
      .describe("Edits applied in order; all must succeed or none are written"),
  }),
  fetchUrl: z.object({
    url: z.string().describe("Absolute http(s) URL to fetch"),
    maxLength: z
      .number()
      .optional()
      .describe("Maximum characters of extracted text to return"),
  }),
  webSearch: z.object({
    query: z.string().describe("Search query"),
    maxResults: z.number().optional().describe("Number of results to return (default 5)"),
  }),
  readPdf: z.object({
    path: z.string().describe("Relative path to a PDF file in the project"),
    maxLength: z.number().optional().describe("Maximum characters of text to return"),
  }),
  todoWrite: z.object({
    todos: z
      .array(
        z.object({
          content: z.string().describe("What needs to be done"),
          status: z
            .enum(["pending", "in_progress", "completed"])
            .describe("Current state of this task"),
        }),
      )
      .describe("The full task list, resent in full on every update"),
  }),
};

const readOnlyToolContracts = {
  readFile: tool({
    description: "Read the contents of a file in the project",
    inputSchema: toolInputSchemas.readFile,
  }),
  listDirectory: tool({
    description: "List files and directories in a project directory",
    inputSchema: toolInputSchemas.listDirectory,
  }),
  glob: tool({
    description: "Find project files matching a glob pattern",
    inputSchema: toolInputSchemas.glob,
  }),
  grep: tool({
    description: "Search project files for a regular expression",
    inputSchema: toolInputSchemas.grep,
  }),
  fetchUrl: tool({
    description: "Fetch a web page or API response and return it as readable text",
    inputSchema: toolInputSchemas.fetchUrl,
  }),
  webSearch: tool({
    description: "Search the web and return titles, URLs, and snippets",
    inputSchema: toolInputSchemas.webSearch,
  }),
  readPdf: tool({
    description: "Extract the text of a PDF file in the project",
    inputSchema: toolInputSchemas.readPdf,
  }),
  todoWrite: tool({
    description:
      "Record the task list for the current work. Send the full list every time; use it to plan multi-step work and to show progress.",
    inputSchema: toolInputSchemas.todoWrite,
  }),
};

const buildToolContracts = {
  ...readOnlyToolContracts,
  writeFile: tool({
    description: "Create or overwrite a file in the project",
    inputSchema: toolInputSchemas.writeFile,
  }),
  editFile: tool({
    description: "Replace one unique text occurrence in a project file",
    inputSchema: toolInputSchemas.editFile,
  }),
  bash: tool({
    description:
      "Run any shell command on the user's machine, starting in the project directory. Use it for system information (memory, disk, processes, network), git, package managers, tests, and builds. Set background to true for a command that does not exit on its own, such as a dev server or a watcher.",
    inputSchema: toolInputSchemas.bash,
  }),
  bashOutput: tool({
    description:
      "Read the output a background command has produced since the last time you read it, along with whether it is still running.",
    inputSchema: toolInputSchemas.bashOutput,
  }),
  killBash: tool({
    description: "Stop a background command started by bash, and its child processes.",
    inputSchema: toolInputSchemas.killBash,
  }),
  multiEdit: tool({
    description:
      "Apply several edits across one or more files in a single call. Nothing is written unless every edit matches.",
    inputSchema: toolInputSchemas.multiEdit,
  }),
};

export type ToolContracts = typeof buildToolContracts;

export function getToolContracts(mode: ModeType) {
  return mode === Mode.PLAN ? readOnlyToolContracts : buildToolContracts;
}

// Keep the explicit key schema here because the one-argument z.record(...)
// form does not type-check cleanly with the Zod typings used in this workspace.
export const toolCallArgsSchema = z.record(z.string(), z.json());

export const neoLensFileStatusSchema = z.enum([
  "inspected",
  "modified",
  "failed",
  "verified",
]);

export const neoLensActivityEventSchema = z.object({
  id: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  phase: z.enum(["started", "completed"]),
  status: neoLensFileStatusSchema,
  filePaths: z.array(z.string()),
  mcpServer: z.string().optional(),
  timestampMs: z.number().nonnegative(),
  offsetMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative().optional(),
  summary: z.string(),
});

export type NeoLensFileStatus = z.infer<typeof neoLensFileStatusSchema>;
export type NeoLensActivityEvent = z.infer<typeof neoLensActivityEventSchema>;

export const messagePartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("reasoning"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool-call"),
    id: z.string(),
    name: z.string(),
    args: toolCallArgsSchema,
    result: z.string().optional(),
    activity: z
      .object({
        started: neoLensActivityEventSchema,
        completed: neoLensActivityEventSchema.optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
]);

export const messagePartsSchema = z.array(messagePartSchema);

export type MessagePart = z.infer<typeof messagePartSchema>;

// Tool-call args stay as nested JSON on the wire so the client does not need
// a second JSON.parse step after decoding the SSE event payload itself.
export const chatStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text-delta"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("reasoning-delta"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool-call"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: toolCallArgsSchema,
  }),
  z.object({
    type: z.literal("tool-result"),
    toolCallId: z.string(),
    result: z.string(),
  }),
  z.object({
    type: z.literal("neolens-activity"),
    event: neoLensActivityEventSchema,
  }),
  z.object({
    type: z.literal("done"),
    messageId: z.string(),
    durationMs: z.number(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
]);

export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
