# Birdhouse

I wanted a free messaging app to message cli agents. Codex helped me build this.

## Monorepo

This repo is a Bun + Turborepo monorepo with three runnable products:

- `apps/mobile`: Expo iOS/Android app with native-like messaging UI.
- `apps/cli`: Command line client (interactive + scripted).
- `services/agent-server`: Hono server with provider adapters.

Shared packages:

- `packages/protocol`: shared schemas and TypeScript types.
- `packages/client`: shared HTTP/SSE transport and auth helpers.
- `packages/provider-sdk`: provider adapter interfaces and implementations (`ai-sdk`, `openclaw`, `pi-mono`, and CLI wrappers).

## Features

- Contact-per-agent model (each agent is a contact).
- Provider discovery per endpoint (`/v1/providers/default`) with automatic `terminal-cli` fallback.
- Per-contact endpoint URL + auth (`none`, `bearer`, `basic`).
- Streaming chat over HTTP + SSE.
- Attachments in mobile and CLI workflows.
- Async follow-up notifications through Expo Push.
- Local-only history persistence on mobile and CLI.

## Quickstart

1. Install dependencies:

```bash
bun install
```

2. Configure env:

```bash
# edit .env with your keys/settings
```

3. Start all packages in dev mode:

```bash
bun run dev
```

Or run each package independently:

```bash
bun run --filter @birdhouse/agent-server dev
bun run --filter @birdhouse/cli start
bun run --filter @birdhouse/mobile dev
```

Run workspace build + checks:

```bash
bun run typecheck
bun run test
bun run build
```

Export production mobile bundles:

```bash
bun run --filter @birdhouse/mobile export
```

## Build iOS For TestFlight

From the mobile app directory:

```bash
cd /Users/vochsel/repos/birdhouse/apps/mobile
```

1. Login to Expo/EAS:

```bash
npx eas login
```

2. Build the production iOS binary for TestFlight:

```bash
bun run testflight:build
# equivalent: npx eas build --platform ios --profile production
```

3. Submit the latest build to App Store Connect / TestFlight:

```bash
bun run testflight:submit
# equivalent: npx eas submit --platform ios --profile production
```

Notes:

- EAS build profiles are in `apps/mobile/eas.json`.
- `production` profile auto-increments iOS build number.
- If `eas` is not installed globally, use `npx eas ...` commands directly.
- You must have an Apple Developer account and access to the app's bundle id (`com.birdhouse.app`).

## Run Server + CLI + Expo

Use separate terminals.

1. Terminal 1: start the Birdhouse agent server

```bash
cd /Users/vochsel/repos/birdhouse
bun run --filter @birdhouse/agent-server dev
```

Set an explicit port from CLI:

```bash
./birdhouse-server --port 8787
```

Or run a wrapped-command server (one command per server, auto port):

```bash
cd /Users/vochsel/repos/birdhouse
./birdhouse-server -- claude
```

Wrapped mode with explicit port:

```bash
./birdhouse-server --port 53124 -- claude
```

See CLI help:

```bash
./birdhouse-server --help
```

This prints the chosen URL, for example:

```txt
birdhouse agent server running on http://localhost:53124
```

Start another wrapped command on a different port:

```bash
./birdhouse-server -- openclaw --no-color agent
./birdhouse-server -- nanoclaw
./birdhouse-server -- codex
```

2. Terminal 2: use the CLI client

```bash
cd /Users/vochsel/repos/birdhouse

# add a contact that points to the Birdhouse server
bun --cwd apps/cli src/index.ts contact add \
  --name "Local AI" \
  --endpoint http://localhost:8787

# interactive chat
bun --cwd apps/cli src/index.ts chat --contact "Local AI"
```

For wrapped-command servers, set `--endpoint` to that server's printed port.

3. Terminal 3: start Expo mobile app

```bash
cd /Users/vochsel/repos/birdhouse
bun run --filter @birdhouse/mobile dev
```

If you use Expo Go on a phone, set the contact endpoint in the app to your Mac LAN IP:

```txt
http://<your-mac-lan-ip>:8787
```

If you use iOS simulator, `http://localhost:8787` works.
If you use Android emulator, use `http://10.0.2.2:8787`.

## Agent Server API

The server exposes:

- `GET /v1/health`
- `GET /v1/providers/capabilities`
- `GET /v1/providers/default`
- `POST /v1/chat.stream`
- `POST /v1/push/register`
- `POST /v1/async/trigger`
- `POST /v1/async/schedule`

The API contract is defined in `@birdhouse/protocol`.

## CLI Usage

Add a contact:

```bash
bun run --filter @birdhouse/cli start -- contact add --name "OpenClaw Bot" --endpoint http://localhost:8787
```

`contact add` auto-discovers provider via endpoint (`/v1/providers/default`).  
If discovery is unavailable, it falls back to `terminal-cli`.  
On the server, `/v1/providers/default` prefers `terminal-cli` when `OPENAI_API_KEY` is not set.
Use `--provider` only to override discovery.

Interactive chat:

```bash
bun run --filter @birdhouse/cli start -- chat --contact "OpenClaw Bot"
```

Trigger async message:

```bash
bun run --filter @birdhouse/cli start -- trigger --contact "OpenClaw Bot" --text "Follow up in a minute"
```

## CLI-Wrapped Providers (Terminal/Claude/OpenClaw/NanoClaw)

These providers execute local CLI binaries on the agent-server machine. No upstream project changes are required.

- `claude-code-cli`: defaults to `claude -p "{prompt}"`.
- `openclaw-cli`: defaults to `openclaw --no-color agent --message "{prompt}"`.
- `nanoclaw-cli`: when manually selected, expects `provider.extra.command` (no stable one-shot default).
- `terminal-cli`: generic CLI adapter (fallback) with default command `codex` and args `["exec","{prompt}"]`.
  This avoids Codex interactive TTY mode errors (for example: `stdin is not a terminal`).

Examples:

```bash
# Claude Code wrapped endpoint
bun run --filter @birdhouse/cli start -- contact add \
  --name "Claude Code" \
  --endpoint http://localhost:53124

# OpenClaw wrapped endpoint
bun run --filter @birdhouse/cli start -- contact add \
  --name "OpenClaw CLI" \
  --endpoint http://localhost:53125

# Optional explicit override (advanced)
bun run --filter @birdhouse/cli start -- contact add \
  --name "Forced Provider" \
  --provider ai-sdk \
  --endpoint http://localhost:8787 \
  --extra '{"path":"/chat"}'
```

Supported `provider.extra` keys for CLI wrappers (`terminal-cli`, `claude-code-cli`, `openclaw-cli`, `nanoclaw-cli`):

- `command`: binary to execute.
- `args`: string array; supports `{prompt}` placeholder.
- `stdin`: boolean; when `true`, prompt is written to stdin.
- `parse`: `text` or `json`.
- `timeoutMs`: command timeout (default `180000`).
- `cwd`: working directory for command execution.
- `env`: additional environment variables object.

## Remote OpenClaw / pi-mono

For remote provider targets, point contacts at a Birdhouse-compatible endpoint. Provider kind is discovered from the endpoint by default. Use `--provider` only if you need a manual override. `provider.extra` supports provider-specific fields such as custom route `path`.

## Environment

Use `.env` for required variables.

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `PORT`
- `BIRDHOUSE_DEFAULT_PROVIDER` (optional default provider for `/v1/providers/default`)
- `BIRDHOUSE_TERMINAL_CLI_COMMAND` (optional command for `terminal-cli`; default `codex`)
- `BIRDHOUSE_TERMINAL_CLI_ARGS` (optional JSON array args for `terminal-cli`; default `["exec","{prompt}"]`)
- `BIRDHOUSE_CLAUDE_CODE_COMMAND`
- `BIRDHOUSE_OPENCLAW_COMMAND`
- `BIRDHOUSE_NANOCLAW_COMMAND`
- `BIRDHOUSE_SERVER_TIMEOUT_MS` (optional wrapped command timeout; default `180000`)
- `BIRDHOUSE_SERVER_PORT` (optional fixed port in wrapped mode; default auto-assigned free port)
- `BIRDHOUSE_SERVER_STDIN` (`1` to send prompt to stdin instead of argv)
- `BIRDHOUSE_SERVER_PARSE` (`json` to parse command output as JSON)

`--port` CLI flag overrides `PORT` and `BIRDHOUSE_SERVER_PORT`.
