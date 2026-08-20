import { describe, expect, test } from "bun:test";
import {
  CHAT_PROVIDERS,
  findModelPricing,
  findProvider,
  formatModelRef,
  parseModelRef,
} from "./models";

describe("model references", () => {
  test("round-trips a provider and model id", () => {
    const ref = formatModelRef("deepseek", "deepseek-chat");

    expect(ref).toBe("deepseek/deepseek-chat");
    expect(parseModelRef(ref)).toEqual({
      providerId: "deepseek",
      modelId: "deepseek-chat",
    });
  });

  test("keeps slashes and colons that belong to the model id", () => {
    expect(parseModelRef("local/hf.co/user/model:q4")).toEqual({
      providerId: "local",
      modelId: "hf.co/user/model:q4",
    });
  });

  test("resolves model ids stored before providers were selectable", () => {
    expect(parseModelRef("gpt-5.4-mini")).toEqual({
      providerId: "openai",
      modelId: "gpt-5.4-mini",
    });
  });

  test("returns nothing for an unknown reference", () => {
    expect(parseModelRef("unknown-provider/some-model")).toBeNull();
    expect(parseModelRef("")).toBeNull();
  });

  test("exposes pricing only for models with published rates", () => {
    expect(findModelPricing("anthropic/claude-haiku-4-5")).toEqual({
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 5,
    });
    expect(findModelPricing("local/llama3.1:8b")).toBeUndefined();
  });

  test("ships the providers the setup flow offers", () => {
    expect(CHAT_PROVIDERS.map((provider) => provider.id)).toEqual([
      "anthropic",
      "openai",
      "deepseek",
      "qwen",
      "kimi",
      "minimax",
      "grok",
      "nvidia",
      "meta",
      "groq",
      "openrouter",
      "mistral",
      "cerebras",
      "together",
      "zai",
      "cloudflare",
      "local",
    ]);
    expect(findProvider("local")?.requiresApiKey).toBe(false);

    // Every remote provider needs a key, a base URL, and somewhere to get one.
    for (const provider of CHAT_PROVIDERS.filter((p) => !p.isLocal)) {
      expect(provider.requiresApiKey).toBe(true);
      expect(provider.defaultBaseUrl).toStartWith("https://");
      expect(provider.apiKeyEnvVars.length).toBeGreaterThan(0);
    }
  });
});
