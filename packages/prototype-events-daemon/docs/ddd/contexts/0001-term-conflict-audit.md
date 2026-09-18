# 术语冲突审计（ddd-contexts 冲突处理）

> 执行日期 2026-09-18。对 CONTEXT.md 22 词 + 裁定集做同名异义扫描，3 处候选冲突全部处置。

| 候选冲突 | 判定 | 处置 |
|---|---|---|
| **Entity.state vs Delivery 状态**（pending/accepted/parked/verified/failed/dead-letter）——两个聚合各有一组"状态"，glossary 的 State 词条只写了 Entity 视角 | 真冲突 | CONTEXT.md 新增 **Delivery state** 词条：kernel 定义固定封闭集、非 profile、不产生事件（与"只有实体转换产生事件"反向声明闭环） |
| **check vs checker vs ProbeSpec** 三近形词 | 可接受，需划界 | ProbeSpec 词条补包含关系句：check（命令文本）是其组成部分，checker 是执行原语 |
| **scope 字段 vs EntityRef key 前缀**（两套 project/user） | 非冲突（#29 comment 246/247 已裁定） | 前缀 = 身份单一事实源，scope = 订阅归属，subscribe scope 参数 = 按前缀过滤的视图。无动作 |

## 反术语清单

正典 = CONTEXT.md 各词条 `_Avoid_` 行（22 条），不在此重复。维护规则见 0000 的语言演进规则。

## 回溯检查

>5 个不可调和跨上下文冲突 → 回溯 ddd-discover。当前：0 个不可调和冲突，无回溯。
