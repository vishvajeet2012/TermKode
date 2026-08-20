import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { RGBA, TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useKeyboardLayer } from "../keyboard-layer";
import { useTheme } from "../theme";
import type { PermissionAnswer, PermissionPrompt } from "../../lib/tool-runner";

// This is the last thing standing between a model's guess and the user's disk.
// It has its own overlay rather than reusing the dialog provider so it cannot
// be dismissed by clicking outside it, cannot be replaced by another dialog,
// and never closes without an explicit answer.

export type PermissionContextValue = {
  requestPermission: (prompt: PermissionPrompt) => Promise<PermissionAnswer>;
  /** True while an approval is on screen, so other keybindings stand down. */
  isPending: boolean;
};

const PermissionContext = createContext<PermissionContextValue | null>(null);

export function usePermission(): PermissionContextValue {
  const value = useContext(PermissionContext);
  if (!value) {
    throw new Error("usePermission must be used within a PermissionProvider");
  }
  return value;
}

const LAYER_ID = "permission";
const MAX_PREVIEW_LINES = 12;

type PendingRequest = {
  prompt: PermissionPrompt;
  resolve: (answer: PermissionAnswer) => void;
};

type Choice = {
  answer: PermissionAnswer;
  label: string;
  hint: string;
};

function buildChoices(prompt: PermissionPrompt): Choice[] {
  const choices: Choice[] = [
    { answer: "allow-once", label: "Yes, run it once", hint: "y" },
  ];

  // A destructive call is never turned into a standing rule: the whole point of
  // flagging it is that it deserves a fresh answer every time.
  if (prompt.suggestedRule) {
    choices.push({
      answer: "allow-always",
      label: `Yes, and always allow ${prompt.suggestedRule}`,
      hint: "a",
    });
  }

  choices.push({ answer: "reject", label: "No, tell the agent to stop", hint: "n / esc" });

  if (prompt.suggestedRule) {
    choices.push({
      answer: "reject-always",
      label: `No, and never allow ${prompt.suggestedRule}`,
      hint: "d",
    });
  }

  return choices;
}

function previewLines(prompt: PermissionPrompt): string[] {
  const input = prompt.input;

  if (prompt.toolName === "writeFile" && input && typeof input === "object") {
    const content = (input as { content?: unknown }).content;
    if (typeof content === "string") {
      const lines = content.split("\n");
      return lines.length > MAX_PREVIEW_LINES
        ? [...lines.slice(0, MAX_PREVIEW_LINES), `… ${lines.length - MAX_PREVIEW_LINES} more lines`]
        : lines;
    }
  }

  if (prompt.toolName === "editFile" && input && typeof input === "object") {
    const record = input as { oldString?: unknown; newString?: unknown };
    const lines: string[] = [];

    if (typeof record.oldString === "string") {
      lines.push(...record.oldString.split("\n").slice(0, 6).map((line) => `- ${line}`));
    }
    if (typeof record.newString === "string") {
      lines.push(...record.newString.split("\n").slice(0, 6).map((line) => `+ ${line}`));
    }

    return lines;
  }

  return [];
}

export function PermissionProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const queue = useRef<PendingRequest[]>([]);
  const activeRef = useRef<PendingRequest | null>(null);
  const answerRef = useRef<(value: PermissionAnswer) => void>(() => {});
  const { push, pop } = useKeyboardLayer();

  const showNext = useCallback(() => {
    const next = queue.current.shift() ?? null;
    activeRef.current = next;
    setPending(next);

    if (next) {
      // A permission prompt owns every key while it is open; ctrl+c is the only
      // way past it, and it counts as a refusal.
      push(LAYER_ID, () => {
        answerRef.current("reject");
        return true;
      });
    } else {
      pop(LAYER_ID);
    }
  }, [push, pop]);

  const answer = useCallback(
    (value: PermissionAnswer) => {
      const current = activeRef.current;
      activeRef.current = null;
      current?.resolve(value);
      showNext();
    },
    [showNext],
  );

  answerRef.current = answer;

  const requestPermission = useCallback(
    (prompt: PermissionPrompt) => {
      return new Promise<PermissionAnswer>((resolve) => {
        // Parallel tool calls each need their own answer, so they queue rather
        // than overwriting one another.
        queue.current.push({ prompt, resolve });
        if (!activeRef.current) showNext();
      });
    },
    [showNext],
  );

  const value = useMemo(
    () => ({ requestPermission, isPending: pending !== null }),
    [requestPermission, pending],
  );

  return (
    <PermissionContext.Provider value={value}>
      {children}
      {pending ? <PermissionOverlay prompt={pending.prompt} onAnswer={answer} /> : null}
    </PermissionContext.Provider>
  );
}

type OverlayProps = {
  prompt: PermissionPrompt;
  onAnswer: (answer: PermissionAnswer) => void;
};

function PermissionOverlay({ prompt, onAnswer }: OverlayProps) {
  const dimensions = useTerminalDimensions();
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();
  const choices = useMemo(() => buildChoices(prompt), [prompt]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const preview = useMemo(() => previewLines(prompt), [prompt]);
  const dangerous = prompt.risk === "dangerous";

  useKeyboard((key) => {
    if (!isTopLayer(LAYER_ID)) return;

    if (key.name === "escape") {
      key.preventDefault();
      onAnswer("reject");
      return;
    }

    if (key.name === "up") {
      key.preventDefault();
      setSelectedIndex((index) => Math.max(0, index - 1));
      return;
    }

    if (key.name === "down") {
      key.preventDefault();
      setSelectedIndex((index) => Math.min(choices.length - 1, index + 1));
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      key.preventDefault();
      onAnswer(choices[selectedIndex]?.answer ?? "reject");
      return;
    }

    // Single-key answers, so approving a run of edits does not become a chore.
    if (key.name === "y") {
      key.preventDefault();
      onAnswer("allow-once");
      return;
    }

    if (key.name === "n") {
      key.preventDefault();
      onAnswer("reject");
      return;
    }

    if (key.name === "a" && prompt.suggestedRule) {
      key.preventDefault();
      onAnswer("allow-always");
      return;
    }

    if (key.name === "d" && prompt.suggestedRule) {
      key.preventDefault();
      onAnswer("reject-always");
    }
  });

  const width = Math.min(76, Math.max(30, dimensions.width - 4));

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={dimensions.width}
      height={dimensions.height}
      justifyContent="center"
      alignItems="center"
      backgroundColor={RGBA.fromInts(0, 0, 0, 170)}
      zIndex={200}
    >
      <box
        width={width}
        backgroundColor={colors.dialogSurface}
        border={["left"]}
        borderColor={dangerous ? colors.error : colors.primary}
        paddingX={3}
        paddingY={1}
        flexDirection="column"
        gap={1}
      >
        <text attributes={TextAttributes.BOLD} fg={dangerous ? colors.error : colors.primary}>
          {dangerous ? "Dangerous command" : "Permission needed"}
        </text>

        <box flexDirection="column">
          <text attributes={TextAttributes.DIM}>{prompt.toolName}</text>
          <text>{prompt.description}</text>
        </box>

        {prompt.reason ? (
          <text fg={colors.error}>This {prompt.reason}. Read it carefully.</text>
        ) : null}

        {preview.length > 0 ? (
          <box flexDirection="column">
            {preview.map((line, index) => (
              <text
                key={`preview-${index}`}
                attributes={TextAttributes.DIM}
                fg={line.startsWith("+") ? colors.success : line.startsWith("-") ? colors.error : undefined}
              >
                {line.slice(0, width - 8)}
              </text>
            ))}
          </box>
        ) : null}

        <box flexDirection="column">
          {choices.map((choice, index) => {
            const isSelected = index === selectedIndex;
            return (
              <box
                key={choice.answer}
                flexDirection="row"
                justifyContent="space-between"
                paddingX={1}
                backgroundColor={isSelected ? colors.selection : undefined}
                onMouseMove={() => setSelectedIndex(index)}
                onMouseDown={() => onAnswer(choice.answer)}
              >
                <text selectable={false} fg={isSelected ? "black" : "white"}>
                  {choice.label}
                </text>
                <text selectable={false} fg={isSelected ? "black" : "gray"}>
                  {choice.hint}
                </text>
              </box>
            );
          })}
        </box>

        <text attributes={TextAttributes.DIM}>
          Nothing runs until you answer. Rules are stored in ~/.termkode/permissions.json.
        </text>
      </box>
    </box>
  );
}
