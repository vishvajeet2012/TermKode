import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { Header } from "../components/header";
import { InputBar } from "../components/input-bar";
import { ProvidersDialogContent } from "../components/dialogs";
import { usePromptConfig } from "../providers/prompt-config";
import { useDialog } from "../providers/dialog";
import { TextAttributes } from "@opentui/core";

export function Home() {
  const navigate = useNavigate();
  const dialog = useDialog();
  const { mode, model, hasModel, providersLoaded, thinking } = usePromptConfig();
  const hasPromptedRef = useRef(false);

  // Nothing works until a provider is connected, so walk a first-time user
  // straight into the provider picker instead of failing on the first message.
  useEffect(() => {
    if (!providersLoaded || hasModel || hasPromptedRef.current) return;

    hasPromptedRef.current = true;
    dialog.open({
      title: "Connect an AI provider",
      children: <ProvidersDialogContent />,
    });
  }, [providersLoaded, hasModel, dialog]);

  const handleSubmit = useCallback(
    (text: string) => {
      if (!hasModel) {
        dialog.open({
          title: "Connect an AI provider",
          children: <ProvidersDialogContent />,
        });
        return;
      }

      navigate("/sessions/new", { state: { message: text, mode, model, thinking } });
    },
    [navigate, mode, model, thinking, hasModel, dialog],
  );

  return (
    <box
      alignItems="center"
      justifyContent="center"
      flexGrow={1}
      gap={2}
      position="relative"
      width="100%"
      height="100%"
    >
      <Header />
      <box width="100%" maxWidth={78} paddingX={2} flexDirection="column" gap={1}>
        <InputBar onSubmit={handleSubmit} />
        <box flexDirection="row" gap={1} flexShrink={0} marginLeft="auto">
          <text>tab</text>
          <text attributes={TextAttributes.DIM}>agents</text>
        </box>
        {providersLoaded && !hasModel && (
          <text attributes={TextAttributes.DIM}>
            No AI provider connected. Run /providers to pick one and add its API key.
          </text>
        )}
      </box>
    </box>
  );
}
