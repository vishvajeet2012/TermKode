import { describe, expect, test } from "bun:test";
import { recoverTextToolCalls } from "./text-tool-calls";

type StreamPart = Record<string, unknown>;

async function run(parts: StreamPart[], toolNames = ["bash", "readFile"]) {
  const middleware = recoverTextToolCalls(toolNames);
  const source = new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });

  const result = await middleware.wrapStream!({
    doStream: async () => ({ stream: source }) as never,
    doGenerate: async () => ({}) as never,
    params: {} as never,
    model: {} as never,
  });

  const output: StreamPart[] = [];
  for await (const part of result.stream as unknown as AsyncIterable<StreamPart>) {
    output.push(part);
  }
  return output;
}

function textParts(text: string, options: { end?: boolean } = {}): StreamPart[] {
  const { end = true } = options;
  return [
    { type: "text-start", id: "txt-0" },
    ...text.split(/(?<=\s)/).map((delta) => ({ type: "text-delta", id: "txt-0", delta })),
    ...(end ? [{ type: "text-end", id: "txt-0" }] : []),
    { type: "finish", finishReason: "stop", usage: {} },
  ];
}

function textOf(parts: StreamPart[]) {
  return parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("");
}

describe("recovering tool calls printed as text", () => {
  test("turns a mis-tagged tool call into a real one", async () => {
    // Exactly what a small local model produced: opened with <tool_response>
    // and closed with </tool_call>.
    const output = await run(
      textParts(
        '<tool_response>\n{"name": "bash", "arguments": {"command": "wmic memphysical get freebytes"}}\n</tool_call>',
      ),
    );

    const call = output.find((part) => part.type === "tool-call");
    expect(call?.toolName).toBe("bash");
    expect(JSON.parse(call?.input as string)).toEqual({
      command: "wmic memphysical get freebytes",
    });

    // The raw JSON must not also reach the user as text.
    expect(output.some((part) => part.type === "text-delta")).toBe(false);
    expect(output.find((part) => part.type === "finish")?.finishReason).toBe("tool-calls");
  });

  test("recovers the correctly tagged form and fenced JSON", async () => {
    for (const text of [
      '<tool_call>{"name": "readFile", "arguments": {"path": "README.md"}}</tool_call>',
      '```json\n{"name": "readFile", "parameters": {"path": "README.md"}}\n```',
      '{"name": "readFile", "arguments": {"path": "README.md"}}',
    ]) {
      const output = await run(textParts(text));
      const call = output.find((part) => part.type === "tool-call");

      expect(call?.toolName).toBe("readFile");
      expect(JSON.parse(call?.input as string)).toEqual({ path: "README.md" });
    }
  });

  // A held-back "text-start" must never be dropped or reordered: the UI rejects
  // a text-delta whose text part was never opened.
  test("keeps text-start ahead of its deltas for an ordinary answer", async () => {
    const output = await run(textParts("Your machine has 8 GB of RAM installed."));

    expect(output.some((part) => part.type === "tool-call")).toBe(false);
    expect(output[0]).toEqual({ type: "text-start", id: "txt-0" });
    expect(output.at(-2)).toEqual({ type: "text-end", id: "txt-0" });
    expect(textOf(output)).toBe("Your machine has 8 GB of RAM installed.");
  });

  test("keeps order for an answer that begins like a tool call", async () => {
    // Starts with "{" so it is held, then turns out to be prose.
    const output = await run(textParts('{"note": true} is not a tool call, just text.'));

    const startIndex = output.findIndex((part) => part.type === "text-start");
    const firstDelta = output.findIndex((part) => part.type === "text-delta");

    expect(startIndex).toBe(0);
    expect(firstDelta).toBeGreaterThan(startIndex);
    expect(textOf(output)).toBe('{"note": true} is not a tool call, just text.');
  });

  test("releases held text when the stream ends without text-end", async () => {
    const output = await run(textParts('{"name": "bash"', { end: false }));

    expect(output.some((part) => part.type === "text-start")).toBe(true);
    expect(textOf(output)).toBe('{"name": "bash"');
  });

  test("ignores JSON that names a tool the agent does not have", async () => {
    const output = await run(
      textParts('{"name": "launchMissiles", "arguments": {"target": "moon"}}'),
    );

    expect(output.some((part) => part.type === "tool-call")).toBe(false);
    expect(output[0]?.type).toBe("text-start");
    expect(textOf(output)).toContain("launchMissiles");
  });

  test("passes real tool calls through unchanged", async () => {
    const output = await run([
      { type: "tool-input-start", id: "a", toolName: "bash" },
      { type: "tool-call", toolCallId: "a", toolName: "bash", input: '{"command":"ls"}' },
      { type: "finish", finishReason: "tool-calls", usage: {} },
    ]);

    expect(output).toHaveLength(3);
    expect(output[1]?.toolCallId).toBe("a");
  });
});
