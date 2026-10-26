# ddd-domain-interactions：领域事件与契约

> 正典：#29 收口裁定（issuecomment-5728518782）。可视化：`~/tmp/showme-domain-interactions.html`（交互总装）、`~/tmp/showme-sequence-subscription.html`（时序）。

## 领域事件目录（单一事件族）

**Transitioned 一族，别无分店**——无 per-state 事件类型（Merged/Closed 不存在，那是 State 值）。

| 事件 | 源聚合 | 触发条件 | 关键字段 | 范围 |
|---|---|---|---|---|
| Transitioned | Entity | transition() 提交（I1 同事务） | eventSeq（全局单调）、EntityRef、from、to、contentIdentity、occurredAt、evidenceRef | Domain |

自转换同族：(state, contentIdentity) 才是真实对。反向声明：只有实体转换产生事件——Delivery 状态、Subscription 生命周期、ephemeral 清理全是簿记。

## 集成事件契约

跨到 session 的不是事件本体，是 **Notification（值对象，B7 裁定自描述、无 profile 版本依赖）**。契约 Owner = daemon 单方（session 纯消费者）。版本策略：字段只增不改名；renames = 显式迁移。兼容窗口：不设——旧通知条目落 transcript 后天然冻结。

## 幂等与重放

| 机制 | 裁定来源 |
|---|---|
| TransitionIntent 预分配确定性 event id + appendIfMissing（同 id 跳过，异内容 = corruption） | v2 交叉研究采纳 |
| 全局单调 seq 双轨 | spec 增量清单 |
| notificationId 确定性 → I10 每 (notification, session) 恰一行 → drain 重放天然幂等 | #26/#29 |
| verified 迟到 24h → 一次幂等 re-push | A3 收口 |

## 订阅者与副作用

| 事件 | 消费者 | 动作 | 补偿 |
|---|---|---|---|
| Transitioned | fan-out（同事务 outbox） | 匹配订阅谓词 → 建 Delivery 行 | dead-letter + reckon 对账 |
| wake push | session extension | followUp 注入 + 条目落盘 | parked/drain |
| verified | — | 无后续动作 | 24h 一次幂等 re-push |

监控 = 运行时日志（B3），无 telemetry（后置裁定）；生产期诊断归 pi-events-doctor skill。
