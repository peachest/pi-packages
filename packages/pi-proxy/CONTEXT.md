# pi-proxy — 领域词汇表

## 核心概念

**Proxy Injection (代理注入)**:
在 bash 命令执行时自动向子进程环境变量中合并代理配置，对命令文本零污染，用户和 agent 无感知。
_避免使用_: proxy forwarding、env passthrough

**Proxy State (代理状态)**:
开关状态（enabled/disabled），跨 session 持久化到 `proxy-config.json`。pi 启动时自动恢复。
_避免使用_: proxy toggle、on/off flag

**Env File (代理环境文件)**:
`proxy.env` —— 按 `KEY=VALUE` 逐行存储的代理环境变量文件，用户可用任意编辑器直接修改。`/proxy` 命令开启时从此文件读取变量。
_避免使用_: proxy config file、settings file

**Config File (配置文件)**:
`proxy-config.json` —— 内部状态文件，记录开关状态和 envFile 路径引用。用户不直接编辑，由扩展自动维护。
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
