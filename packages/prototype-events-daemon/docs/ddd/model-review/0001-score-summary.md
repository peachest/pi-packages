# 评分总览（正式门禁评分）

> 本文档是 `ddd-model-review` 流程（阶段 IV 质量门禁）的输出之一。
> 对以下 5 个维度 0-10 打分：术语一致性、边界合理性、不变量表达率、事件完整性、耦合度。
> 与 `0000-critic-and-readiness.md` 的关系：0000 记录的是 design-critic 两轮质询的定性收口；
> 本四件套（0001-0004）补正式评分门禁，不重写 0000，二者结论互证。

## 评分判据（可复现）

- **术语一致性**：正典 = CONTEXT.md 18 词条 + `_Avoid_` 反术语 + docs/ddd 各文件 + #29/#30 裁定表述。扣分按「未处置的同名不同义 / 同义异名 / 定义漂移」计，每处 -0.5 ~ -1.0；元数据失实（计数、引用）-0.5。
- **边界合理性**：聚合边界 vs 上下文边界（ADR 0005）一致性；不变量不得跨越上下文；kernel/profile/adapter 依赖方向（ADR 0005 试金石）。每处依赖方向歧义或边界语义漂移 -0.5 ~ -1.0。
- **不变量表达率**：对 aggregates/0000 的 I1-I10 逐条判定——**显式 = 1**（不变量绑定到具名聚合操作/构造保证，有强制点）；**部分 = 0.5**（行为归属已表达但强制点在 runtime 非聚合组件，或仅靠缺省约定）；**未表达 = 0**（负向声明或纯数据约束，无强制点）。表达率 = Σ分值/10。
- **事件完整性**：以本项目正典裁定（T10 收口裁定 ①②，#29 issuecomment-5728518782：单一事件族 Transitioned + 只有实体转换产生事件）为判据，**不以"每步簿记都有事件"计**（判据论证见维度 4 详解与 0003 回溯判定第 5 条）。计三项：领域事件目录覆盖（正式定义/应定义事件）、命令→聚合处理映射、异常路径状态机归宿。
- **耦合度**：依赖方向单向性、adapter 只读性、runtime 组件边界、共享数据量、同步调用数。

---

## 评分全表

| 维度 | 得分 | 权重 | 加权分 | 主要扣分原因 |
|---|---|---|---|---|
| **术语一致性** | 7.5 / 10 | ×1.0 | 7.5 | contexts/0001 审计处置了 3 处冲突且语言演进规则完备（+）；扣分：① ephemeral key 公式三处漂移（CONTEXT.md "sha1 of the check" vs domain-interactions/0001 "sha1(check+cwd+interval)" vs #29 早期 comment "sha1(check)"）未同步回词条；② Transition（词条）与 TransitionEvent（聚合内部实体名，#29 裁定 comment）同概念双形未澄清；③ TransitionIntent/outbox/billboard/evidenceRef/notificationId 五个高频衍生概念未经 P-014 审计入册（RunLedger 有显式豁免裁定，此五者无处置记录）；④ README.md:4 与 contexts/0001:3 声称"22 词"，实际 18 词条——元数据失实 |
| **边界合理性** | 9.0 / 10 | ×1.2 | 10.8 | 单一限界上下文判定（ADR 0005）与 contexts/0000 三模块层 + subdomains/0000 "Core ≈ kernel" 交叉验证互证，无聚合/上下文矛盾；I6 跨聚合只用 EntityRef，无跨上下文不变量。扣分：I2 的强制机制在依赖方向上悬空——domain-interactions/0001 写"Entity 对照 profile 状态机验证后才提交"，但 ADR 0005 规定 kernel 零领域知识、依赖单向 profile→kernel，状态集如何到达 kernel 的 transition() 校验点（注入/注册/反转）无任何工件记载 |
| **不变量表达率** | 7.0 / 10（70%） | ×1.5 | 10.5 | I1/I2/I7/I8/I10 五条显式（绑定到 transition()/transition() 入口校验/Tick 评估/扇出 upsert 等具名操作）。I3（级联关闭归 profile）是负向边界声明，无强制点，记 0；I4/I5/I6/I9 记 0.5（I4 retired 清理无归属组件；I5 强制点在 RunnerSlot——A2 有意裁定的 runtime 非聚合；I6 靠仓储"不跨聚合 join"约定；I9 的 ⇔ 系于 adapter 识别，风险已登记 R1） |
| **事件完整性** | 8.5 / 10 | ×1.0 | 8.5 | **裁定为 substrate 合理形态**（论证见下节与 0003）：正典判据下领域事件目录覆盖 1/1、主路径 9 步命令→聚合处理映射 9/9、异常路径 5/5 有状态机归宿。扣分：discover/0000 异常路径表列 12 个过去时命名（DeliveryParked、DeadLettered、Drained 等）无性质标注，主路径仅 VerdictProduced 一条显式标"簿记（非事件）"——呈现层与反向声明有摩擦，需读者自行推导 |
| **耦合度** | 8.5 / 10 | ×1.5 | 12.75 | profile→kernel 单向（试金石：新增 profile 零 kernel 改动）；adapter SessionStore 只读永不写会话文件；runtime 组件重启重建、不进词汇表（A2）；outbox 异步解耦 + 共享数据极小（notificationId + evidenceRef 指针）；transition() 校验进程内零存储查找。扣分：同边界维度 I2 强制方向的机制未写明（是唯一可能逼出 kernel→profile 反向依赖的缝隙） |

**加权总分：50.05 / 60（83.4%）**

---

## 评分矩阵

| 维度 | 得分 | 优秀(9-10) | 良好(7-8) | 需改进(5-6) | 不合格(0-4) |
|---|---|---|---|---|---|
| 术语一致性 | **7.5** | — | ✅ | — | — |
| 边界合理性 | **9.0** | ✅ | — | — | — |
| 不变量表达率 | **7.0** | — | ✅ | — | — |
| 事件完整性 | **8.5** | — | ✅ | — | — |
| 耦合度 | **8.5** | — | ✅ | — | — |

**边界合理性进入优秀区间；其余均在良好区间，无维度低于 7。**

---

## 维度 4 专项论证：substrate 合理形态 vs 完整性缺口（不许和稀泥）

**判定：substrate 合理形态，不是完整性缺口。** 论证链（全部工件可复核）：

1. **裁定是正典而非建模事故**。T10 收口裁定（#29 issuecomment-5728518782）第 1、2 条用户逐项确认：单一事件族 Transitioned、无 per-state 事件类型、反向声明"只有实体转换产生事件"。ddd-discover 是**补跑验证**环节（README 建模链图），其 9 步表的"性质"列恰好逐行印证了该裁定，而非与其冲突。
2. **词汇表自身闭环**。CONTEXT.md Entity 词条："its state is a pure reduction of its transition events"；Delivery state 词条："kernel-defined fixed closed set of bookkeeping states … **never produces events (only entity transitions do)**"。即：Delivery/Subscription/Session 生命周期的"事件"（parked/drain/verified 等）按定义就是簿记状态迁移，**不存在被漏定义的领域事件**。
3. **状态=纯归约模型下，"簿记本就不该是事件"成立**。#30 A 节裁定①：状态仍是纯归约、快照只是缓存。若给 Delivery 状态迁移发领域事件，等于在同一 substrate 里造第二套事件族，破坏 I1"事件是转换副产品"与 B7 事件自描述裁定的前提（重放安全依赖事件族单一）。
4. **量化（按 substrate 自身判据）**：领域事件目录覆盖 1/1（Transitioned 在 domain-interactions/0000 有源聚合/触发条件/关键字段/范围正式定义，自转换同族由 ADR 0003 覆盖）；主路径 9 步中每条命令都有聚合归宿（Register→Entity、subscribe→Subscription、tick→RunnerSlot/Subscription、TransitionIntent 顺序消费→Entity、扇出→Delivery、wake→dispatcher、followUp→adapter、I9 扫描→Delivery、close→Subscription）；异常路径 5/5 有状态机归宿（Delivery state 封闭集 + E2 退避/dead-letter 终态 + E5 幂等 re-push）。
5. **残余缺口是呈现层而非模型层**：discover/0000 表头用"事件（过去时）"称呼簿记步骤、异常路径表 12 个过去时命名无性质标注——读者须自行推导它们不是领域事件（记为问题 I-06，P3）。

对照反事实：若判"完整性 <70%"，唯一依据是把 8 条簿记步各记为"缺正式事件定义"——这将直接推翻 T10 用户裁定的正典地位，属判据错置而非模型缺陷。故不触发 ddd-domain-interactions 回溯。

---

## 校验清单

- [x] 5 个维度已评分
- [x] 每维有主要扣分原因，每个扣分项引用具体工件+条目
- [x] 评分判据显式（每档分数可复现：术语按处计、不变量 1/0.5/0 rubric、事件完整性按正典判据三计）
- [x] 加权总分计算（83.4%，权重沿用 example-npu-manager 四件套权重）
- [x] 维度 4 争议点给出带引用的单边论证（substrate 合理形态）
