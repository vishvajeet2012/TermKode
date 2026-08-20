# Contributing to TermKode

Thanks for wanting to improve TermKode. This project touches a terminal UI, the
API the CLI runs in-process, local session storage, release tooling, and a
landing page, so the best contributions are focused, verified, and easy to
review.

## Getting Started

Read the [development guide](./docs/DEVELOPMENT.md) for the complete
environment setup. TermKode needs no database and no service accounts; chat work
only needs your own provider API key. The shortest path for documentation,
shared-library, and landing-page work is:

1. Fork the repository and create a feature branch from `main`.
2. Install Bun 1.3.13, then install dependencies:

   ```sh
   bun install --frozen-lockfile
   ```

3. Run the part of the project you are changing:

   ```sh
   bun run dev:server
   bun run dev:cli
   bun run dev:web
   ```

4. Keep changes scoped to the issue or improvement you are working on.

## Project Structure

| Path | Area |
| --- | --- |
| `packages/cli` | Terminal UI, command menu, themes, session screens |
| `packages/server` | API routes, chat, local session storage, MCP runtime, NeoLens |
| `packages/shared` | Shared schemas and cross-package types |
| `packages/web` | Landing page |
| `scripts` | Release and distribution automation |

## Development Checks

Before opening a pull request, run the checks that match your change:

```sh
bun test
bun run build:web
bun run check
```

For CLI or release changes, also run the relevant release smoke checks against a
built release binary when possible:

```sh
version="$(bun -e 'console.log(require("./packages/cli/package.json").version)')"
bun run release:smoke -- ./path/to/termkode "$version"
```

If you cannot run a check locally, mention that in the pull request and explain
why.

## Pull Request Guidelines

- Use a clear title that describes the behavior change.
- Keep pull requests small enough to review in one pass.
- Include screenshots or terminal output for UI changes.
- Add or update tests when behavior changes.
- Avoid committing generated, temporary, local cache, or machine-specific files.
- Do not include secrets, tokens, API keys, or private credentials.

## Commit Style

Use short, action-oriented commit messages:

```text
fix: keep session writes atomic when the disk is full
feat: add neolens file activity summary
docs: expand install instructions
```

## Environment Variables

Local development may need environment variables depending on the package being
run. Copy `.env.example` to `.env`, fill only the values needed for your work,
and never commit the resulting file.

Common variables include:

| Variable | Used By |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude chat models |
| `OPENAI_API_KEY` | ChatGPT chat models |
| `DEEPSEEK_API_KEY` | DeepSeek chat models |
| `QWEN_API_KEY` | Qwen chat models |
| `KIMI_API_KEY` | Kimi / Moonshot chat models |
| `MINIMAX_API_KEY` | MiniMax chat models |
| `XAI_API_KEY` | Grok chat models |
| `NVIDIA_API_KEY` | NVIDIA NIM chat models |
| `LLAMA_API_KEY` | Meta Llama chat models |
| `GROQ_API_KEY` | Groq chat models |
| `OPENROUTER_API_KEY` | OpenRouter chat models |
| `MISTRAL_API_KEY` | Mistral chat models |
| `CEREBRAS_API_KEY` | Cerebras chat models |
| `TOGETHER_API_KEY` | Together AI chat models |
| `ZAI_API_KEY` | GLM chat models |
| `LOCAL_AI_BASE_URL` | Local AI endpoint on a non-default port |
| `TERMKODE_HOME` | Directory for sessions and settings |
| `API_URL` | Use a separately running TermKode API instead of the built-in one |

## MCP Contributions

MCP changes should preserve the default-deny security model. New MCP behavior
must keep tool access explicit and must not leak resolved secret values back to
the client.

## NeoLens Contributions

NeoLens should stay project-scoped and safe around filesystem boundaries. When
changing graphing or activity tracking, include tests for path normalization,
external imports, failed tool calls, and verification commands when relevant.

## Release Changes

Distribution changes can affect all supported platforms. For release scripts,
installer scripts, or Homebrew formula generation, review
[docs/RELEASING.md](./docs/RELEASING.md) and verify the platform matrix where
possible.

## Reporting Issues

When opening an issue, include:

- Operating system and architecture.
- Install method.
- TermKode version from `termkode --version`.
- The command or workflow that failed.
- Any relevant terminal output with secrets removed.

## License

By contributing, you agree that your contribution will be licensed under the
repository's MIT License.
