# OpenClaw/Codex Runner Deployment

This guide describes a DisCode deployment where the Discord bot runs on a central host and a runner exposes a Codex workspace on another machine.

## Topology

- Central host: runs `discord-bot`.
- Workspace host: runs `runner-agent`.
- Runner CLI type: `codex`.
- Runner workspace: the local OpenClaw workspace path on the workspace host.

Keep real hostnames, private addresses, Discord tokens, and runner tokens out of committed files. Use the templates under `deploy/` as starting points.

## Bot Host

1. Install Bun and clone or deploy this repository to `/opt/discode`.
2. Copy `deploy/env/discode-bot.env.example` to `/etc/discode/discode-bot.env`.
3. Fill in `DISCODE_DISCORD_TOKEN` and `DISCODE_DISCORD_CLIENT_ID`.
4. Copy `deploy/systemd/discode-bot.service` to `/etc/systemd/system/discode-bot.service`.
5. Enable and start the service.
6. In Discord, run `/generate-token` and save the generated runner token for the runner host.

## Runner Host

1. Install Bun, tmux, and Codex CLI.
2. Clone or deploy this repository to `/opt/discode`.
3. Copy `runner-agent/config.openclaw-codex.example.json` to `/etc/discode/runner.config.json`.
4. Set `defaultWorkspace`, `assistant.folder`, and `cliSearchPaths` for the host.
5. Copy `deploy/env/discode-runner.env.example` to `/etc/discode/discode-runner.env`.
6. Fill in `DISCODE_TOKEN`, `DISCODE_BOT_URL`, and workspace/Codex paths.
7. Copy `deploy/systemd/discode-runner.service` to `/etc/systemd/system/discode-runner.service`.
8. Enable and start the service.

## Smoke Test

1. Confirm the runner appears in `/list-runners`.
2. Create a Codex SDK session with `/create-session`.
3. Choose the runner and use the default workspace.
4. Send a read-only prompt such as `Run pwd and git status, then stop.`
5. Verify the reported working directory is the configured OpenClaw workspace.
