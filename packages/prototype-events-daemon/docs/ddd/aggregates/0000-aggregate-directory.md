# ddd-aggregates：聚合目录与一致性策略

> 正典：ADR 0001（聚合边界）、#29 T10 裁定流、[CONTEXT.md](../../../CONTEXT.md) 词汇表。可视化：`~/tmp/showme-ddd-aggregates.html`（含 N 订阅→1 槽关系）。

## 聚合目录

| 聚合 | 根 | 内部实体 | 值对象 | 不变量 | 创建/关闭操作 |
|---|---|---|---|---|---|
| **Entity** | Entity（type+key 标识） | TransitionEvent（持久内部实体，被 I1 锁在同事务） | Payload、EntityRef、StateValue | I1 状态变更必经 Transition 且每 Transition 恰一条 Event（同事务原子）；I2 状态值属 profile 合法集；I3 级联关闭由 profile 编排不在内核；I4 ephemeral 终态后 retired 清理 | Register、Transition（查询走读侧） |
| **Subscription** | Subscription（id） | — | ProbeSpec（Specification 模式一等构造块）、WakePolicy、Scope、origin/sourceSessionId、BatchPolicy | I5 同槽键唯一共享；I6 跨聚合只用 EntityRef；I7 probe failed → 终态关闭；I8 ttl/once 自动关闭 | Subscribe、Cancel、Tick(评估→发 TransitionIntent) |
| **Delivery** | Delivery（单行根，A1 裁定） | — | Notification（VO：notificationId/eventSeq/billboard） | I9 verified ⇔ transcript 条目；I10 每 (notification, session) 恰一行 | 扇出创建、ack 流转、drain |

**RunnerSlot = runtime，非聚合**（A2 裁定）：槽键 (EntityRef, 模板)，持 RunLedger + refcount + tick()；非持久，重启从 Subscriptions 重建；谓词 = 订阅侧过滤器不进槽键（I5：N 谓词共享一次 fetch）。

## 事务边界

- Entity.transition()：状态 + Event + 预分配 notificationId 同事务（I1）
- Subscribe：跨 Entity + Subscription 的**单写者例外**（ID 预分配保安全）
- outbox：Transitioned → Notification/Delivery 异步投递

## 跨聚合一致性

TransitionIntent 顺序消费（幂等：预分配确定性 event id + appendIfMissing——同 id 跳过、异内容 = corruption）。进程间：单实例 flock + SQLite 单写者。

## 建模原则记录

- 单根聚合裁定而非缺省（A1）：Delivery 曾被 Notification 做父根，因跨 session 争用否决
- 禁止集合容器根（SubscriptionBook 类）
- 状态是转换事件的纯归约（快照只是归约缓存，#30 裁定）
