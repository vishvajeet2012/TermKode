export type ModelPricing = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};

// Every provider except Anthropic speaks the OpenAI chat-completions dialect,
// which is what lets TermKode support new services without new code.
export type ProviderKind = "anthropic" | "openai" | "openai-compatible";

export type ProviderDefinition = {
  id: string;
  label: string;
  description: string;
  kind: ProviderKind;
  defaultBaseUrl: string;
  /** Environment variables accepted as a key source, most specific first. */
  apiKeyEnvVars: string[];
  apiKeyUrl?: string;
  requiresApiKey: boolean;
  /** Discovered on the local network instead of configured by hand. */
  isLocal?: boolean;
  /** Lists models without authentication, so a key needs a second check. */
  publicModelListing?: boolean;
  /** Shown until the provider's live model list has been fetched. */
  fallbackModels: string[];
  pricing?: Record<string, ModelPricing>;
};

const PROVIDER_LIST = [
  {
    id: "anthropic",
    label: "Claude (Anthropic)",
    description: "Claude Opus, Sonnet, and Haiku",
    kind: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    apiKeyEnvVars: ["ANTHROPIC_API_KEY"],
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    requiresApiKey: true,
    fallbackModels: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
    pricing: {
      "claude-opus-4-6": { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: 25 },
      "claude-sonnet-4-6": { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
      "claude-haiku-4-5": { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 5 },
    },
  },
  {
    id: "openai",
    label: "ChatGPT (OpenAI)",
    description: "GPT models from OpenAI",
    kind: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    apiKeyEnvVars: ["OPENAI_API_KEY"],
    apiKeyUrl: "https://platform.openai.com/api-keys",
    requiresApiKey: true,
    fallbackModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
    pricing: {
      "gpt-5.4": { inputUsdPerMillionTokens: 2.5, outputUsdPerMillionTokens: 15 },
      "gpt-5.4-mini": { inputUsdPerMillionTokens: 0.75, outputUsdPerMillionTokens: 4.5 },
      "gpt-5.4-nano": { inputUsdPerMillionTokens: 0.2, outputUsdPerMillionTokens: 1.25 },
    },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek chat and reasoning models",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    apiKeyEnvVars: ["DEEPSEEK_API_KEY"],
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    requiresApiKey: true,
    fallbackModels: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "qwen",
    label: "Qwen (Alibaba)",
    description: "Qwen models through DashScope",
    kind: "openai-compatible",
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyEnvVars: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
    apiKeyUrl: "https://bailian.console.alibabacloud.com/?tab=model#/api-key",
    requiresApiKey: true,
    fallbackModels: ["qwen3-coder-plus", "qwen-max", "qwen-plus", "qwen-turbo"],
  },
  {
    id: "kimi",
    label: "Kimi (Moonshot)",
    description: "Kimi K2 and Moonshot models",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnvVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    apiKeyUrl: "https://platform.moonshot.ai/console/api-keys",
    requiresApiKey: true,
    fallbackModels: ["kimi-k2-turbo-preview", "kimi-k2-0905-preview", "moonshot-v1-128k"],
  },
  {
    id: "minimax",
    label: "MiniMax",
    description: "MiniMax text and agent models",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.minimax.io/v1",
    apiKeyEnvVars: ["MINIMAX_API_KEY"],
    apiKeyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    requiresApiKey: true,
    fallbackModels: ["MiniMax-M2", "MiniMax-Text-01"],
  },
  {
    id: "grok",
    label: "Grok (xAI)",
    description: "Grok models from xAI",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.x.ai/v1",
    apiKeyEnvVars: ["XAI_API_KEY", "GROK_API_KEY"],
    apiKeyUrl: "https://console.x.ai",
    requiresApiKey: true,
    fallbackModels: ["grok-4", "grok-3", "grok-code-fast-1"],
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    description: "Open models hosted on NVIDIA's inference API",
    kind: "openai-compatible",
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
    apiKeyEnvVars: ["NVIDIA_API_KEY"],
    apiKeyUrl: "https://build.nvidia.com",
    requiresApiKey: true,
    publicModelListing: true,
    fallbackModels: ["meta/llama-3.3-70b-instruct", "deepseek-ai/deepseek-r1"],
  },
  {
    id: "meta",
    label: "Llama (Meta)",
    description: "Llama models from Meta's own API",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.llama.com/compat/v1",
    apiKeyEnvVars: ["LLAMA_API_KEY", "META_API_KEY"],
    apiKeyUrl: "https://llama.developer.meta.com",
    requiresApiKey: true,
    fallbackModels: ["Llama-4-Maverick-17B-128E-Instruct-FP8"],
  },
  {
    id: "groq",
    label: "Groq",
    description: "Open models on Groq's fast inference hardware",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnvVars: ["GROQ_API_KEY"],
    apiKeyUrl: "https://console.groq.com/keys",
    requiresApiKey: true,
    fallbackModels: ["llama-3.3-70b-versatile"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "One key for models from many providers",
    kind: "openai-compatible",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnvVars: ["OPENROUTER_API_KEY"],
    apiKeyUrl: "https://openrouter.ai/keys",
    requiresApiKey: true,
    publicModelListing: true,
    fallbackModels: [],
  },
  {
    id: "mistral",
    label: "Mistral",
    description: "Mistral and Codestral models",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    apiKeyEnvVars: ["MISTRAL_API_KEY"],
    apiKeyUrl: "https://console.mistral.ai/api-keys",
    requiresApiKey: true,
    fallbackModels: ["mistral-large-latest", "codestral-latest"],
  },
  {
    id: "cerebras",
    label: "Cerebras",
    description: "Open models on Cerebras inference",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnvVars: ["CEREBRAS_API_KEY"],
    apiKeyUrl: "https://cloud.cerebras.ai",
    requiresApiKey: true,
    fallbackModels: ["llama-3.3-70b"],
  },
  {
    id: "together",
    label: "Together AI",
    description: "Open models hosted by Together",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.together.xyz/v1",
    apiKeyEnvVars: ["TOGETHER_API_KEY"],
    apiKeyUrl: "https://api.together.ai/settings/api-keys",
    requiresApiKey: true,
    fallbackModels: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"],
  },
  {
    id: "zai",
    label: "GLM (Z.ai)",
    description: "GLM models from Z.ai",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnvVars: ["ZAI_API_KEY", "ZHIPU_API_KEY"],
    apiKeyUrl: "https://z.ai/manage-apikey/apikey-list",
    requiresApiKey: true,
    fallbackModels: ["glm-4.6", "glm-4.5-air"],
  },
  {
    id: "local",
    label: "Local AI",
    description: "Ollama, LM Studio, llama.cpp, vLLM, or Jan on this machine",
    kind: "openai-compatible",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    apiKeyEnvVars: ["LOCAL_AI_API_KEY"],
    requiresApiKey: false,
    isLocal: true,
    fallbackModels: [],
  },
] as const satisfies readonly ProviderDefinition[];

export type ChatProvider = (typeof PROVIDER_LIST)[number];
export type ChatProviderId = ChatProvider["id"];

// Exposed with the widened type so callers can read optional fields such as
// `isLocal` without narrowing against every literal entry.
export const CHAT_PROVIDERS: readonly ProviderDefinition[] = PROVIDER_LIST;

/** `provider/model`, for example `deepseek/deepseek-chat`. */
export type ChatModelRef = string;

export type ParsedModelRef = {
  providerId: string;
  modelId: string;
};

// Sessions created before TermKode supported multiple providers stored bare
// model ids, so keep resolving them to the provider they belonged to.
const LEGACY_MODEL_PROVIDERS: Record<string, string> = {
  "claude-opus-4-6": "anthropic",
  "claude-sonnet-4-6": "anthropic",
  "claude-haiku-4-5": "anthropic",
  "gpt-5.4": "openai",
  "gpt-5.4-mini": "openai",
  "gpt-5.4-nano": "openai",
};

export function findProvider(providerId: string): ProviderDefinition | undefined {
  return CHAT_PROVIDERS.find((provider) => provider.id === providerId);
}

export function formatModelRef(providerId: string, modelId: string): ChatModelRef {
  return `${providerId}/${modelId}`;
}

// Model ids may contain slashes and colons (`hf.co/user/model`, `llama3.1:8b`),
// so only the first segment is treated as the provider.
export function parseModelRef(ref: string): ParsedModelRef | null {
  if (!ref) return null;

  const separatorIndex = ref.indexOf("/");

  if (separatorIndex > 0) {
    const providerId = ref.slice(0, separatorIndex);
    const modelId = ref.slice(separatorIndex + 1);

    if (modelId && findProvider(providerId)) {
      return { providerId, modelId };
    }
  }

  const legacyProviderId = LEGACY_MODEL_PROVIDERS[ref];
  return legacyProviderId ? { providerId: legacyProviderId, modelId: ref } : null;
}

export function findModelPricing(ref: string): ModelPricing | undefined {
  const parsed = parseModelRef(ref);
  if (!parsed) return undefined;

  return findProvider(parsed.providerId)?.pricing?.[parsed.modelId];
}

export function describeModelRef(ref: string) {
  const parsed = parseModelRef(ref);
  if (!parsed) return { providerLabel: "", modelId: ref };

  return {
    providerLabel: findProvider(parsed.providerId)?.label ?? parsed.providerId,
    modelId: parsed.modelId,
  };
}
