import { useCallback, useEffect, useRef, useState } from "react";
import { TextAttributes, type InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { InferResponseType } from "hono/client";
import { apiClient } from "../../lib/api-client";
import { getErrorMessage } from "../../lib/http-errors";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { usePromptConfig } from "../../providers/prompt-config";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { DialogSearchList } from "../dialog-search-list";

type ProvidersState = InferResponseType<typeof apiClient.providers.$get, 200>;
type Provider = ProvidersState["providers"][number];
type ModelOption = { ref: string; modelId: string };

type Step = "providers" | "accountId" | "apiKey" | "models";

function describeStatus(provider: Provider) {
  if (provider.ready) {
    if (provider.isLocal) {
      return provider.runtimeLabel ? `detected · ${provider.runtimeLabel}` : "detected";
    }

    return provider.keySource === "env" ? "key from env" : "ready";
  }

  return provider.isLocal ? "not running" : "add key";
}

type CredentialStepProps = {
  prompt: string;
  help?: string | null;
  placeholder: string;
  busy: boolean;
  busyText?: string;
  footer: string;
  error: string | null;
  onSubmit: (value: string) => void;
};

// The terminal input reports its value through the renderable, so Enter is
// handled here rather than through a DOM-style submit event. An API key and an
// account id are collected the same way, so both use this step.
function CredentialStep({
  prompt,
  help,
  placeholder,
  busy,
  busyText,
  footer,
  error,
  onSubmit,
}: CredentialStepProps) {
  const inputRef = useRef<InputRenderable>(null);
  const { isTopLayer } = useKeyboardLayer();

  useKeyboard((key) => {
    if (!isTopLayer("dialog") || busy) return;
    if (key.name !== "return" && key.name !== "enter") return;

    const value = inputRef.current?.value ?? "";
    if (value.trim().length > 0) {
      onSubmit(value);
    }
  });

  return (
    <box flexDirection="column" gap={1}>
      <text>{prompt}</text>
      {help && <text attributes={TextAttributes.DIM}>{help}</text>}
      <input ref={inputRef} focused={!busy} placeholder={placeholder} />
      {busy && busyText && <text attributes={TextAttributes.DIM}>{busyText}</text>}
      {error && <text fg="red">{error}</text>}
      <text attributes={TextAttributes.DIM}>{footer}</text>
    </box>
  );
}

export function ProvidersDialogContent() {
  const dialog = useDialog();
  const toast = useToast();
  const { setModel } = usePromptConfig();
  const [step, setStep] = useState<Step>("providers");
  const [state, setState] = useState<ProvidersState | null>(null);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Held between the two steps: an account-scoped provider is saved once, with
  // both values, so a half-configured provider is never written to disk.
  const [accountId, setAccountId] = useState("");

  useEffect(() => {
    let ignore = false;

    const load = async () => {
      try {
        const response = await apiClient.providers.$get();
        if (!response.ok) throw new Error(await getErrorMessage(response));
        const data = await response.json();
        if (!ignore) setState(data);
      } catch (cause) {
        if (!ignore) {
          setError(cause instanceof Error ? cause.message : "Failed to load providers");
        }
      }
    };

    void load();
    return () => {
      ignore = true;
    };
  }, []);

  const openModelStep = useCallback((selected: Provider, options: ModelOption[]) => {
    setProvider(selected);
    setModels(options);
    setStep("models");
  }, []);

  const loadModels = useCallback(
    async (selected: Provider) => {
      setStep("models");
      setBusy(true);
      setError(null);

      try {
        // Picking a provider is an explicit action, so re-read its model list
        // instead of serving a cached one. This also finds a local AI server
        // that was started after TermKode.
        const response = await apiClient.providers[":id"].models.$get({
          param: { id: selected.id },
          query: { refresh: "true" },
        });
        if (!response.ok) throw new Error(await getErrorMessage(response));

        const data = await response.json();
        openModelStep(selected, data.models);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to load models");
      } finally {
        setBusy(false);
      }
    },
    [openModelStep],
  );

  const handleSelectProvider = useCallback(
    (selected: Provider) => {
      setProvider(selected);
      setError(null);

      // A provider that already has a working key, and a local server that is
      // already running, both skip straight to model selection.
      if (selected.ready || selected.isLocal) {
        void loadModels(selected);
        return;
      }

      // Workers AI is reached through an account-scoped URL, so the account id
      // is asked for first - without it there is nowhere to verify the key.
      setAccountId("");
      setStep(selected.needsAccountId && !selected.hasAccountId ? "accountId" : "apiKey");
    },
    [loadModels],
  );

  const handleSubmitApiKey = useCallback(
    (value: string) => {
      const apiKey = value.trim();
      if (!provider || apiKey.length === 0 || busy) return;

      const save = async () => {
        setBusy(true);
        setError(null);

        try {
          const response = await apiClient.providers[":id"].$put({
            param: { id: provider.id },
            json: { apiKey, ...(accountId ? { accountId } : {}) },
          });
          if (!response.ok) throw new Error(await getErrorMessage(response));

          const data = await response.json();
          toast.show({ variant: "success", message: `${provider.label} connected` });
          openModelStep({ ...provider, ready: true, keySource: "config" }, data.models);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Failed to save API key");
        } finally {
          setBusy(false);
        }
      };

      void save();
    },
    [provider, busy, accountId, toast, openModelStep],
  );

  const handleSelectModel = useCallback(
    (option: ModelOption) => {
      setModel(option.ref);
      dialog.close();
      toast.show({ variant: "success", message: `Model set to ${option.modelId}` });
    },
    [setModel, dialog, toast],
  );

  if (error && !state) {
    return <text fg="red">{error}</text>;
  }

  if (!state) {
    return <text attributes={TextAttributes.DIM}>Loading providers...</text>;
  }

  if (step === "accountId" && provider) {
    return (
      <CredentialStep
        prompt={`Enter your ${provider.label} ${provider.accountIdLabel ?? "account id"}`}
        help={provider.accountIdHelp}
        placeholder="0123456789abcdef0123456789abcdef"
        busy={false}
        footer={`enter continue · esc cancel${provider.accountIdEnvVar ? ` · or set ${provider.accountIdEnvVar}` : ""}`}
        error={error}
        onSubmit={(value) => {
          setAccountId(value.trim());
          setError(null);
          setStep("apiKey");
        }}
      />
    );
  }

  if (step === "apiKey" && provider) {
    return (
      <CredentialStep
        prompt={`Paste your ${provider.label} API key`}
        help={provider.apiKeyUrl ? `Get one at ${provider.apiKeyUrl}` : null}
        placeholder="sk-..."
        busy={busy}
        busyText={`Verifying key with ${provider.label}...`}
        footer="enter save · esc cancel · saved to ~/.termkode/config.json"
        error={error}
        onSubmit={handleSubmitApiKey}
      />
    );
  }

  if (step === "models" && provider) {
    if (busy) {
      return <text attributes={TextAttributes.DIM}>Loading {provider.label} models...</text>;
    }

    if (models.length === 0) {
      return (
        <box flexDirection="column" gap={1}>
          <text attributes={TextAttributes.DIM}>
            {provider.isLocal
              ? "No local AI server found. Start Ollama, LM Studio, llama.cpp, vLLM, or Jan, then reopen /providers."
              : `${provider.label} returned no models.`}
          </text>
          {error && <text fg="red">{error}</text>}
        </box>
      );
    }

    return (
      <box flexDirection="column" gap={1}>
        <text attributes={TextAttributes.DIM}>{provider.label} models</text>
        <DialogSearchList
          items={models}
          onSelect={handleSelectModel}
          filterFn={(option, query) => option.modelId.toLowerCase().includes(query.toLowerCase())}
          renderItem={(option, isSelected) => (
            <text selectable={false} fg={isSelected ? "black" : "white"}>
              {option.modelId}
            </text>
          )}
          getKey={(option) => option.ref}
          placeholder="Search models"
          emptyText="No matching models"
        />
      </box>
    );
  }

  return (
    <box flexDirection="column" gap={1}>
      <text attributes={TextAttributes.DIM}>
        Pick a provider, then paste its API key. Local AI is detected automatically.
      </text>
      <DialogSearchList
        items={state.providers}
        onSelect={handleSelectProvider}
        filterFn={(item, query) => item.label.toLowerCase().includes(query.toLowerCase())}
        renderItem={(item, isSelected) => (
          <>
            <text selectable={false} fg={isSelected ? "black" : "white"}>
              {item.label}
            </text>
            <box flexGrow={1} />
            <text
              selectable={false}
              fg={isSelected ? "black" : item.ready ? "green" : undefined}
              attributes={item.ready ? undefined : TextAttributes.DIM}
            >
              {describeStatus(item)}
            </text>
          </>
        )}
        getKey={(item) => item.id}
        placeholder="Search providers"
        emptyText="No matching providers"
        maxVisibleItems={10}
      />
      {error && <text fg="red">{error}</text>}
    </box>
  );
}
