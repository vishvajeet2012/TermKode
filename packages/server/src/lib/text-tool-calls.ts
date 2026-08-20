import type { LanguageModelMiddleware } from "ai";

// Small local models often describe a tool call instead of emitting one: they
// print `<tool_call>{"name": "bash", "arguments": {...}}</tool_call>`, or close
// a block with the wrong tag, and the runtime hands it back as plain text. The
// user then sees JSON instead of the command running. This middleware reads
// that text back into a real tool call so the agent keeps working.

type ParsedCall = {
  toolName: string;
  input: unknown;
};

// Anything that looks like the opening of a tool call, including the malformed
// variants these models produce.
const CALL_START = /^\s*(?:<tool_call>|<tool_response>|<function_call>|```json\s*\{?|\{\s*"?n?a?m?e?"?)/;

const CALL_PATTERN =
  /<(?:tool_call|tool_response|function_call)>\s*([\s\S]*?)\s*<\/(?:tool_call|tool_response|function_call)>|```json\s*([\s\S]*?)```/;

function extractJson(text: string): string | null {
  const tagged = text.match(CALL_PATTERN);
  const candidate = tagged?.[1] ?? tagged?.[2];
  if (candidate) return candidate.trim();

  // A bare object with no wrapper at all.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start !== -1 && end > start ? text.slice(start, end + 1) : null;
}

function parseCall(text: string, toolNames: Set<string>): ParsedCall | null {
  const json = extractJson(text);
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;

  const record = parsed as Record<string, unknown>;
  const toolName = typeof record.name === "string" ? record.name : undefined;
  if (!toolName || !toolNames.has(toolName)) return null;

  const input = record.arguments ?? record.parameters ?? record.input ?? {};
  return {
    toolName,
    input: typeof input === "string" ? safeParse(input) : input,
  };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function recoverTextToolCalls(
  toolNames: Iterable<string>,
): LanguageModelMiddleware {
  const names = new Set(toolNames);

  return {
    specificationVersion: "v4",
    async wrapStream({ doStream }) {
      const { stream, ...rest } = await doStream();

      // Text is held back only while it still looks like it could be a tool
      // call. The moment it clearly is not, everything held is released in the
      // order it arrived, so a "text-start" always precedes its deltas.
      let held: unknown[] = [];
      let buffer = "";
      let passthrough = false;
      let recovered = false;
      let callIndex = 0;

      const release = (controller: TransformStreamDefaultController) => {
        for (const part of held) controller.enqueue(part);
        held = [];
        buffer = "";
        passthrough = true;
      };

      const transform = new TransformStream({
        transform(part: any, controller) {
          const isTextPart =
            part.type === "text-start" ||
            part.type === "text-delta" ||
            part.type === "text-end";

          // Once a call is recovered the rest of the message is the model
          // narrating that call, which would only confuse the transcript.
          if (recovered && isTextPart) return;

          if (part.type === "text-start") {
            held = [part];
            buffer = "";
            passthrough = false;
            return;
          }

          if (part.type === "text-delta") {
            if (passthrough) {
              controller.enqueue(part);
              return;
            }

            buffer += typeof part.delta === "string" ? part.delta : "";
            held.push(part);

            if (!CALL_START.test(buffer)) release(controller);
            return;
          }

          if (part.type === "text-end") {
            if (passthrough) {
              controller.enqueue(part);
              return;
            }

            const call = buffer ? parseCall(buffer, names) : null;
            if (call) {
              controller.enqueue({
                type: "tool-call",
                toolCallId: `recovered_${callIndex++}`,
                toolName: call.toolName,
                input: JSON.stringify(call.input),
              });
              recovered = true;
              held = [];
              buffer = "";
              return;
            }

            release(controller);
            controller.enqueue(part);
            return;
          }

          if (part.type === "finish" && recovered) {
            controller.enqueue({ ...part, finishReason: "tool-calls" });
            return;
          }

          controller.enqueue(part);
        },
        flush(controller) {
          // The stream ended mid-text: nothing was a tool call, so release it.
          for (const part of held) controller.enqueue(part);
          held = [];
        },
      });

      return { stream: stream.pipeThrough(transform), ...rest };
    },
  };
}
