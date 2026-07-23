> [中文文档](./docs/README.zh.md) · English

# pi-proxy

> Dynamically switch proxy environment variables in pi sessions without restart.

A pi extension that registers four commands for transparent proxy management — no need to exit pi, no need to prepend environment variables to every bash command.

## Commands

| Command | Description |
|---------|-------------|
| `/proxy` | Enable proxy injection — all subsequent bash commands automatically carry proxy env vars |
| `/proxy-unset` | Disable proxy injection |
| `/proxy-config` | Open an editor to edit the `.env` file (one `KEY=VALUE` per line) |
| `/proxy-status` | View current config and proxy variables |

## How it works

Proxy environment variables are injected at the spawn level — **the command text is never polluted**. Both agent bash and user bash (`!` commands) receive the injected environment transparently.

```
. env file (KEY=VALUE)
       │
       ▼
proxy.ts (extension)
       │
       ├──► spawnHook: agent bash → env merged silently
       └──► user_bash: ! commands → env merged silently
```

## Persistence

State is stored in `~/.pi/agent/` and restored across pi restarts:

- `proxy-config.json` — enabled flag + env file path
- `proxy.env` — the environment variables (editable directly)

## Status bar

```
○ Proxy off    👈 disabled
● Proxy (http://127.0.0.1:7890)   👈 enabled
```

## Install

```bash
pi install /path/to/pi-proxy
```

Optional i18n support:

```bash
pi install npm:@juicesharp/rpiv-i18n
```

## Design

See [docs/design.md](./docs/design.md) for architecture, data model, boundary cases, and testing plan.
