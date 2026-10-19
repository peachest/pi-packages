Packages are deep modules: see [packages/README.md](./packages/README.md) before adding or importing one.

## pi-events-daemon（事件守护进程）

本仓库的 `packages/pi-events-daemon`（daemon 本体 + 9 op 协议）与 `packages/pi-events-daemon-extension`（pi session 客户端）已全量实现：实体状态机订阅/发布/wake 通知，替代手写轮询。**全局唯一 daemon/机器**（pidfile+flock 单实例，session 是客户端不是宿主），extension 首操作惰性拉起。使用方式（9 op、订阅形态、投递语义边界、已知遗留）：触发 skill `pi-events-daemon`（已装全局 agent）或直接读 `docs/wiki/pi-events-daemon/known-unresolved.md`。正典 spec：GitHub #31。

## 安装

安装本仓库下的包到 pi 时，必须用 `pi install ./packages/<name>`，禁止手动复制到 `~/.pi/agent/extensions/`（会绕过 settings 追踪产生漂移）。完整规范见 `docs/agents/install-packages.md`。

**安装 pi-proxy 前必须先建依赖软链**（验证于 2026-08-26，pi 0.84.3）：

```bash
mkdir -p node_modules
ln -sfn ../packages/pi-i18n-utils node_modules/pi-i18n-utils
```

pi 的 jiti loader 从扩展文件目录向上搜索 `node_modules/` 来解析裸模块 import，`~/.pi/agent/npm` 不在搜索链上。缺少此软链会导致 pi 启动时加载扩展报 `Cannot find module 'pi-i18n-utils'`，整个 session 无法启动。清掉仓库 `node_modules/` 后需重新执行。

## Agent skills

### Issue tracker

Issues are tracked via GitHub Issues using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage labels follow the five canonical roles with default names. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context layout: a root `CONTEXT-MAP.md` points to per-package `CONTEXT.md` files. See `docs/agents/domain.md`.