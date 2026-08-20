import { COMMIT_PROMPT, buildInitPrompt } from "@termkode/server";
import type { Command } from "./types";
import {
  AgentsDialogContent,
  ThemeDialogContent,
  SessionsDialogContent,
  ModelsDialogContent,
  McpDialogContent,
  NeoLensDialogContent,
  PermissionsDialogContent,
  ProvidersDialogContent,
  RewindDialogContent,
} from "../dialogs";
import { getCustomCommands, renderCustomCommand } from "../../lib/custom-commands";

const BUILT_IN_COMMANDS: Command[] = [
  {
    name: "new",
    description: "Start a new conversation",
    value: "/new",
    action: (ctx) => {
      ctx.navigate("/");
    }
  },
  {
    name: "agents",
    description: "Switch agents",
    value: "/agents",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Select Agent",
        children: <AgentsDialogContent currentMode={ctx.mode} onSelectMode={ctx.setMode} />,
      });
    },
  },
  {
    name: "providers",
    description: "Connect an AI provider and API key",
    value: "/providers",
    action: (ctx) => {
      ctx.dialog.open({
        title: "AI Providers",
        children: <ProvidersDialogContent />,
      });
    },
  },
  {
    name: "models",
    description: "Select AI model for generation",
    value: "/models",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Select Model",
        children: <ModelsDialogContent onSelectModel={ctx.setModel} />,
      });
    },
  },
  {
    name: "sessions",
    description: "Browse past sessions",
    value: "/sessions",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Sessions",
        children: <SessionsDialogContent />,
      });
    },
  },
  {
    name: "init",
    description: "Write an AGENTS.md describing this project",
    value: "/init",
    action: (ctx) => {
      ctx.submitPrompt(buildInitPrompt(process.cwd()));
    },
  },
  {
    name: "commit",
    description: "Stage and commit the current work",
    value: "/commit",
    action: (ctx) => {
      ctx.submitPrompt(COMMIT_PROMPT);
    },
  },
  {
    name: "compact",
    description: "Summarize the older turns to free up context",
    value: "/compact",
    action: async (ctx) => {
      if (!ctx.session) {
        ctx.toast.show({ message: "Open a conversation first" });
        return;
      }

      await ctx.session.compact();
    },
  },
  {
    name: "rewind",
    description: "Undo file changes back to a checkpoint",
    value: "/rewind",
    action: (ctx) => {
      if (!ctx.session) {
        ctx.toast.show({ message: "Open a conversation first" });
        return;
      }

      ctx.dialog.open({
        title: "Rewind",
        children: <RewindDialogContent sessionId={ctx.session.sessionId} />,
      });
    },
  },
  {
    name: "permissions",
    description: "Review what the agent is allowed to run",
    value: "/permissions",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Permissions",
        children: <PermissionsDialogContent />,
      });
    },
  },
  {
    name: "lens",
    description: "Explore local code and replay agent activity",
    value: "/lens",
    action: (ctx) => {
      ctx.dialog.open({
        title: "NeoLens",
        size: "fullscreen",
        children: <NeoLensDialogContent />,
      });
    },
  },
  {
    name: "mcp",
    description: "Inspect configured MCP servers and tools",
    value: "/mcp",
    action: (ctx) => {
      ctx.dialog.open({
        title: "MCP Control Center",
        children: <McpDialogContent />,
      });
    },
  },
  {
    name: "think",
    description: "Toggle extended thinking for the model",
    value: "/think",
    action: (ctx) => {
      ctx.toggleThinking();
      ctx.toast.show({
        message: ctx.thinking
          ? "Thinking off - faster replies and tool calls"
          : "Thinking on - slower, more deliberate replies",
      });
    },
  },
  {
    name: "theme",
    description: "Change color theme",
    value: "/theme",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Select Theme",
        children: <ThemeDialogContent />,
      });
    },
  },
  {
    name: "exit",
    description: "Quit the application",
    value: "/exit",
    action: (ctx) => {
      ctx.exit();
    },
  },
];

// Prompts the project or the user keeps in .termkode/commands appear alongside
// the built-in ones. They are read once at startup, so a new file needs a
// restart - which keeps the menu from touching the disk on every keystroke.
const CUSTOM_COMMANDS: Command[] = getCustomCommands().map((command) => ({
  name: command.name,
  description: command.description,
  value: `/${command.name}`,
  prompt: command.prompt,
  action: (ctx) => {
    ctx.submitPrompt(renderCustomCommand(command, ""));
  },
}));

const BUILT_IN_NAMES = new Set(BUILT_IN_COMMANDS.map((command) => command.name));

export const COMMANDS: Command[] = [
  ...BUILT_IN_COMMANDS,
  // A built-in command is never shadowed: /exit has to keep meaning /exit.
  ...CUSTOM_COMMANDS.filter((command) => !BUILT_IN_NAMES.has(command.name)),
];
