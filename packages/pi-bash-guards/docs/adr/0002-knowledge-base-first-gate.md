# ADR 0002: Knowledge-base-first gate（KB gate）——bash 守卫里的一道"先读库"门闩

日期: 2026-10-26
状态: accepted（票 #166 回流自 kendex 部署副本，回流时三向裁决）

## 背景

doc-consumption audit（2026-10-16，1164 sessions / 8 repos）显示：诊断类 session 惯性绕过 ~/ops 诊断库，重新推导库内已有的根因；wiki 触碰 61% 由外部力量（用户点名）驱动，自发性阅读仅 2 例。session 挖掘（GLOSSARY 词条）为规则提供"禁止什么"的证据，但没有任何机制提供"该读而没读"的证据——缺失行为不会出现在命令日志里。

同时，kendex 部署副本曾自发演进出一个 KB gate 实现（领先 repo 84 行未回流，2026-10-26 发现），证明这个需求真实到有人在无协调的情况下写了它。

## 决策

在 pi-bash-guards 增加第 13 条规则 **KB gate**：

1. **窄触发面**：只有 cluster/service 运行时探查命令（kubectl、crictl、journalctl、dmesg、nvidia-smi）触发。helm/nerdctl 属部署/管理动作，明确不 gate——宁可漏拦不可扩大化。
2. **touch 即 satisfy**：任何触碰 ~/ops 或 llmops-wiki 的命令（读索引、跑 diag-search、写诊断）为整个 session 打开门。写诊断本身就是满足动作，不要求先读后写。
3. **session 级 flag，不是每次拦截**：状态 = flag 文件（transcript 路径 sha1 前 16 位为键）。一次门闩，不是持续骚扰。
4. **fail-open 三处**：无 transcript 不拦、state 目录不可写不拦、readlog 写失败静默——守卫自身故障永不升级为封锁。
5. **月度 readlog**：每次 gate 决策（block/satisfy/pass）追加 jsonl 到 kendex state，成为未来 doc-consumption audit 的直接数据源——替代从 session JSONL 二次挖掘。

## 舍弃的替代方案

- **全量命令 gate**：触发面扩大到所有命令 → 噪声淹没信号，守卫信誉损失（被拦者不读理由）。
- **每次拦截（无 session flag）**：用户读了库仍反复被拦 → 惩罚已合规行为。
- **不 gate，只靠 skill 引导**（现状）：audit 数据证明引导无效——自发性阅读 2 例。
- **在 ~/ops 侧做（读计数器）**：读侧无法知道"这个 session 正要跑 kubectl"，时机信息在守卫侧。

## 后果

- 正：诊断 session 首次探查集群前必看 vault 路线；readlog 让 doc-consumption audit 从一次性审计变成持续信号。
- 负：bash 守卫引入了与 kendex hook 无关的外部概念（~/ops vault、llmops-wiki）——守卫的知识面扩大。缓解释：触发面与消息里只引用路径与 skill 名（diag-search），不硬编码 vault 内部结构。
- 负：flag 文件是文件系统状态（ Kendex state 目录），跨机器不迁移——接受（session 本身就不跨机器）。
- 注意：回流裁决明确拒绝 guard-override 通道随本 ADR 复活（415c996：拦截不允许绕过）；KB 拦截消息只给检索路线，不给豁免标记。
