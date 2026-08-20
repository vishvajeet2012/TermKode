import { useEffect, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../providers/theme";
import { usePromptConfig } from "../providers/prompt-config";
import { shouldSkipPermissions } from "../lib/runtime-flags";
import { listBackgroundShells } from "../lib/background-shells";
import { Mode } from "@termkode/shared";

// A process the agent started keeps running whether or not anyone remembers it,
// so the prompt polls for one rather than waiting to be told.
const BACKGROUND_POLL_MS = 2_000;

function useRunningBackgroundCount() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const update = () =>
      setCount(listBackgroundShells().filter((shell) => shell.running).length);

    update();
    const timer = setInterval(update, BACKGROUND_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  return count;
}

export function StatusBar() {
  const { mode, modelLabel, thinking } = usePromptConfig();
  const { colors } = useTheme();
  // Running without approvals is the one state where a glance at the prompt
  // should tell you so.
  const yolo = shouldSkipPermissions();
  const running = useRunningBackgroundCount();

  return (
    <box flexDirection="row" gap={1}>
      <text fg={mode === Mode.PLAN ? colors.planMode : colors.primary}>
        {mode === Mode.PLAN ? "Plan" : "Build"}
      </text>
      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
        ›
      </text>
      <text>{modelLabel}</text>
      {thinking && (
        <>
          <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
            ›
          </text>
          <text attributes={TextAttributes.DIM}>think</text>
        </>
      )}
      {running > 0 && (
        <>
          <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
            ›
          </text>
          <text fg={colors.info}>
            {running} running
          </text>
        </>
      )}
      {yolo && (
        <>
          <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
            ›
          </text>
          <text fg={colors.error}>no approvals</text>
        </>
      )}
    </box>
  );
}
