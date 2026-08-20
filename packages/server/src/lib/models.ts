import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { findProvider, parseModelRef } from "@termkode/shared";
import type { LanguageModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { detectLocalRuntime } from "./local-ai";
import { resolveProviderCredentials } from "./settings";

// Always a model instance, never a model id string, so it can be wrapped in
// middleware.
export type ResolvedModel = {
  model: Exclude<LanguageModel, string>;
  provider: string;
  modelId: string;
  providerOptions?: ProviderOptions;
};

// Extended thinking and reasoning effort are opt-in per model family. Only the
// models known to accept them get the option, so unknown or newly released
// models are still usable with plain defaults.
const ANTHROPIC_THINKING_MODELS = new Set([
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
]);

const OPENAI_REASONING_EFFORT: Record<string, "low" | "medium" | "high"> = {
  "gpt-5.4": "high",
  "gpt-5.4-mini": "medium",
  "gpt-5.4-nano": "low",
};

function getProviderOptions(
  providerId: string,
  modelId: string,
  thinking: boolean,
): ProviderOptions | undefined {
  if (providerId === "anthropic") {
    return thinking && ANTHROPIC_THINKING_MODELS.has(modelId)
      ? { anthropic: { thinking: { type: "enabled", budgetTokens: 10000 } } }
      : undefined;
  }

  if (providerId === "openai") {
    const reasoningEffort = OPENAI_REASONING_EFFORT[modelId];
    return thinking && reasoningEffort
      ? { openai: { reasoningEffort, maxCompletionTokens: 10000 } }
      : undefined;
  }

  // OpenAI-compatible backends such as Ollama accept reasoning_effort, and
  // "none" is what stops a hybrid model from thinking through its whole budget.
  return thinking ? undefined : { [providerId]: { reasoningEffort: "none" } };
}

export class ModelResolutionError extends Error {}

export async function resolveChatModel(
  ref: string,
  options: { thinking?: boolean } = {},
): Promise<ResolvedModel> {
  const parsed = parseModelRef(ref);
  if (!parsed) {
    throw new ModelResolutionError(
      `Unknown model: ${ref}. Run /models to pick a model, or /providers to add one.`,
    );
  }

  const provider = findProvider(parsed.providerId);
  const credentials = resolveProviderCredentials(parsed.providerId);
  if (!provider || !credentials) {
    throw new ModelResolutionError(`Unknown provider: ${parsed.providerId}`);
  }

  if (provider.requiresApiKey && !credentials.apiKey) {
    throw new ModelResolutionError(
      `No API key for ${provider.label}. Run /providers to add one, or set ${provider.apiKeyEnvVars[0]}.`,
    );
  }

  let baseUrl = credentials.baseUrl;

  if (provider.isLocal) {
    const runtime = await detectLocalRuntime();
    if (!runtime) {
      throw new ModelResolutionError(
        "No local AI server is running. Start Ollama, LM Studio, llama.cpp, vLLM, or Jan and try again.",
      );
    }

    baseUrl = runtime.baseUrl;
  }

  const providerOptions = getProviderOptions(
    parsed.providerId,
    parsed.modelId,
    options.thinking ?? false,
  );
  const common = {
    provider: parsed.providerId,
    modelId: parsed.modelId,
    ...(providerOptions ? { providerOptions } : {}),
  };

  switch (provider.kind) {
    case "anthropic":
      return {
        ...common,
        model: createAnthropic({
          apiKey: credentials.apiKey,
          baseURL: baseUrl,
        })(parsed.modelId),
      };
    case "openai":
      return {
        ...common,
        model: createOpenAI({
          apiKey: credentials.apiKey,
          baseURL: baseUrl,
        })(parsed.modelId),
      };
    case "openai-compatible":
      return {
        ...common,
        model: createOpenAICompatible({
          name: provider.id,
          baseURL: baseUrl,
          // Local runtimes ignore the key but the OpenAI protocol expects one.
          apiKey: credentials.apiKey ?? "local",
        })(parsed.modelId),
      };
  }
}
