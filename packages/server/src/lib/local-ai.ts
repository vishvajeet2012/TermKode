// Local model runners all expose an OpenAI-compatible API on a well-known
// loopback port, so TermKode can find them without any configuration: if one is
// running, "Local AI" simply becomes available.
type LocalRuntime = {
  label: string;
  baseUrl: string;
};

export type DetectedLocalRuntime = LocalRuntime & {
  models: string[];
};

const LOCAL_RUNTIMES: LocalRuntime[] = [
  { label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
  { label: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1" },
  { label: "vLLM", baseUrl: "http://127.0.0.1:8000/v1" },
  { label: "Jan", baseUrl: "http://127.0.0.1:1337/v1" },
  { label: "Text generation WebUI", baseUrl: "http://127.0.0.1:5000/v1" },
];

const PROBE_TIMEOUT_MS = 700;
const CACHE_TTL_MS = 30_000;

let cache: { detectedAt: number; runtime: DetectedLocalRuntime | null } | null = null;

function parseModelList(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];

  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  return data
    .map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

async function probe(runtime: LocalRuntime): Promise<DetectedLocalRuntime | null> {
  try {
    const response = await fetch(`${runtime.baseUrl}/models`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const models = parseModelList(await response.json());
    return { ...runtime, models };
  } catch {
    // Nothing is listening on that port, which is the normal case.
    return null;
  }
}

export async function detectLocalRuntime(options: { refresh?: boolean } = {}) {
  const now = Date.now();

  if (!options.refresh && cache && now - cache.detectedAt < CACHE_TTL_MS) {
    return cache.runtime;
  }

  // A configured base URL wins over discovery so a custom port keeps working.
  const configuredBaseUrl = process.env.LOCAL_AI_BASE_URL;
  const candidates = configuredBaseUrl
    ? [{ label: "Local AI", baseUrl: configuredBaseUrl.replace(/\/+$/, "") }, ...LOCAL_RUNTIMES]
    : LOCAL_RUNTIMES;

  const results = await Promise.all(candidates.map(probe));
  const runtime = results.find((result) => result !== null) ?? null;

  cache = { detectedAt: now, runtime };
  return runtime;
}

export function clearLocalRuntimeCache() {
  cache = null;
}
