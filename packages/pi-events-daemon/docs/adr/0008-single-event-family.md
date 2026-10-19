# 0008: 单一事件族 Transitioned

**日期**: 2026-10-18　**状态**: Accepted

## 决策

全部事件属于唯一族 **Transitioned**：字段 {eventSeq, EntityRef, from, to, contentIdentity, occurredAt, evidenceRef}。不引入 per-state 事件类型（没有 DeliveryCreated、SubscriptionClosed 这类事件）；Delivery 状态、Subscription 生命周期、ephemeral 清理全是簿记，不产生事件。

## 为什么

事件消费面（订阅谓词 on、wake 判定、re-push 对账）只需"某实体从某状态到某状态"一件事；per-state 类型会让每个新状态都膨胀事件 schema 与订阅谓词语法。自转换用 (state, contentIdentity) 覆盖：状态不变、内容身份变化也是真实转换。

## 后果

- 订阅 on 谓词语法恒定（状态值/状态集/命名转换 post-MVP）
- 簿记审计走运行时日志（无 telemetry），不冒充事件
- Transitioned.as 唯一 XML tag（协议层 schema 简化）
