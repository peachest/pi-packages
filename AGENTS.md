## 安装

安装本仓库下的包到 pi 时，必须用 `pi install ./packages/<name>`，禁止手动复制到 `~/.pi/agent/extensions/`（会绕过 settings 追踪产生漂移）。完整规范见 `docs/agents/install-packages.md`。

## Agent skills

### Issue tracker

Issues are tracked via GitHub Issues using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage labels follow the five canonical roles with default names. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context layout: a root `CONTEXT-MAP.md` points to per-package `CONTEXT.md` files. See `docs/agents/domain.md`.