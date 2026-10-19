# 0006: 事件 id = deterministicEventId(ref, decisionOrder)

**日期**: 2026-10-18（架构深化期间定型）　**状态**: Accepted

## 决策

事件主键由 `(EntityRef, decisionOrder)` 确定性派生：`deterministicEventId(ref, decisionOrder)`，decisionOrder 是该实体转换序列内的事务序。

## 为什么

重放幂等要求：崩溃恢复/重启窗口重放同一转换必须派生同一 id，delivery 行 (notificationId, session) 的 I10 唯一性才可依赖。曾评估内容派生方案（id = hash(状态内容)），废弃——occurredAt 参与派生导致同一事件重放产生不同 id，幂等失效。

## 后果

- 同实体转换天然有序可对账（decisionOrder 单调）
- 内容相同但时间不同的两次转换是两个事件（正确：状态翻转两次=两次通知机会）
- 依赖：I1（转换与事件同事务提交）保证 decisionOrder 分配的原子性
