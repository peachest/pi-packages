# Roadmap

**源**: `idea.md` | `design.md`

## ✅ 已实现：四个命令

`/proxy`、`/proxy-unset`、`/proxy-config`、`/proxy-status` — spawnHook 透明注入，footer 实时状态，跨 session 持久化。

## ✅ 已实现：四个 agent 工具

`proxy_set`、`proxy_unset`、`proxy_status`、`proxy_noproxy` — agent 可直接调用工具配置代理和 no_proxy，修改后立即保存并生效，无需用户手动编辑 env 文件或重启 session。

工具与命令共享同一份模块状态（`proxyEnv`、`enabled`、`config`），工具修改后下一次 bash spawn 自动使用新的环境变量。
