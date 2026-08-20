import { describe, expect, test } from "bun:test";
import { ModelResolutionError, resolveChatModel } from "./models";

describe("chat model resolution", () => {
  test("rejects a model that belongs to no configured provider", async () => {
    await expect(resolveChatModel("not-a-real-model")).rejects.toBeInstanceOf(
      ModelResolutionError,
    );
  });

  test("explains which key is missing instead of failing mid-stream", async () => {
    await expect(resolveChatModel("minimax/MiniMax-M2")).rejects.toThrow(
      /MINIMAX_API_KEY/,
    );
  });

  test("builds a model once the provider key is available", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-test-key";

    try {
      const resolved = await resolveChatModel("deepseek/deepseek-chat");

      expect(resolved.provider).toBe("deepseek");
      expect(resolved.modelId).toBe("deepseek-chat");
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
    }
  });

  test("keeps resolving model ids stored before providers existed", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";

    try {
      const resolved = await resolveChatModel("claude-opus-4-6");

      expect(resolved.provider).toBe("anthropic");
      expect(resolved.modelId).toBe("claude-opus-4-6");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test("only asks for extended thinking when the user turned it on", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    process.env.DEEPSEEK_API_KEY = "sk-test-key";

    try {
      const quiet = await resolveChatModel("anthropic/claude-opus-4-6");
      expect(quiet.providerOptions).toBeUndefined();

      const thinking = await resolveChatModel("anthropic/claude-opus-4-6", {
        thinking: true,
      });
      expect(thinking.providerOptions?.anthropic).toBeDefined();

      // OpenAI-compatible backends need to be told to stop reasoning.
      const compatible = await resolveChatModel("deepseek/deepseek-chat");
      expect(compatible.providerOptions?.deepseek).toEqual({ reasoningEffort: "none" });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.DEEPSEEK_API_KEY;
    }
  });
});
