import { describe, expect, test } from "bun:test";
import {
  hasPendingToolCalls,
  submitSchema,
  type TermkodeUIMessage,
} from "./chat-validation";

const textMessage = {
  id: "message-1",
  role: "user",
  parts: [{ type: "text", text: "Inspect the repository" }],
} as TermkodeUIMessage;

describe("chat request validation", () => {
  test("accepts provider-qualified and legacy model references", () => {
    for (const model of ["anthropic/claude-opus-4-6", "local/llama3.1:8b", "claude-opus-4-6"]) {
      expect(
        submitSchema.safeParse({
          id: "session-1",
          messages: [textMessage],
          mode: "PLAN",
          model,
        }).success,
      ).toBe(true);
    }
  });

  test("rejects empty messages and empty models", () => {
    expect(
      submitSchema.safeParse({
        id: "session-1",
        messages: [],
        mode: "PLAN",
        model: "anthropic/claude-opus-4-6",
      }).success,
    ).toBe(false);

    expect(
      submitSchema.safeParse({
        id: "session-1",
        messages: [textMessage],
        mode: "PLAN",
        model: "",
      }).success,
    ).toBe(false);
  });

  test("detects pending tool calls while allowing completed calls", () => {
    const pending = {
      ...textMessage,
      parts: [{ type: "tool-readFile", state: "input-available" }],
    } as TermkodeUIMessage;
    const completed = {
      ...textMessage,
      parts: [{ type: "tool-readFile", state: "output-available" }],
    } as TermkodeUIMessage;

    expect(hasPendingToolCalls(pending)).toBe(true);
    expect(hasPendingToolCalls(completed)).toBe(false);
    expect(hasPendingToolCalls(textMessage)).toBe(false);
  });
});
