# ddd-discover：事件流与异常路径

> 正典：#30 A 节（歧义清账裁定）。执行日期 2026-09-18（补跑——当初战术链先行，本 skill 后补以完整覆盖异常路径）。

## 事件流表（主路径，9 步）

| # | 事件（过去时） | 触发命令 | 发起者 | 输入/输出 | 性质 |
|---|---|---|---|---|---|
| 1 | EntityRegistered | subscribe / states() 懒创建（B4） | agent / daemon | URL → key generator → EntityRef + state=null | 簿记 |
| 2 | Subscribed | subscribe(entityRef, opts) | agent | 模板实例化 → ProbeSpec + 槽 refcount++ | 簿记 |
| 3 | VerdictProduced | tick() → check | RunnerSlot | 三态 verdict + evidenceRef | 簿记（非事件） |
| 4 | **Transitioned** | TransitionIntent 顺序消费 | daemon | from/to/contentIdentity/eventSeq；同事务 I1 | **领域事件（唯一）** |
| 5 | DeliveryRowCreated | outbox 扇出 | 投递循环 | 每 (notification, session) 一行（I10） | 簿记 |
| 6 | WakeAccepted | wake push | daemon→extension | 长连接在线 → accepted | 簿记 |
| 7 | NotificationLogged | followUp 注入 | extension | 通知条目落 transcript | 簿记 |
| 8 | DeliveryVerified | I9 扫描命中 | 验证扫描 | notificationId 点查询 | 簿记 |
| 9 | SubscriptionClosed | once 命中 / ttl / cancel / I7 checker failed | agent / daemon | active → closed | 簿记 |

反向声明（与裁定一致）：**只有实体转换产生事件**——其余全是簿记，不发事件。

## 异常路径（5 条，超出 ≥2 要求）

| 路径 | 事件链 | 裁定 |
|---|---|---|
| E1 跨天离线 | SessionClosed → DeliveryParked（不重试不超时）→ SessionStarted → Drained → DeliveryVerified | A3 收口 ✓ |
| E2 传输失败 | DeliveryRetryScheduled（2s→5min 退避）→ DeadLettered | #26 ✓ |
| E3 断言发散 | AssertionDiverged → ProbeCorrected（探测修正豁免状态机合法性检查——现实赢了就是赢了） | provenance post-MVP，随方案一并挂起（#30 B） |
| E4 probe 持续失败 | VerdictFailed ×N → SubscriptionClosed（I7 终态关闭） | #26 ✓ |
| E5 verified 迟到 | DeliveryVerifiedAbsence(24h) → DeliveryRePushed（幂等一次） | A3 收口 ✓ |

## 热点标注

- **强一致性**：I1 同事务（转换+事件+notificationId 预分配）；Subscribe 跨 Entity+Subscription 单写者例外（ID 预分配）
- **跨系统边界**：profile ACL（URL→EntityRef、glab/kubectl→三态 verdict）；transcript adapter（v3/v4 双形态 + lane 信封 + 撕裂尾行容错）
- **性能**：I5 共享抓取 + single-flight；FTS5 点查询
- **安全**：token-pattern 拒绝、零凭证存储、执行面清单（B3）

## 歧义清账（4 条，2026-09-18 用户确认，裁定入 #30）

| 歧义 | 裁定 |
|---|---|
| Event 流无界增长 | 事件流永久保留（归约源+审计）；定期快照 = 归约结果固化 + 冷归档，状态仍是纯归约、快照只是缓存；MVP 不做，性能触发再上 |
| profile 冲突 | EntityRegistered 记录 profile id；同 EntityRef 被不同 profile subscribe → 报错（一个实体不得属于两个 profile） |
| drain 窗口永久退场 | dead-letter 即终态，reckon 可查，无无限重试 |
| retired 后收到 publish | 报错拒绝，不复活 |
