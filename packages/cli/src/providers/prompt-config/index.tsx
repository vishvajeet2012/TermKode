import { createContext, useContext, useState, useCallback, useEffect } from "react";
import type { ReactNode } from "react";
import {
  Mode,
  describeModelRef,
  type ModeType,
} from "@termkode/shared";
import { apiClient } from "../../lib/api-client";
import { getInitialMode } from "../../lib/runtime-flags";

type PromptConfigContextValue = {
  mode: ModeType;
  toggleMode: () => void;
  setMode: (mode: ModeType) => void;
  /** `provider/model`, or an empty string until a provider is configured. */
  model: string;
  setModel: (model: string) => void;
  modelLabel: string;
  hasModel: boolean;
  providersLoaded: boolean;
  /** Extended thinking. Off by default so tool calls are not starved. */
  thinking: boolean;
  toggleThinking: () => void;
};

const PromptConfigContext = createContext<PromptConfigContextValue | null>(null);

export function usePromptConfig(): PromptConfigContextValue {
  const value = useContext(PromptConfigContext);
  if (!value) {
    throw new Error("usePromptConfig must be used within a PromptConfigProvider");
  }
  return value;
}

type PromptConfigProviderProps = {
  children: ReactNode;
};

export function PromptConfigProvider({ children }: PromptConfigProviderProps) {
  // --plan / --mode PLAN starts read-only, which is the safer way to open an
  // unfamiliar repository.
  const [mode, setMode] = useState<ModeType>(getInitialMode);
  const [model, setModelState] = useState("");
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [thinking, setThinking] = useState(false);

  // The active model is remembered in ~/.termkode/config.json. When nothing is
  // stored yet, fall back to the first model any configured provider offers so
  // a fresh install is usable the moment a key is added.
  useEffect(() => {
    let ignore = false;

    const load = async () => {
      try {
        const response = await apiClient.providers.models.$get();
        if (!response.ok) return;

        const { models, activeModel } = await response.json();
        if (ignore) return;

        const isActiveModelAvailable = models.some((option) => option.ref === activeModel);
        const resolved = isActiveModelAvailable && activeModel
          ? activeModel
          : models[0]?.ref ?? "";

        setModelState(resolved);
      } catch {
        // Without a reachable provider list the prompt simply starts empty.
      } finally {
        if (!ignore) setProvidersLoaded(true);
      }
    };

    void load();
    return () => {
      ignore = true;
    };
  }, []);

  const setModel = useCallback((next: string) => {
    setModelState(next);

    void apiClient.providers["active-model"]
      .$put({ json: { model: next || null } })
      .catch(() => {
        // Losing the persisted choice is not worth interrupting the session.
      });
  }, []);

  const toggleThinking = useCallback(() => {
    setThinking((current) => !current);
  }, []);

  const toggleMode = useCallback(() => {
    setMode((m) => (m === Mode.BUILD ? Mode.PLAN : Mode.BUILD));
  }, []);

  const value: PromptConfigContextValue = {
    mode,
    toggleMode,
    setMode,
    model,
    setModel,
    modelLabel: model ? describeModelRef(model).modelId : "no model",
    hasModel: model.length > 0,
    providersLoaded,
    thinking,
    toggleThinking,
  };

  return (
    <PromptConfigContext.Provider value={value}>
      {children}
    </PromptConfigContext.Provider>
  );
}
