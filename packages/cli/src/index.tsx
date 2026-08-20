import { loadEnvironment } from "./lib/env";
import { applyRuntimeFlags, parseArgs, DEFAULT_MAX_STEPS } from "./lib/runtime-flags";

declare const TERMKODE_VERSION: string | undefined;
declare const TERMKODE_OPENTUI_LIBC: string | undefined;

const version = typeof TERMKODE_VERSION === "string" ? TERMKODE_VERSION : "dev";
const parsed = parseArgs(process.argv.slice(2));

const HELP = `TermKode ${version}

Usage:
  termkode [options]
  termkode -p "<prompt>" [options]

Options:
  -h, --help            Show this help message
  -v, --version         Show the installed TermKode version
  -p, --print <prompt>  Answer one prompt, print it, and exit. Reads piped
                        stdin as extra context, so it works in scripts and CI
  --json                With --print, emit a JSON result instead of plain text
  --mode <BUILD|PLAN>   Start in build or plan mode (default: BUILD)
  --plan, --build       Shorthand for --mode
  --yolo                Run every tool without asking for approval. Also
                        available as --dangerously-skip-permissions
  --max-steps <n>       Tool calls allowed per message before the agent stops
                        and asks (default: ${DEFAULT_MAX_STEPS})

TermKode runs entirely on this machine and calls AI providers with your own
API key. There is no account, no sign-in, and no usage billing.

Getting started:
  Run termkode, then use /providers to pick a provider (Claude, ChatGPT,
  DeepSeek, Qwen, Kimi, MiniMax, Grok, NVIDIA, Llama, Groq, OpenRouter,
  Mistral, Cerebras, Together, GLM, or a local AI server) and paste its API
  key. Switch models at any time with /models.

Approvals:
  Writes and shell commands are shown for approval before they run. Choosing
  "always allow" stores a rule in ~/.termkode/permissions.json, which /permissions
  lists and edits. Dangerous commands are always asked, whatever is stored.
  A checkpoint is taken before every file the agent writes; /rewind restores one.

Environment (all optional, keys can be added from /providers instead):
  ANTHROPIC_API_KEY  Claude models
  OPENAI_API_KEY     ChatGPT models
  DEEPSEEK_API_KEY   DeepSeek models
  QWEN_API_KEY       Qwen models
  KIMI_API_KEY       Kimi / Moonshot models
  MINIMAX_API_KEY    MiniMax models
  XAI_API_KEY        Grok models from xAI
  NVIDIA_API_KEY     Models hosted on NVIDIA NIM
  LLAMA_API_KEY      Llama models from Meta
  GROQ_API_KEY       Models on Groq
  OPENROUTER_API_KEY Models through OpenRouter
  MISTRAL_API_KEY    Mistral models
  CEREBRAS_API_KEY   Models on Cerebras
  TOGETHER_API_KEY   Models on Together AI
  ZAI_API_KEY        GLM models from Z.ai
  LOCAL_AI_BASE_URL  Local AI endpoint, when it is not on a default port
  TERMKODE_HOME       Directory for sessions and settings (default: ~/.termkode)
  API_URL            Use a separately running TermKode server instead of the
                     built-in one

Project files (all optional):
  AGENTS.md              Instructions loaded into every request for this project
  .termkode/mcp.json      MCP servers to expose as extra tools
  .termkode/hooks.json    Commands to run before and after tool calls
  .termkode/commands/*.md Extra slash commands

Keys and the selected model are stored in ~/.termkode/config.json. Environment
variables are also read from the shell, a .env file in the current project, or
~/.termkode/.env.`;

if (parsed.kind === "version") {
  console.log(`termkode ${version}`);
} else if (parsed.kind === "help") {
  console.log(HELP);
} else if (parsed.kind === "error") {
  console.error(`${parsed.message}\nRun 'termkode --help' for usage.`);
  process.exitCode = 1;
} else {
  // Provider keys must be available before the embedded API resolves a model.
  loadEnvironment();
  applyRuntimeFlags(parsed.options);

  if (parsed.options.prompt) {
    // Non-interactive: no renderer, no terminal UI, just the answer.
    const { runHeadless } = await import("./headless");
    process.exitCode = await runHeadless(parsed.options);
  } else {
    if (typeof TERMKODE_OPENTUI_LIBC === "string" && TERMKODE_OPENTUI_LIBC) {
      process.env.OPENTUI_LIBC = TERMKODE_OPENTUI_LIBC;
    }
    await import("./app");
  }
}
