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

  test("asks for a Bedrock region before building a model", async () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "test-key";
    const previousRegion = process.env.AWS_REGION;
    const previousDefault = process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;

    try {
      await expect(resolveChatModel("bedrock/amazon.nova-lite-v1:0")).rejects.toThrow(
        /AWS_REGION/,
      );
    } finally {
      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      if (previousRegion === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = previousRegion;
      if (previousDefault === undefined) delete process.env.AWS_DEFAULT_REGION;
      else process.env.AWS_DEFAULT_REGION = previousDefault;
    }
  });

  test("builds a Bedrock model once the key and region are available", async () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "test-key";
    process.env.AWS_REGION = "us-east-1";

    try {
      const resolved = await resolveChatModel("bedrock/us.anthropic.claude-sonnet-4-6");

      expect(resolved.provider).toBe("bedrock");
      expect(resolved.modelId).toBe("us.anthropic.claude-sonnet-4-6");
    } finally {
      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      delete process.env.AWS_REGION;
    }
  });

  test("routes ChatGPT Luna on Bedrock through the OpenAI-compatible API", async () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "test-key";
    process.env.AWS_REGION = "ap-south-1";

    try {
      const resolved = await resolveChatModel("bedrock/in.openai.gpt-5.6-luna");

      expect(resolved.provider).toBe("bedrock");
      expect(resolved.modelId).toBe("in.openai.gpt-5.6-luna");
    } finally {
      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      delete process.env.AWS_REGION;
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
