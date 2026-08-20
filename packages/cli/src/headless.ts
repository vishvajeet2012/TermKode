import { stepCountIs, streamText, type ToolSet } from "ai";
import { Mode, getToolContracts } from "@termkode/shared";
import {
  buildSystemPrompt,
  createMcpRuntime,
  readSettings,
  resolveChatModel,
} from "@termkode/server";
import { apiClient } from "./lib/api-client";
import { runToolCall } from "./lib/tool-runner";
import { shouldSkipPermissions, type CliOptions } from "./lib/runtime-flags";

// `termkode -p "..."` is what makes TermKode usable from a script, a git hook,
// or CI: one prompt in, the answer on stdout, an exit code that means something.
// It drives the model directly instead of going through the streaming chat
// route, because there is no terminal here to stream into.
//
// There is nobody to approve a tool call either, so a write or a shell command
// stops the run unless it was already allowed - by a stored rule, or by --yolo.

type ToolCallRecord = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: string;
};

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";

  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Uint8Array);
    }
    return Buffer.concat(chunks).toString("utf-8").trim();
  } catch {
    return "";
  }
}

function buildExecutableTools(
  sessionId: string,
  options: CliOptions,
  records: ToolCallRecord[],
): ToolSet {
  const contracts = getToolContracts(options.mode);
  const executable: ToolSet = {};

  for (const [name, contract] of Object.entries(contracts)) {
    // The contracts are declarations only - the terminal UI executes them on
    // the client. Here the runner is the executor, so each one gets an
    // `execute` that goes through the same permission and hook path.
    executable[name] = {
      ...contract,
      async execute(input: unknown, callOptions: { toolCallId: string }) {
        const record: ToolCallRecord = {
          toolCallId: callOptions.toolCallId,
          toolName: name,
          input,
        };
        records.push(record);

        try {
          // No `ask` callback: an unapproved call fails here instead of
          // hanging on a prompt nobody can answer.
          const output = await runToolCall({
            sessionId,
            toolName: name,
            input,
            mode: options.mode,
          });
          record.output = output;
          return output;
        } catch (error) {
          record.error = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
    } as ToolSet[string];
  }

  return executable;
}

function toUiMessages(
  prompt: string,
  text: string,
  records: ToolCallRecord[],
  options: CliOptions,
  model: string,
) {
  const metadata = { mode: options.mode, model, thinking: false };

  return [
    {
      id: `headless-user-${Date.now().toString(36)}`,
      role: "user",
      parts: [{ type: "text", text: prompt }],
      metadata,
    },
    {
      id: `headless-assistant-${Date.now().toString(36)}`,
      role: "assistant",
      parts: [
        ...records.map((record) =>
          record.error
            ? {
                type: `tool-${record.toolName}`,
                toolCallId: record.toolCallId,
                state: "output-error",
                input: record.input,
                errorText: record.error,
              }
            : {
                type: `tool-${record.toolName}`,
                toolCallId: record.toolCallId,
                state: "output-available",
                input: record.input,
                output: record.output,
              },
        ),
        ...(text ? [{ type: "text", text }] : []),
      ],
      metadata,
    },
  ];
}

export async function runHeadless(options: CliOptions): Promise<number> {
  const prompt = options.prompt?.trim();
  if (!prompt) {
    console.error("Nothing to do: pass a prompt with -p.");
    return 1;
  }

  const model = readSettings().activeModel;
  if (!model) {
    console.error(
      "No model selected. Run termkode without --print, then use /providers to connect one.",
    );
    return 1;
  }

  // Piped input becomes context, so `cat error.log | termkode -p "explain this"`
  // does the obvious thing.
  const piped = await readStdin();
  const userText = piped
    ? `${prompt}\n\n<stdin>\n${piped}\n</stdin>`
    : prompt;

  if (options.mode === Mode.BUILD && !shouldSkipPermissions()) {
    // A warning rather than a refusal: stored rules may already cover
    // everything this run needs, and anything they miss fails with its own
    // explanation when it is reached.
    console.error(
      "Warning: BUILD mode needs approvals that a non-interactive run cannot ask for.\n" +
        "Only tools allowed in ~/.termkode/permissions.json will run. Use --mode PLAN for\n" +
        "read-only work, or --yolo to run every tool without asking.",
    );
  }

  let resolved: Awaited<ReturnType<typeof resolveChatModel>>;
  try {
    resolved = await resolveChatModel(model);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not resolve the model");
    return 1;
  }

  const cwd = process.cwd();

  const sessionResponse = await apiClient.sessions.$post({
    json: { title: prompt.slice(0, 100), cwd },
  });

  if (!sessionResponse.ok) {
    console.error("Could not create a session for this run.");
    return 1;
  }

  const session = await sessionResponse.json();
  const records: ToolCallRecord[] = [];

  const abortController = new AbortController();
  const mcpRuntime = await createMcpRuntime({
    cwd,
    mode: options.mode,
    abortSignal: abortController.signal,
  }).catch(() => null);

  const tools: ToolSet = {
    ...buildExecutableTools(session.id, options, records),
    ...(mcpRuntime?.tools ?? {}),
  };

  let text = "";
  let exitCode = 0;

  try {
    const result = streamText({
      model: resolved.model,
      system: buildSystemPrompt({ mode: options.mode, cwd }),
      prompt: userText,
      tools,
      ...(resolved.providerOptions ? { providerOptions: resolved.providerOptions } : {}),
      // The agent loop runs here rather than in the client, so it needs its own
      // cap for exactly the reason the interactive one does.
      stopWhen: stepCountIs(options.maxSteps),
    });

    for await (const chunk of result.textStream) {
      text += chunk;
      // Streaming as it arrives keeps `termkode -p ... | tee` responsive, and
      // JSON output is assembled at the end instead.
      if (!options.json) process.stdout.write(chunk);
    }

    await result.consumeStream();

    if (!options.json && text && !text.endsWith("\n")) process.stdout.write("\n");

    if (options.json) {
      const usage = await Promise.resolve(result.totalUsage).catch(() => undefined);
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            sessionId: session.id,
            model,
            mode: options.mode,
            text,
            toolCalls: records.map(({ toolName, input, error }) => ({
              toolName,
              input,
              ...(error ? { error } : {}),
            })),
            ...(usage ? { usage } : {}),
          },
          null,
          2,
        )}\n`,
      );
    }

    // A refused tool call means the run did not do what was asked, so the exit
    // code has to say so for a script to notice.
    if (records.some((record) => record.error)) exitCode = 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    } else {
      console.error(message);
    }

    exitCode = 1;
  } finally {
    abortController.abort();
    await mcpRuntime?.close();
  }

  // Store the transcript so the run can be reopened with /sessions.
  await apiClient.sessions[":id"].messages
    .$put({
      param: { id: session.id },
      json: { messages: toUiMessages(userText, text, records, options, model) },
    })
    .catch(() => undefined);

  return exitCode;
}
