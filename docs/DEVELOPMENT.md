# Developing TermKode

This guide describes a reproducible local environment for contributing to the
TermKode monorepo. TermKode runs entirely on the contributor's machine: there is no
account system, no hosted API, and no database to provision.

## Prerequisites

- Git
- Bun 1.3.13
- An API key for at least one supported provider, or a local AI server, for
  chat work

The required Bun version is also pinned in the root `package.json`. Install the
workspace exactly as locked:

```sh
bun install --frozen-lockfile
cp .env.example .env
```

Only populate the variables needed for the area you are changing. Never commit
`.env` or any real credential.

## Provider keys

The landing page, shared package, and most NeoLens tests need no credentials.
Chat requires one connected provider. The normal path is `/providers` inside the
CLI, which verifies the key and writes it to `~/.termkode/config.json`. For CI or
scripted setups, use the environment variables listed in `.env.example`
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `QWEN_API_KEY`,
`KIMI_API_KEY`, `MINIMAX_API_KEY`).

Running Ollama or LM Studio locally is enough to develop against real models
without any key: TermKode detects the server and exposes its models.

Sessions are written as JSON files under `~/.termkode/sessions`. Set
`TERMKODE_HOME` to keep development sessions out of your personal directory:

```sh
TERMKODE_HOME=.termkode-dev bun run dev:cli
```

## Running packages

The CLI runs the API in its own process, so a single terminal is enough:

```sh
bun run dev:cli
```

The landing page runs separately:

```sh
bun run dev:web
```

When working on the API in isolation, run it as its own process on port 3000 and
point the CLI at it:

```sh
bun run dev:server
API_URL=http://localhost:3000 bun run dev:cli
```

The Vite development server normally listens on port 5173.

## Quality checks

Run the same core quality gate used by contributors and CI:

```sh
bun run check
```

Individual commands are available when iterating:

```sh
bun run lint
bun run typecheck
bun test
bun run build:web
```

After staging files, format only the intended contribution with:

```sh
bun run format
```

For release and installer changes, follow `docs/RELEASING.md` and run the
relevant platform smoke tests.
