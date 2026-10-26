# pi-herdr-tab-rename

将 pi 的 session 重命名同步到 Herdr tab。

## 解决什么问题

qol 的重命名命令（`/rename`、`/qol:rename`、`/qol:rename:full`、auto-rename）都落在
`pi.setSessionName(name)`，只改 pi 内部的 session 名。pi session 跑在 Herdr tab 里时，
tab 标签不会跟着变，需要手动再 rename 一次 tab。

## 工作原理

```
pi.setSessionName(name)                          （qol 触发）
  → pi 事件 session_info_changed {name}          （pi 核心 emit）
    → 本扩展：TUI 模式 + HERDR_ENV=1 时
      → herdr socket JSON-RPC tab.rename {tab_id, label}
```

- 复用 herdr 注入的 `HERDR_SOCKET_PATH` / `HERDR_TAB_ID` 环境变量，走与
  `herdr-agent-state.ts` 相同的 unix socket 通道。
- 仅在 `ctx.mode === "tui"` 的会话生效：bg subagent 给自己 session 命名不会误改用户的 tab。
- 名字去重：连续同名不重复发送；名字被清除（undefined）不发送。
- 不在 Herdr 内运行时是纯 no-op。

## 安装

```bash
# 从 ~/projects/pi-mypackage 仓库根
pi install ./packages/pi-herdr-tab-rename
```

重启 pi session 生效。之后任何来源的 `setSessionName`（包括 qol auto-rename）都会同步
Herdr tab 标签。

## 验证

```bash
cd packages/pi-herdr-tab-rename && npm test
```
