# ddd-domain-interactions：领域服务、仓储、工厂

> 三内部组件为**实现层概念，不进词汇表**（A2 裁定）——与 RunLedger 同级运行时概念，实现可自由重构。可视化：`~/tmp/showme-domain-interactions.html`。

## 内部组件（运行时连接组织）

| 组件 | 职责 | 边界（不含的逻辑） |
|---|---|---|
| **probe 执行**（RunnerSlot.tick） | 按 nextDueAt 执行 checker、记 RunLedger、产 verdict → 发 TransitionIntent | 不裁定转换——Entity 对照 profile 状态机验证后才提交 |
| **投递循环**（dispatcher） | accepted 重试退避 2s→5min、parked 事务、SESSION_START drain、dead-letter | 不解释 verdict、不判定 verified |
| **验证扫描**（scanner） | 扫 transcript 找 notificationId（I9 点查询）、24h re-push 触发 | 不读取通知内容语义 |

跨聚合流程无编排者——顺序消费 TransitionIntent + outbox 即编排骨架（ADR 0001）。

## 仓储语义契约

| 聚合 | 方法（语义） | 查询边界 |
|---|---|---|
| Entity | 按 EntityRef 加载 / 同事务提交 transition+event / 按 scope 枚举 | 不跨聚合 join；reckon 由查询服务组合 |
| Subscription | 按 sourceSessionId 列 / 按 EntityRef 列（refcount 重建） | 同上 |
| Delivery | 按 session 找 parked/pending（drain）/ upsert / dead-letter 清单 | 同上 |
| SessionStore（**adapter 拥有**） | notificationId 存在性点查询（v3/v4 双形态 + lane 信封 + 撕裂尾行容错） | 只读，永不写会话文件 |

## 工厂

| 工厂 | 创建条件 | 初始状态 |
|---|---|---|
| Entity 首次观测 | key generator 解析 + 首个订阅或懒查询（B4） | **state=null** 直到首个 verdict（无 unprobed 前置态，裁定①-3）；读侧处理 null（谓词 null 期不命中） |
| Ephemeral 实体 | subscribe(check)，key = sha1(check + schedule + cwd)（B1 整合式，schedule 泛化后钉死） | born → 首个 verdict 前无状态；terminal→retired(7d 清理)，retired 后拒绝 publish |
| Subscription | 模板实例化 + 意图 opts（on/once/flip/template） | 即激活，进槽 refcount++；同 session 同参重复 subscribe = 幂等返回既有；换参 = 关旧开新（checker 替换） |

profile 冲突防护（#30 裁定）：EntityRegistered 记录 profile id，同 EntityRef 被不同 profile subscribe → 报错。
