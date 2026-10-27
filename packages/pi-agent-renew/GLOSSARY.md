# pi-agent-renew

/renew 换届扩展的领域词汇：agent 身份与 session 解耦的换届流程（SPEC.md §6 落地物）。

## Language

**换届窗口（window）**：
一次 /renew 触发后从开启到终态（DONE/ABORT/CANCELLED）的进行中区间；同一时刻至多一个开放窗口，属主是触发它的 session。
_Avoid_: 锁、会话、session window

**换届账本（ledger）**：
renew.log（事件流）与 sessions.log（当值登记）的合称——换届事实的唯一记录处，两者共同构成账本，无各自的内存态副本。
_Avoid_: 状态文件、数据库、缓存

**事件流（event stream）**：
renew.log 的 JSONL 追加序列；当前窗口状态永远从尾部推导，不存内存标志。LEGACY 行是 v0.2 自由文本的兼容形态，不参与推导。
_Avoid_: 日志（它不是被动日志，是状态机本体）

**当值者（on-duty agent）**：
sessions.log 中存在 endedAt:null 条目且 sessionId 与当前 session 匹配的 agent 身份。
_Avoid_: 当前用户、owner（owner 专指窗口属主）

**READY 确认**：
agent 完成上岗 checklist 后经 agent-renew-ready 工具落账的就绪标记；窗口外的调用记为 LATE_READY 仅作审计，绝不参与推导。
_Avoid_: 确认成功（直呼成功但不落账正是 10-27 双源事故的形态）

**交接附言（handoff note）**：
STATE.md「## 交接附言」节下上一届写给下一届的原话；校验要求 ≥20 字且非占位文本。
_Avoid_: 备注、note 字段（sessions.log 的 note 是登记摘要，非附言）
