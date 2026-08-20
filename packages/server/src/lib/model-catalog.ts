import { findProvider, isAccountIdMissing } from "@termkode/shared";
import { detectLocalRuntime } from "./local-ai";
import { resolveProviderCredentials } from "./settings";

// Model lists are read from each provider at runtime, so a newly released model
// shows up in `/models` without a TermKode release.
export type ModelCatalogEntry = {
  ref: string;
  providerId: string;
  providerLabel: string;
  modelId: string;
};

export type ProviderModels = {
  models: string[];
  source: "remote" | "fallback";
};

const LISTING_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { fetchedAt: number; value: ProviderModels }>();

export class ProviderRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

// Cloudflare answers with its own envelope: { result: [{ name: "@cf/...", task }] }.
// Only text-generation models can drive a chat, and the shape is read
// defensively so a change to it degrades to the built-in list rather than
// throwing.
function parseCloudflareModelList(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];

  const result = (payload as { result?: unknown }).result;
  if (!Array.isArray(result)) return [];

  return result
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .filter((entry) => {
      const task = entry.task;
      if (!task || typeof task !== "object") return true;
      const name = (task as { name?: unknown }).name;
      return typeof name !== "string" || name.toLowerCase() === "text generation";
    })
    .map((entry) => entry.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function parseModelList(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];

  const data = (payload as { data?: unknown }).data;
  const entries = Array.isArray(data) ? data : [];

  return entries
    .map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

async function requestModelList(providerId: string): Promise<string[]> {
  const provider = findProvider(providerId);
  const credentials = resolveProviderCredentials(providerId);
  if (!provider || !credentials) {
    throw new ProviderRequestError(`Unknown provider: ${providerId}`);
  }

  const headers: Record<string, string> = provider.kind === "anthropic"
    ? {
        "x-api-key": credentials.apiKey ?? "",
        "anthropic-version": "2023-06-01",
      }
    : credentials.apiKey
      ? { Authorization: `Bearer ${credentials.apiKey}` }
      : {};

  if (credentials.accountIdMissing) {
    throw new ProviderRequestError(
      `${provider.label} needs an ${provider.accountId?.label ?? "account id"} before it can be used.`,
    );
  }

  // Workers AI has no OpenAI-style /models route - a GET there answers 405 -
  // so its catalogue is read from the account endpoint that does serve one.
  const cloudflare = provider.modelListing === "cloudflare";
  const url = cloudflare
    ? `${credentials.baseUrl.replace(/\/ai\/v1\/?$/, "/ai/models/search")}?per_page=200`
    : `${credentials.baseUrl}/models`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderRequestError(
      `Could not reach ${provider.label}. Check your connection and base URL.`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new ProviderRequestError(`${provider.label} rejected this API key.`, response.status);
  }

  // A wrong account id is a 404 here, and it is worth saying so plainly: it is
  // the one credential the user typed by hand rather than pasted.
  if (cloudflare && response.status === 404) {
    throw new ProviderRequestError(
      `${provider.label} did not recognise that ${provider.accountId?.label ?? "account id"}, or the token cannot read it.`,
      response.status,
    );
  }

  if (!response.ok) {
    throw new ProviderRequestError(
      `${provider.label} returned ${response.status} while listing models.`,
      response.status,
    );
  }

  const payload = await response.json();
  return cloudflare ? parseCloudflareModelList(payload) : parseModelList(payload);
}

export async function getProviderModels(
  providerId: string,
  options: { refresh?: boolean } = {},
): Promise<ProviderModels> {
  const provider = findProvider(providerId);
  if (!provider) {
    throw new ProviderRequestError(`Unknown provider: ${providerId}`);
  }

  if (!options.refresh) {
    const cached = cache.get(providerId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.value;
    }
  }

  if (provider.isLocal) {
    const runtime = await detectLocalRuntime({ refresh: options.refresh });
    const value: ProviderModels = {
      models: runtime?.models ?? [],
      source: runtime ? "remote" : "fallback",
    };

    cache.set(providerId, { fetchedAt: Date.now(), value });
    return value;
  }

  try {
    const models = await requestModelList(providerId);
    const value: ProviderModels = models.length > 0
      ? { models, source: "remote" }
      : { models: [...provider.fallbackModels], source: "fallback" };

    cache.set(providerId, { fetchedAt: Date.now(), value });
    return value;
  } catch (error) {
    // A rejected key is a real setup failure and must surface. Anything else
    // (no listing endpoint, offline) falls back to the built-in list.
    if (error instanceof ProviderRequestError && (error.status === 401 || error.status === 403)) {
      throw error;
    }

    const value: ProviderModels = {
      models: [...provider.fallbackModels],
      source: "fallback",
    };

    cache.set(providerId, { fetchedAt: Date.now(), value });
    return value;
  }
}

// Saving a key is only useful if it works, so confirm it against the provider
// before writing it to disk.
export async function verifyProviderCredentials(providerId: string) {
  const provider = findProvider(providerId);
  if (!provider) {
    throw new ProviderRequestError(`Unknown provider: ${providerId}`);
  }

  if (provider.isLocal) {
    const runtime = await detectLocalRuntime({ refresh: true });
    if (!runtime) {
      throw new ProviderRequestError(
        "No local AI server found. Start Ollama, LM Studio, llama.cpp, vLLM, or Jan and try again.",
      );
    }

    return { models: runtime.models, source: "remote" as const };
  }

  const models = await requestModelList(providerId);
  const resolved = models.length > 0 ? models : [...provider.fallbackModels];

  // Some providers list their models publicly, so a successful listing proves
  // nothing about the key. Spend one tiny completion to find out.
  if (provider.publicModelListing) {
    await requestSmallestCompletion(providerId, resolved[0]);
  }

  return models.length > 0
    ? { models, source: "remote" as const }
    : { models: resolved, source: "fallback" as const };
}

async function requestSmallestCompletion(providerId: string, modelId: string | undefined) {
  const provider = findProvider(providerId);
  const credentials = resolveProviderCredentials(providerId);
  if (!provider || !credentials || !modelId) return;

  let response: Response;
  try {
    response = await fetch(`${credentials.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
    });
  } catch {
    // The key may still be fine; a network hiccup must not reject it.
    return;
  }

  if (response.status === 401 || response.status === 403) {
    throw new ProviderRequestError(`${provider.label} rejected this API key.`, response.status);
  }
}

export function clearModelCache(providerId?: string) {
  if (providerId) {
    cache.delete(providerId);
    return;
  }

  cache.clear();
}
