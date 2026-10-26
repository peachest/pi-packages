# pi-proxy — 领域词汇表

## 核心概念

**Proxy Injection (代理注入)**:
在 bash 命令执行时自动向子进程环境变量中合并代理配置，对命令文本零污染，用户和 agent 无感知。
_避免使用_: proxy forwarding、env passthrough

**Proxy State (代理状态)**:
开关状态（enabled/disabled），跨 session 持久化到 `proxy-config.json`（仅存 `enabled` 布尔值）。pi 启动时自动恢复。
_避免使用_: proxy toggle、on/off flag

**Env File (代理环境文件)**:
`~/.config/proxy.env`（遵循 XDG 规范，可通过 `XDG_CONFIG_HOME` 覆盖）—— 按 `KEY=VALUE` 逐行存储的代理环境变量文件，是 shell（`twproxy`）、pi 主进程（`EnvHttpProxyAgent`）和 pi-proxy 扩展三方的唯一真实来源。用户可用任意编辑器直接修改。
_避免使用_: proxy config file、settings file

**Config File (配置文件)**:
`proxy-config.json` —— 内部状态文件，仅记录开关状态（`enabled` 布尔值）。用户不直接编辑，由扩展自动维护。
_避免使用_: state store、proxy settings

## 命令

**`/proxy-config`**:
打开外部编辑器编辑 `proxy.env`。编辑保存后自动关闭代理。
_避免使用_: proxy settings、edit proxy

**`/proxy`**:
从 `proxy.env` 读取环境变量并开启代理注入。
_避免使用_: proxy on、enable proxy

**`/proxy-unset`**:
关闭代理注入，清空所有注入的环境变量。
_避免使用_: proxy off、disable proxy

**`/proxy-status`**:
显示当前配置状态和 `proxy.env` 中所有变量的值。
_避免使用_: proxy info、show proxy

## 工具（agent 可调用）

**`proxy_set`**:
Agent 工具。设置代理 URL 和/或 no_proxy 主机，立即保存并启用注入。省略的参数保留原值，传空字符串清除。设置 `proxyUrl` 时同时写入 `http_proxy`/`https_proxy`/`HTTP_PROXY`/`HTTPS_PROXY`。
_避免使用_: proxy configure、set proxy env

**`proxy_unset`**:
Agent 工具。立即禁用代理注入，磁盘配置保留。
_避免使用_: proxy disable tool

**`proxy_status`**:
Agent 工具。返回当前代理状态和所有环境变量作为 tool result。
_避免使用_: proxy info tool

**`proxy_noproxy`**:
Agent 工具。管理 no_proxy 绕过列表：add/remove/set/clear。立即生效（如果代理已开启）。
_避免使用_: noproxy manager

## 关键机制

**spawnHook**:
pi SDK 的 bash tool 创建钩子，在子进程 spawn 之前回调，返回修改后的 spawn 参数（含合并后的 env）。用于 agent bash 的透明代理注入。
_避免使用_: bash wrapper、process hook

**User Bash Interception (用户命令拦截)**:
通过 `pi.on("user_bash")` 事件拦截用户 `!` 命令，替换 `exec` 操作为注入代理 env 的版本。用于 user_bash 的透明代理注入。
_避免使用_: command override、bash patch

**Footer Status (Footer 状态)**:
通过 `ctx.ui.setStatus()` 在 pi TUI footer 区域实时展示代理状态。开启时显示 `● Proxy (首地址)`，关闭时显示 `○ Proxy off`。
_避免使用_: status bar、banner

**Process Env Sync (进程环境同步)**:
pi-proxy 在修改代理配置后，将 `proxy.env` 的内容同步写入 `process.env`，使 pi 主进程的 undici `EnvHttpProxyAgent` 能读取到最新值。`NO_PROXY` 变更由 undici 自动检测；代理 URL 变更需触发 Dispatcher Rebuild 重建全局 dispatcher。
_避免使用_: env override、process injection

**Dispatcher Resolution (调度器解析)**:
定位 pi-coding-agent 内部模块 `dist/core/http-dispatcher.js` 的过程。pi-proxy 需调用其中的 `configureHttpDispatcher()` 来重建 undici 全局 dispatcher（见 Dispatcher Rebuild）。该包 `exports` 字段仅有 `import`（无 `require`），CJS `require.resolve` 失败；且解析受 pi 的 jiti loader 行为和 node 二进制位置影响，需多策略兜底（realpath(argv[1]) 向上查找为主，import.meta.resolve 和 execPath 启发式为辅）。
_避免使用_: module lookup、path discovery

**Dispatcher Rebuild (调度器重建)**:
当代理 URL 变更时调用 `configureHttpDispatcher()` 重建 pi 进程的 undici 全局 dispatcher，使新代理 URL 对后续 HTTP 请求生效。`NO_PROXY` 变更无需重建（undici 自动检测）。与 Process Env Sync 是两个独立关注点：后者同步 env 值，前者重建使用这些值的 dispatcher。
_避免使用_: dispatcher refresh、http agent reset
