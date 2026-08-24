> [中文文档](./docs/README.zh.md) · English

# pi-proxy

> Dynamically switch proxy environment variables in pi sessions without restart.

A pi extension that registers four slash commands **and four agent-callable tools** for transparent proxy management — no need to exit pi, no need to prepend environment variables to every bash command.

## Commands (for humans)

| Command | Description |
|---------|-------------|
| `/proxy` | Enable proxy injection — all subsequent bash commands automatically carry proxy env vars |
| `/proxy-unset` | Disable proxy injection |
| `/proxy-config` | Open an editor to edit the `.env` file (one `KEY=VALUE` per line) |
| `/proxy-status` | View current config and proxy variables |

## Tools (for the agent)

The agent can call these tools directly to configure proxy settings without asking the user to edit files or restart the session. Changes take effect immediately.

| Tool | Description |
|------|-------------|
| `proxy_set` | Set proxy URLs and/or no_proxy hosts, enable injection immediately. Omitted params preserve existing values; `""` clears. |
| `proxy_unset` | Disable proxy injection immediately (config preserved on disk). |
| `proxy_status` | Return current proxy status and all env vars as a tool result. |
| `proxy_noproxy` | Manage the no_proxy bypass list: add, remove, set, or clear hosts. |

### proxy_set parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `proxyUrl` | string? | HTTP/HTTPS proxy URL. Sets `http_proxy`, `https_proxy`, `HTTP_PROXY`, `HTTPS_PROXY`. |
| `allProxy` | string? | SOCKS/all-protocol proxy URL. Sets `all_proxy`, `ALL_PROXY`. |
| `noProxy` | string? | Comma-separated bypass hosts. Sets `no_proxy`, `NO_PROXY`. |
| `enable` | boolean? | Enable injection immediately (default: `true`). |

### proxy_noproxy parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `action` | `"add"` \| `"remove"` \| `"set"` \| `"clear"` | What to do with the no_proxy list. |
| `hosts` | string[]? | Host entries for add/remove/set (ignored for clear). |

## How it works

Proxy environment variables are injected at the spawn level — **the command text is never polluted**. Both agent bash and user bash (`!` commands) receive the injected environment transparently.

```
proxy.env (KEY=VALUE)
       │
       ▼
proxy.ts (extension)
       │
       ├──► spawnHook: agent bash → env merged silently
       ├──► user_bash: ! commands → env merged silently
       │
       └──► tools: proxy_set / proxy_unset / proxy_noproxy
             update proxy.env + module state → next bash spawn picks up new env
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
