# 问题清单（正式门禁评分）

> 本文档是 `ddd-model-review` 流程（阶段 IV 质量门禁）的输出之一。
> 所有问题按严重程度降序排列。与 0000（design-critic 两轮质询）的关系：0000 的 A/B/C 级发现已全部裁定收口，本清单只含**收口后仍存在于当前工件中的问题**，不重复 0000 已解决项。

## 问题列表

| # | 问题 | 影响 | 证据（引用具体工件与条目） | 建议修复 | 优先级 |
|---|---|---|---|---|---|
| I-01 | **I2 的强制机制在依赖方向上悬空**：kernel 零领域知识 vs "Entity 对照 profile 状态机验证后才提交"——状态集如何到达 kernel 的 transition() 校验点无工件记载（注入/注册/依赖反转均未落字） | v2 汇总 spec 若不补一句话，实现者可能在 kernel 里 import profile（直接违反 ADR 0005 试金石），或在 EntityRegistered 时漏传状态集导致 I2 无从校验 | `domain-interactions/0001` 内部组件表 probe 执行行："不裁定转换——**Entity 对照 profile 状态机验证后才提交**"；`contexts/0000` kernel 行："零领域知识（不对源系统特判）"；`adr/0005`："Dependency direction is one-way: profiles import kernel; kernel never imports profiles"；#29 comment（2026-09-17 19:02）："状态机（合法状态集+合法边）= profile 层类型级声明，transition() 入口本地校验（进程内函数，零存储查找）"——机制有暗示但注册/注入方式未写入任何正典工件 | v2 汇总 spec 实体章补一段：profile 加载时把（状态集+合法边）作为**值**注册进 kernel 校验器（如 Entity 注册记录携带 profile id + 状态集快照），并在试金石验收项里加一条"kernel 代码不含任何源系统状态字面量" | **P1** |
| I-02 | **ephemeral key 公式三处漂移**：CONTEXT.md 只写 "daemon-minted sha1 of the check"；#29 早期 comment 写 `sha1(check)`；最终裁定（critic B1+B2 收口）是 `sha1(check + interval + cwd 快照)`；domain-interactions/0001 写 `sha1(check+cwd+interval)`（归因 B2，实为 B1 整合式） | glossary 是正典（README 声明"裁定 comment 中的临时表述以 CONTEXT.md 为准"），当前正典与裁定不一致——实现者按 CONTEXT.md 会把两个 worktree 同命令串判成同一实体（critic B2 明确反对的 key 误共享场景） | `CONTEXT.md` Ephemeral entity 词条："key = daemon-minted **sha1 of the check**"；`domain-interactions/0001` 工厂表："key = **sha1(check+cwd+interval)**（B2）"；#29 critic 收口 comment（2026-09-17 18:37，B1 条）："ad-hoc 路径 interval 入 sha1 输入（key = sha1(check + interval + cwd)）"；同 comment B2 条："ephemeral key = sha1(check + cwd 快照)"（与 B1 的整合式本身也差 interval，需一并钉死唯一公式） | CONTEXT.md Ephemeral entity 词条改为最终公式（以 B1 整合式为准），并在 0001 工厂表修正归因（B1）——两处一处措辞 | **P2** |
| I-03 | **五个高频衍生概念未经 P-014 审计入册**：TransitionIntent、outbox、billboard、evidenceRef、notificationId 跨 aggregates/domain-interactions/discover 三工件反复出现，既无 CONTEXT.md 词条也无"归 runtime 不入册"的显式豁免（RunLedger 有 A2/ADR 0005 豁免，此五者没有对应处置记录） | 语言演进规则（contexts/0000 规则 1："新名词过'是否同一概念'审计（P-014），通过才进 CONTEXT.md"被跳过；v2 spec 写作时这些词要么无定义可引，要么被误升格为领域概念 | `aggregates/0000` 跨聚合一致性节（TransitionIntent、outbox）；`domain-interactions/0000` 幂等表（notificationId、outbox）；`discover/0000` 热点（evidenceRef + FTS5）；Notification 词条内嵌 billboard（"billboard view"）。#29 术语审计 comment（19:30）仅保留了 billboard（"#26 冻结术语"），其余四个无审计记录 | 二选一：给 TransitionIntent（意图值对象）与 evidenceRef/notificationId 进词条或并入现有词条（Transition/Notification/Delivery）；outbox 归实现层、按 RunLedger 先例写一行显式豁免 | **P2** |
| I-04 | **词汇表计数失实**：README 与 contexts/0001 均称 CONTEXT.md "22 词"，实际 18 个词条（18 个 `**…**` 词条头；`_Avoid_` 行 15 条） | 元数据不可信——门禁复核时无法凭文档定位词条全集，审计覆盖面存疑 | `docs/ddd/README.md` 第 4 行："（22 词 + _Avoid_ 反术语）"；`contexts/0001-term-conflict-audit.md` 第 3 行："对 CONTEXT.md 22 词"；实测 `grep -c '^\*\*' CONTEXT.md` = 18 | 两处把"22 词"更正为 18（或改为不带数字的"全部词条"） | **P3** |
| I-05 | **Transition 家族三词无反术语，且 Transition/TransitionEvent 双形未澄清**：Transition、Self-transition、Content identity 三条核心词条是仅有的无 `_Avoid_` 行的领域词条；聚合内部持久实体在 #29 裁定与 aggregates/0000 中名为 **TransitionEvent**，glossary 只有 Transition（动作与记录形态未分名） | "Transition 是状态变更行为还是持久事件记录"在实现期必然被问一次；反术语清单对最核心的转换概念零防护 | `CONTEXT.md` Transition/Self-transition/Content identity 词条（实测无 `_Avoid_` 行，15/18 有）；`aggregates/0000` 聚合目录："内部实体 **TransitionEvent**（持久内部实体，被 I1 锁在同事务）"；#29 comment（19:02）："transition = TransitionEvent（Entity 聚合内部实体，append-only，seq 即身份）" | Transition 词条补一句"其持久记录形态为 TransitionEvent（Entity 内部实体）"，三条各补一行 `_Avoid_`（如 Transition 避免与 Delivery state 迁移混称"状态变更"） | **P3** |
| I-06 | **discover 异常路径表 12 个过去时命名无性质标注**：E1-E5 使用 SessionClosed/DeliveryParked/SessionStarted/Drained/DeliveryVerified/DeliveryRetryScheduled/DeadLettered/AssertionDiverged/ProbeCorrected/VerdictFailed/DeliveryVerifiedAbsence/DeliveryRePushed，均不进领域事件目录也未标"簿记"；主路径仅 VerdictProduced 一条显式标"簿记（非事件）" | 与反向声明（只有实体转换产生事件）呈现冲突，读者/实现者可能误把这些名字当成待实现的领域事件类型 | `discover/0000` 异常路径表（E1-E5 全部 12 个过去时命名）；对照 `domain-interactions/0000` 事件目录（仅 Transitioned 一行）与 T10 收口裁定第 2 条反向声明 | discover/0000 异常路径表补一列"性质：簿记/裁定语义"（同主路径第 3 步的标注方式），或在表头加一行说明 | **P3** |

## 严重度分布

| 优先级 | 数量 | 问题编号 |
|---|---|---|
| P0（阻塞） | 0 | — |
| P1（v2 spec 写作前必须清账） | 1 | I-01 |
| P2（随 v2 spec 一并处理） | 2 | I-02, I-03 |
| P3（低成本文档修缮） | 3 | I-04, I-05, I-06 |

**总计：6 个问题（0 P0、1 P1、2 P2、3 P3）。** 无模型层结构性问题——全部为正典同步与呈现层缺口；design-critic 两轮（0000）已消化全部 A 级模型矛盾。

## 校验清单

- [x] 每个问题有可复核的证据（工件 + 条目 + 裁定 comment）
- [x] 问题按优先级 P0~P3 分类
- [x] 影响描述明确
- [x] 建议修复可执行
- [x] 与 0000 质询记录不重复（只含收口后残留）
