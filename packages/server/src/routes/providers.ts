import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  CHAT_PROVIDERS,
  findProvider,
  formatModelRef,
  providerNeedsAccountId,
} from "@termkode/shared";
import { detectLocalRuntime } from "../lib/local-ai";
import {
  clearModelCache,
  getProviderModels,
  ProviderRequestError,
  verifyProviderCredentials,
} from "../lib/model-catalog";
import {
  readSettings,
  removeProviderSettings,
  resolveProviderCredentials,
  saveActiveModel,
  saveProviderSettings,
} from "../lib/settings";

const credentialsSchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().url().optional(),
  // Cloudflare account ids are 32 hex characters; the check stays loose so a
  // future format is not rejected here.
  accountId: z.string().trim().min(1).max(128).optional(),
});

const modelListQuerySchema = z.object({
  refresh: z.enum(["true", "false"]).optional(),
});

const activeModelSchema = z.object({
  model: z.string().min(1).nullable(),
});

function toErrorResponse(error: unknown) {
  if (error instanceof ProviderRequestError) {
    return { message: error.message, status: 400 as const };
  }

  return {
    message: error instanceof Error ? error.message : "Provider request failed",
    status: 500 as const,
  };
}

const app = new Hono()
  // Everything the setup dialog needs: which providers exist, which are ready
  // to use, and whether a local AI server was found on this machine.
  .get("/", async (c) => {
    const settings = readSettings();
    const localRuntime = await detectLocalRuntime();

    const providers = CHAT_PROVIDERS.map((provider) => {
      const credentials = resolveProviderCredentials(provider.id);
      const detected = provider.isLocal ? localRuntime !== null : undefined;
      const ready = provider.requiresApiKey
        ? Boolean(credentials?.apiKey) && !credentials?.accountIdMissing
        : Boolean(detected);

      return {
        id: provider.id,
        label: provider.label,
        description: provider.description,
        requiresApiKey: provider.requiresApiKey,
        isLocal: Boolean(provider.isLocal),
        apiKeyUrl: provider.apiKeyUrl ?? null,
        apiKeyEnvVar: provider.apiKeyEnvVars[0] ?? null,
        baseUrl: provider.isLocal
          ? localRuntime?.baseUrl ?? credentials?.baseUrl ?? provider.defaultBaseUrl
          : credentials?.baseUrl ?? provider.defaultBaseUrl,
        keySource: credentials?.source ?? "none",
        ready,
        // The setup dialog asks for this before the key when a provider is
        // scoped to one account.
        accountIdLabel: provider.accountId?.label ?? null,
        accountIdHelp: provider.accountId?.help ?? null,
        accountIdEnvVar: provider.accountId?.envVars[0] ?? null,
        needsAccountId: providerNeedsAccountId(provider),
        hasAccountId: Boolean(credentials?.accountId),
        ...(provider.isLocal
          ? {
              detected: Boolean(detected),
              runtimeLabel: localRuntime?.label ?? null,
              detectedModels: localRuntime?.models ?? [],
            }
          : {}),
      };
    });

    return c.json({
      providers,
      activeModel: settings.activeModel,
    });
  })
  // Every configured provider's models in one list, for the /models picker.
  .get("/models", async (c) => {
    const models: Array<{
      ref: string;
      providerId: string;
      providerLabel: string;
      modelId: string;
    }> = [];

    for (const provider of CHAT_PROVIDERS) {
      const credentials = resolveProviderCredentials(provider.id);
      const isReady = provider.requiresApiKey
        ? Boolean(credentials?.apiKey)
        : (await detectLocalRuntime()) !== null;

      if (!isReady) continue;

      try {
        const { models: providerModels } = await getProviderModels(provider.id);
        for (const modelId of providerModels) {
          models.push({
            ref: formatModelRef(provider.id, modelId),
            providerId: provider.id,
            providerLabel: provider.label,
            modelId,
          });
        }
      } catch {
        // One unreachable provider must not hide the models of the others.
      }
    }

    return c.json({ models, activeModel: readSettings().activeModel });
  })
  .get("/:id/models", zValidator("query", modelListQuerySchema), async (c) => {
    const providerId = c.req.param("id");
    if (!findProvider(providerId)) {
      return c.json({ error: `Unknown provider: ${providerId}` }, 404);
    }

    try {
      const refresh = c.req.valid("query").refresh === "true";
      const { models, source } = await getProviderModels(providerId, { refresh });

      return c.json({
        source,
        models: models.map((modelId) => ({
          ref: formatModelRef(providerId, modelId),
          modelId,
        })),
      });
    } catch (error) {
      const { message, status } = toErrorResponse(error);
      return c.json({ error: message }, status);
    }
  })
  .put("/active-model", zValidator("json", activeModelSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "Invalid model" }, 400);
    }
  }), (c) => {
    const { model } = c.req.valid("json");
    return c.json({ activeModel: saveActiveModel(model).activeModel });
  })
  // Save an API key only after the provider confirms it works.
  .put("/:id", zValidator("json", credentialsSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "Provide an API key or a valid base URL" }, 400);
    }
  }), async (c) => {
    const providerId = c.req.param("id");
    const provider = findProvider(providerId);
    if (!provider) {
      return c.json({ error: `Unknown provider: ${providerId}` }, 404);
    }

    const { apiKey, baseUrl, accountId } = c.req.valid("json");

    if (provider.requiresApiKey && !apiKey) {
      return c.json({ error: `${provider.label} needs an API key` }, 400);
    }

    if (providerNeedsAccountId(provider) && !accountId && !baseUrl) {
      return c.json(
        { error: `${provider.label} needs an ${provider.accountId?.label ?? "account id"}` },
        400,
      );
    }

    // Write first so verification uses the new values, then roll back when the
    // provider rejects them.
    const previous = readSettings().providers[providerId];
    saveProviderSettings(providerId, {
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(accountId ? { accountId } : {}),
    });
    clearModelCache(providerId);

    try {
      const { models, source } = await verifyProviderCredentials(providerId);

      return c.json({
        source,
        models: models.map((modelId) => ({
          ref: formatModelRef(providerId, modelId),
          modelId,
        })),
      });
    } catch (error) {
      // Settings are merged, not replaced, so restoring `previous` on its own
      // would leave behind any field this attempt introduced. Clear first.
      removeProviderSettings(providerId);
      if (previous) {
        saveProviderSettings(providerId, previous);
      }
      clearModelCache(providerId);

      const { message, status } = toErrorResponse(error);
      return c.json({ error: message }, status);
    }
  })
  .delete("/:id", (c) => {
    const providerId = c.req.param("id");
    if (!findProvider(providerId)) {
      return c.json({ error: `Unknown provider: ${providerId}` }, 404);
    }

    const settings = removeProviderSettings(providerId);
    clearModelCache(providerId);

    return c.json({ activeModel: settings.activeModel });
  });

export default app;
