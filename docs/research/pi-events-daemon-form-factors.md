---
source: wayfinder ticket peachest/pi-packages#21（T5 调研：pi extension 常驻进程先例 + XDG 路径规范）
delegate: glm53-flash-internal, run da51b0a23651405d260c53280e363f58e, answer sha256 c7c736352ec5803dbb31296df2c727e203368801d532989c2969ab9669241b09
date: 2026-09-17
---

# 研究报告 — Wayfinder 工单 #21 (map #16, pi-events-daemon)
范围：pi-mypackage 中的 (1) 在现有 pi 扩展中长期运行/后台进程的先例；(2) XDG 基准目录映射。

---

## 问题 1 — 现有 pi 扩展中的长期运行进程先例

### 调查发现的模式（三种，仅一种包含外部进程）

**模式 A — 进程内延迟工作（大多数扩展）。** 没有子进程；工作在 session hook 内部进行。只有在 session 运行时才存活。

- **pi-wishlist** (`packages/pi-wishlist/src/main.ts:21-77`): `session_start` hook 将每日更新检查延迟至 `setTimeout(..., 500)`；通过 `ctx.ui.notify` 通知 (`main.ts:66-71`)。状态：`~/.pi/agent/data/wishlist/` (`src/data/wishlist.ts:12-17`)。通过检查日期标记实现幂等去重 (`src/data/checker.ts`)；通过 `renameSync` 原子写入 (`wishlist.ts`)。无锁 — 并发 session 会重复运行检查；这之所以无害，是因为标记幂等。

- **pi-proxy** (`packages/pi-proxy/proxy.ts`): 完全没有进程工作 — 但拥有**最清晰的后台进程钩子**：`spawnHook: ({command, cwd, env}) => ...` (`proxy.ts:297`) 将 env 注入到 pi 启动的每个子进程中，这是使 daemon 变量（如 `PI_EVENTS_SOCK`）对所有工具子进程可见的方式。配置：`~/.pi/agent/proxy-config.json` (`proxy.ts:114-115`) 以及 env 文件中**仓库内首次 XDG 的使用**：`$XDG_CONFIG_HOME || ~/.config` + `proxy.env` (`proxy.ts:91-94`)。

- **oh-my-pet** (`packages/oh-my-pet/src/utils.ts:28-50`): JSONL binlog 状态位于 `~/.pi/agent/pets/<encoded-project>/binlogs/`，env 覆盖 `PI_PETS_DIR`，一次性从旧的项目本地 `.pet/binlogs/` 迁移 — 包含重命名旧路径的迁移路径状态。

- **pi-insight** (`packages/pi-insight/src/dirs.ts:11-37`): 数据位于 `~/.pi/agent/extensions/pi-insight/{meta,facets,reports}`；读取 pi 自身的 `~/.pi/agent/sessions/` 和 `~/.pi/agent/run-history.jsonl`。按需 CLI，无进程。

- **pi-poll** (`packages/pi-poll/index.ts`): 阻塞式会话内工具，无文件，无状态 (`grep` 确认无 `fs` 写入) — 这是判断器契约来源，而非进程模型来源。

**模式 B — 进程内长驻循环 + SQLite。** 长驻循环，但随 session 生死。

- **pi-session-search** (`~/.pi/agent/npm/node_modules/pi-session-search/`): 启动时索引，通过 **`node:sqlite`** (Node 24+；README.md:38) 每 5 分钟自动重新同步一次 — 在 `~/.pi/session-search/index/sessions-fts.db` + `hybrid-fts.db` 使用 SQLite FTS5 **且零原生依赖**，配置在 `~/.pi/session-search/config.json`，通过 `{project}/.pi/settings.json` `localPath` 实现每项目迁移 (README.md:52-56, 168-209)。多级路径解析：项目设置 → 全局默认 (`README.md:205-209`)。

- **pi-autoresearch** (`~/.pi/agent/npm/node_modules/pi-autoresearch/extensions/pi-autoresearch/index.ts:1772-1900`): 使用 `detached: true` 生成实验子进程，轮询计时器，`killTree` 清理，超时时向组发送 SIGTERM (`index.ts:1867-1880`)。完全在 session 内部；状态位于 `~/.pi/agent/` 下 (README.md:72: 或使用 `PI_CODING_AGENT_DIR`)。

**模式 C — 外部 daemon + IPC（仅两个真实先例）。**

- **pi-background-tasks** (`~/.pi/agent/npm/node_modules/pi-background-tasks/`): 生成 detached 进程组 (`src/core/registry.ts:896`)，运行时文件位于 `{cwd}/.pi/tasks/<session-id>-<pid>/` (`registry.ts:784-785`)，在 `session_shutdown` 时显式杀掉 (`src/extension.ts:486-510`)，且**明确拒绝跨重启重连** ("live child processes … are killed on session shutdown/reload", `src/extension.ts:58-59`)。持久化文件系统具有写入前临时+重命名和故障统计功能 (`src/core/durable-fs.ts:241-290`)。IPC 是仅限会话的进程内 EventBus (`README.md:315-319`, `pi-background-tasks:request:v1`)。无单例防护 — 任务设计上就是按会话划分的。持久化的 `notified` 标志 (`src/core/common.ts:55`)，且无验证。

- **nemo-relay** (`~/.pi/agent/extensions/nemo-relay/` + `~/.config/nemo-relay/`): 生态系统中唯一的**独立外部 daemon** (`nemo-relay --bind`, `src/provider-redirect.ts:83`)。pi 扩展通过 HTTP 网关客户端与其通信 (`src/gateway-client.ts`)，具有可配置的故障关闭语义 (`index.ts:55`)。状态/config 位于 `~/.config/nemo-relay/`: `config.toml`，bootstrap 锁 `gateway-127.0.0.1-<port>.lock` (**端口绑定作为单例防护** — 空锁文件，每个 host:port 一个)，daemon pin 锁位于 `daemon/pins/*.lock`。通过手动 daemon 启动，而非自动启动。

- **Herdr socket 客户端** (`~/.pi/agent/extensions/herdr-agent-state.ts:11-43`, `packages/pi-herdr-tab-rename/index.ts:27-56`): 外部 daemon 的 **IPC 约定** — `net.createConnection` 到 **env 发现的路径** (`HERDR_SOCKET_PATH`) 上的 unix socket，换行符分隔的 JSON-RPC `{id, method, params}\n`，尽力而为的单次写入，在响应或超时时调用 `socket.destroy()`。

### 对比表

| 扩展 | 后台机制 | 存活超过 session? | 单实例 | IPC | 路径 | 关闭时清理 |
|---|---|---|---|---|---|---|
| pi-wishlist | 进程内 `session_start` 延迟 `setTimeout` | 否 | 无 (幂等标记) | 无 | `~/.pi/agent/data/wishlist/` | 无需 |
| pi-proxy | 无 (env 拦截 `spawnHook`) | 否 | 不适用 | 无 | `~/.pi/agent/proxy-config.json`; `~/.config/proxy.env` | 无需 |
| oh-my-pet | 无; JSONL binlog 追加 | 是 (文件) | 无 | 无 | `~/.pi/agent/pets/` (env `PI_PETS_DIR`) | 无需 |
| pi-insight | 无 (按需 CLI) | 否 | 无 | 无 | `~/.pi/agent/extensions/pi-insight/` | 无需 |
| pi-poll | 阻塞式会话内轮询 | 否 | 不适用 | 无 | 无 | 无需 |
| pi-session-search | 进程内 5 分钟重新同步循环 | 否 (session 存活) | 每个 session 一个索引器; SQLite 序列化 | 无 | `~/.pi/session-search/{config.json,index/}` | 循环随 session 结束 |
| pi-autoresearch | detached 子进程生成 (`index.ts:1772`) | 否 | 无 | 进程内 | `~/.pi/agent/…` (env `PI_CODING_AGENT_DIR`) | 杀掉子进程树 |
| pi-background-tasks | detached 进程组 (`registry.ts:896`) | 否 — 在 `session_shutdown` 时被杀 (`extension.ts:486`) | 不适用 (按 session) | 进程内 EventBus | `{cwd}/.pi/tasks/<session-id>-<pid>/` | 在 shutdown 时停止所有任务 (`extension.ts:501`) |
| pi-markdown-preview | 生成 puppeteer 子进程 | 否 | 不适用 | 无 | `~/.pi/cache/markdown-preview/` (`index.ts:35`) | 子进程生命周期 |
| nemo-relay | **独立 daemon** (手动 `--bind`) | **是** | **端口绑定锁** (`gateway-<host-port>.lock`) | 对 gateway 的 HTTP | `~/.config/nemo-relay/{config.toml,bootstrap/,daemon/}` | daemon 与 session 无关 |
| herdr-agent-state / pi-herdr-tab-rename | socket 客户端 | daemon 是，客户端否 | daemon 端 | **unix socket + JSON-RPC, env 发现的路径** | `HERDR_SOCKET_PATH` | 一次性 socket.destroy() |

### pi-events-daemon 的设计启示

- **不要期望任何扩展能提供延迟生成先例** — nemo-relay 需要手动启动；pi-background-tasks 在关闭时杀掉进程并明确拒绝重连 (`extension.ts:58-59`)。扩展管理的延迟生成 (pidfile + flock, 首次 `subscribe`/`query` 自动启动) 是全新的 — 依靠 T1 的“store.db 是事实来源，重启即恢复”原则，使惰性生成安全。
- 单实例防护：nemo-relay 的文件锁是可行的先例 — 但在 **`XDG_RUNTIME_DIR` 中使用 flock，不要使用端口绑定** (端口使路径不可预测，且远程检查更困难)。
- IPC：复制 herdr JSON-RPC-over-unix-socket 约定 (换行符分隔, `{id, method, params}`)，并添加 nemo-relay 所缺少的功能 — 明确的“验证 ack”（类似 herdr 客户端的响应等待，而非 fire-and-forget）。
- 使用 `pi-proxy` 的 `spawnHook` (`proxy.ts:297`) 将 daemon socket 路径 + 认证 token 注入到每个工具子进程的 env (`PI_EVENTS_SOCK`) 中 — 计划中已验证此模式。
- 持久化文件系统：以 `pi-background-tasks/src/core/durable-fs.ts` 的临时+重命名模型作为写入前持久化的参考；其未经验证的 `notified` 标志 (`common.ts:55`) 正是需要避免的 bug。
- SQLite：使用 `node:sqlite` (pi-session-search 先例，Node 24+ FTS5) — 避免使用 better-sqlite3 (context-mode 需要绑定自愈机制，参考 `context-mode/scripts/postinstall.mjs`)。
- 状态迁移：oh-my-pet 的带有重命名的旧路径 → 新路径迁移 (`utils.ts:37-50`) 是从 `~/.pi/agent/data/*` 前向迁移的模板。

---

## 问题 2 — pi-mypackage 的 XDG 基准目录映射

### 今天 pi 及其生态系统实际使用的内容

- pi 的配置根目录为 `~/.pi/agent` (可被 `PI_CODING_AGENT_DIR` 覆盖 — `pi docs environment-variables.md:81`)；sessions 位于 `~/.pi/agent/sessions/`；pi 自身的 SQLite 位于 `~/.pi/agent/observability.db` (+`-wal/-shm`)。**pi 本身不在 `~/.config` 中** — 这是与 XDG 的基准约定偏差。
- 观察到的扩展路径：`~/.pi/agent/data/wishlist/`，`~/.pi/agent/pets/`，`~/.pi/agent/extensions/pi-insight/` (数据), `~/.pi/session-search/`，**`~/.pi/cache/markdown-preview/`** (私有 `~/.pi/cache`，而非 `~/.cache`)，每项目的运行时位于 `{project}/.pi/tasks/`。
- 部分 XDG 采用已存在：`~/.config/proxy.env` (`pi-proxy`)，完整的 `~/.config/nemo-relay/` (带有锁 + pin 的 daemon 配置)，以及 `~/.config/worktrunk/config.toml`。因此生态系统已经双轨制：`~/.pi` (pi 核心 + 扩展数据) 对比 `~/.config` (XDG 感知工具)。

### pi-events-daemon 工件的 XDG 分类

| 工件 | XDG 变量 | 默认路径 | 理由 |
|---|---|---|---|
| `store.db` (subscriptions/events/deliveries) | `XDG_DATA_HOME` | `~/.local/share/pi-events/store.db` | 不可替代 — 重启后必须存续；NOT state 或 cache |
| `daemon.sock`, `daemon.lock` (flock) | `XDG_RUNTIME_DIR` | `/run/user/<uid>/pi-events/` | tmpfs，重启清除 — **正确**：socket/锁应是易失的；根据 T1，store.db 持有事实，因此锁/socket 的丢失是自动恢复的 |
| `logs/daemon.log` | `XDG_STATE_HOME` | `~/.local/state/pi-events/logs/` | 重启后存续 (调试) 但可修剪；非 cache (cache 会在任何时刻被清除) |
| 未来 `config.toml` | `XDG_CONFIG_HOME` | `~/.config/pi-events/config.toml` | 手动编辑的配置 |

**注意事项：**
- `XDG_RUNTIME_DIR` 为空/未设置 → 回退到 **`/tmp/pi-events-<uid>/`** (0700) — 永远不要回退到 home，因为这里的 home 是 NFS 风格的挂载 (`/mnt/disk1/hyx`)：**unix sockets 和 flock 在 NFS 上不可靠**，且规范本身要求 runtime 目录位于本地文件系统。/tmp 位于本地磁盘。
- 多用户：以 uid 为后缀或依赖 `<uid>/$XDG_RUNTIME_DIR`；将 runtime 目录 chmod 0700，防止会话间互窥。
- 不要将 store.db 放在 `~/.pi/tasks/` 下 — 那是按 cwd 划分的 (每个项目克隆一个)，这会破坏跨项目单例要求。

### pi-mypackage 的具体路径布局规范 (建议作为 `docs/agents/paths.md`)

```
config   ${XDG_CONFIG_HOME:-~/.config}/pi-<pkg>/          # 手动编辑，例如 pi-events/config.toml
data     ${XDG_DATA_HOME:-~/.local/share}/pi-<pkg>/       # 必须存续，例如 pi-events/store.db
state    ${XDG_STATE_HOME:-~/.local/state}/pi-<pkg>/      # 日志，历史记录，例如 pi-events/logs/
cache    ${XDG_CACHE_HOME:-~/.cache}/pi-<pkg>/            # 可丢弃，例如已渲染的制品
runtime  ${XDG_RUNTIME_DIR:-/tmp/pi-events-$UID}/pi-<pkg>/  # sockets, locks, 0700
```

环境变量覆盖（检查顺序，与 pi 自身的 `PI_CODING_AGENT_DIR` 一致）：
1. 包级别：`PI_EVENTS_CONFIG_DIR` / `PI_EVENTS_DATA_DIR` / `PI_EVENTS_RUNTIME_DIR` (运行时测试/重定位需要 — oh-my-pet 的 `PI_PETS_DIR` 先例)
2. 全局级别：`PI_DATA_HOME`, `PI_RUNTIME_DIR` (如果没有设置，则通过 `XDG_RUNTIME_DIR` 尊重 `PI_CODING_AGENT_DIR` 作为 base-root 覆盖)
3. XDG 默认值 → `/tmp/pi-<pkg>-<uid>` 回退 (仅限运行时)

迁移规则：一个包的遗留路径 (`~/.pi/agent/data/<pkg>/`, `~/.pi/<pkg>/`) 在首次启动时被读取并重命名到新位置 (oh-my-pet 模式，`packages/oh-my-pet/src/utils.ts:37-50`)；按项目的运行时工件保持在 `{project}/.pi/` 下 (pi-background-tasks 先例) — 仅将跨项目/全局工件进行 XDG 归位。

### pi-events-daemon 的设计启示

- 具体解决方案：`~/.local/share/pi-events/store.db`，`/run/user/<uid>/pi-events/{daemon.sock,daemon.lock}` (回退 `/tmp/pi-events-<uid>/`)，`~/.local/state/pi-events/logs/daemon.log`，`~/.config/pi-events/config.toml` — 每个 T1 可靠性铁律依然成立：daemon.sock 在重启时消失，但 store.db（写入前持久化 + 确认验证 + 重新投递）是事实，因此 daemon 重启和 socket 丢失是无害的。
- 此规范也修复了基准约定偏差，而不是复制它：新的 pi-mypackage 包目标是 XDG，`~/.pi` 仅作为遗留读取/迁移源 — 不要将 `store.db` 添加到已经分叉的 `~/.pi/agent/` 集合中。
- daemon 代码必须将 socket 路径视为 session 之间传递的 env (`PI_EVENTS_SOCK`)，并通过 `pi-proxy` 的 `spawnHook` 注入 — 这与 Q1 中的 herdr env 发现约定一致。
