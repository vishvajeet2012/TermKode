import type { DialogContextValue } from "../../providers/dialog";
import type { ToastContextValue } from "../../providers/toast";
import type { SessionActions } from "../../providers/session-actions";
import type { ModeType } from "@termkode/shared";

export type CommandContext = {
  exit: () => void;
  toast: ToastContextValue;
  dialog: DialogContextValue;
  navigate: (path: string) => void;
  mode: ModeType;
  setMode: (mode: ModeType) => void;
  setModel: (model: string) => void;
  thinking: boolean;
  toggleThinking: () => void;
  /** Sends a prompt as if the user had typed it. */
  submitPrompt: (text: string) => void;
  /** Null on the home screen, where no conversation is open yet. */
  session: SessionActions | null;
};

export type Command = {
  name: string;
  description: string;
  value: string;
  /** Set for commands loaded from .termkode/commands, so args can be filled in. */
  prompt?: string;
  action?: (ctx: CommandContext) => void | Promise<void>;
};
