# pi-herdr-ask-bridge

让 Herdr 在 agent 调用 `ask_user_question` 时显示独立的 **blocked** 图标，区别于普通 agent loop 的 working 状态。

## 问题

当 pi agent 调用 `ask_user_question` 等待用户回答时，Herdr 面板图标仍然是 "working"——和一个正在跑 agent loop 的 session 完全相同，用户没有任何视觉提示知道 agent 正在等自己输入。

## 根因

`ask_user_question`（来自 `@juicesharp/rpiv-ask-user-question`）**已经**在问卷显示/关闭时 emit `rpiv:ask-user:blocked` 事件：

```ts
emitAskUserBlockedEvent(pi, true);   // 问卷打开
// ... 等待用户回答 ...
emitAskUserBlockedEvent(pi, false);  // finally 块，问卷关闭
```

但 Herdr 的 pi 集成（`herdr-agent-state.ts`）监听的是 `herdr:blocked`——这是 `pi-subagents` 和 `pi-guardrails` emit 的事件。**没人把 `rpiv:ask-user:blocked` 桥接到 `herdr:blocked`。**

## 方案

这个扩展就是那座桥。它：

1. 监听 `rpiv:ask-user:prompt`（问卷打开前触发）——提取第一个问题的 `header` 作为 label
2. 监听 `rpiv:ask-user:blocked`：
   - `{ active: true }` → emit `herdr:blocked { active: true, label: "❓ <header>" }`
   - `{ active: false }` → emit `herdr:blocked { active: false }`

现有的 `herdr-agent-state.ts` 接管剩下的工作：它把 pane 状态翻转为 `blocked`，Herdr 渲染出独立的 blocked glyph（当 `status_indicators = "symbols"` 时）。

非 Herdr 环境下（`HERDR_ENV != "1"`）扩展直接 return，零开销。

## 安装

```bash
cd ~/projects/pi-mypackage
pi install ./packages/pi-herdr-ask-bridge
```

## 依赖

- `@juicesharp/rpiv-ask-user-question`（`ask_user_question` 工具的提供者，需已安装）
- Herdr（`herdr integration install pi`，需已安装）

两者缺一时扩展无害：没有 rpiv 事件则桥不做任何事；没有 herdr 则 `herdr:blocked` emit 无监听者。

## License

MIT
