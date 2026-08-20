import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_PROVIDERS, findProvider } from "@termkode/shared";
import { getHomeDirectory } from "./paths";

// Provider keys and the active model live in a single JSON file next to the
// sessions. It never leaves the machine, so it is the only account state
// TermKode has.
export type ProviderSettings = {
  apiKey?: string;
  baseUrl?: string;
};

export type TermkodeSettings = {
  activeModel: string | null;
  providers: Record<string, ProviderSettings>;
};

const EMPTY_SETTINGS: TermkodeSettings = { activeModel: null, providers: {} };

function getSettingsPath() {
  return join(getHomeDirectory(), "config.json");
}

export function readSettings(): TermkodeSettings {
  try {
    const parsed = JSON.parse(readFileSync(getSettingsPath(), "utf-8")) as Partial<TermkodeSettings>;
    const providers: Record<string, ProviderSettings> = {};

    for (const [providerId, value] of Object.entries(parsed.providers ?? {})) {
      if (!value || typeof value !== "object" || !findProvider(providerId)) continue;

      providers[providerId] = {
        ...(typeof value.apiKey === "string" && value.apiKey ? { apiKey: value.apiKey } : {}),
        ...(typeof value.baseUrl === "string" && value.baseUrl ? { baseUrl: value.baseUrl } : {}),
      };
    }

    return {
      activeModel: typeof parsed.activeModel === "string" ? parsed.activeModel : null,
      providers,
    };
  } catch {
    return { ...EMPTY_SETTINGS, providers: {} };
  }
}

function writeSettings(settings: TermkodeSettings) {
  const path = getSettingsPath();
  const temporaryPath = `${path}.tmp`;

  // API keys are readable secrets, so keep the file private to this OS user.
  writeFileSync(temporaryPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  renameSync(temporaryPath, path);
}

export function saveProviderSettings(providerId: string, settings: ProviderSettings) {
  const current = readSettings();
  const next: TermkodeSettings = {
    ...current,
    providers: {
      ...current.providers,
      [providerId]: {
        ...current.providers[providerId],
        ...settings,
      },
    },
  };

  writeSettings(next);
  return next;
}

export function removeProviderSettings(providerId: string) {
  const current = readSettings();
  const providers = { ...current.providers };
  delete providers[providerId];

  const activeModel = current.activeModel?.startsWith(`${providerId}/`)
    ? null
    : current.activeModel;

  const next: TermkodeSettings = { activeModel, providers };
  writeSettings(next);
  return next;
}

export function saveActiveModel(model: string | null) {
  const next: TermkodeSettings = { ...readSettings(), activeModel: model };
  writeSettings(next);
  return next;
}

export type ResolvedCredentials = {
  apiKey?: string;
  baseUrl: string;
  /** Where the key came from, so the UI can explain what is already set up. */
  source: "config" | "env" | "none";
};

export function resolveProviderCredentials(providerId: string): ResolvedCredentials | null {
  const provider = findProvider(providerId);
  if (!provider) return null;

  const stored = readSettings().providers[providerId];
  const envKey = provider.apiKeyEnvVars
    .map((variable) => process.env[variable])
    .find((value) => Boolean(value));

  const apiKey = stored?.apiKey ?? envKey;

  return {
    ...(apiKey ? { apiKey } : {}),
    baseUrl: stored?.baseUrl ?? provider.defaultBaseUrl,
    source: stored?.apiKey ? "config" : envKey ? "env" : "none",
  };
}

export function listConfiguredProviderIds() {
  return CHAT_PROVIDERS.filter((provider) => {
    const credentials = resolveProviderCredentials(provider.id);
    return Boolean(credentials?.apiKey);
  }).map((provider) => provider.id);
}
