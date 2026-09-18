---
origin: idea
status: accepted
created: 2026-09-17
updated: 2026-09-18
---

# Intent: pi-events-daemon

## Problem

Agent 需要等外部条件（推理服务就绪、MR 合并、CI 通过、ticket 关闭、长任务完成）才能继续。现有手段各有结构性缺口：

- **bg_run** 只检测"进程退出"一种事件，其余条件必须手写轮询脚本包进去；任务 session-scoped，只唤醒 launching session，且通知静默丢失（实测 12%）。
- **pi-poll** 把"shell 条件轮询"做好了，但前台阻塞——长等待占死 turn，无通知唤醒，不能跨 session/跨项目。
- **herdr + multi-agent-collab** 解决了 peer 间点对点对话，但 herdr 无广播原语——用 N 次 prompt 模拟广播时，每个 peer 各消费一份全量 prompt，且发布方须先知道所有 peer 编址；自然语言消息无结构化事件语义、无幂等去重；peer 关闭即丢，无补投。现有工具是"会话通道"（message passing），缺的是"事件底座"（broker + 登记处）。

实测证据：speculative-training 3 session 65 次 bg_run 中 45% 是纯"等待条件"任务；全量 6380 条长任务轨迹中前台轮询累计 13.9h；跨天弃置 30 例（含 63.5h smoke test 挂过夜）。

**模型升维后新增的痛点（2026-09-17 细化）**：

- **共享文档陈旧**：多 session 项目（如 speculative-training）的共享文档（INTENTS/CONSTRAINTS/CONTEXT/RESOURCE/ENV.md）由 AGENTS.md 手动 read，一个 session 更新后其他 session 持旧上下文继续工作而不自知。
- **全局资产更新不可知**：AGENTS.md、~/.pi/agent/skills 会构造进 system prompt，更新后已开 session 无法感知，需要 TUI 通知提醒 reload。
- **进度型事实无处可查**：包下载 %、wayfinder map 完成度（6/8）、CI job 通过比——不是枚举状态，现有订阅/查询都不覆盖。

## Proposed outcome

**通用实体状态注册表 + k8s 式 list&watch**（pi extension + 中心常驻 daemon）：

- **底层是状态机建模**：分支/MR/CI/ticket/环境……本质都是实体（entity），实体带状态，状态间有转换。**事件是状态转换的副产品**——实体从 open→merged、draft→ready 时自然产生事件（edge-trigger 决策的统一化表述）。
- **轮询复杂性的封装**：状态属外部系统（GitLab 管理的分支/MR）时只能轮询获得，除非外部系统原生提供 list&watch（k8s 资源可直接调 SDK/kubectl -w；本地文件可用 fs watch 原生推送）。daemon 本质 = 为 pi session 提供通用的 k8s 式 list&watch 与事件通知机制。
- **状态两类**：枚举（有限离散，MR open/closed）与进度（数值型：下载进度、map 6/8、job 通过比）。
- **实体父子关系**：branch → MR → CI pipeline → jobs；wayfinder Map → tickets（Map 有 progress 状态）；uv env → 依赖包（各自安装进度）。组织为可展示的状态树。
- **订阅两方式**：agent 主动调 tool 订阅；session 启动自动订阅（项目级：共享文档集；全局级：AGENTS.md/skills）。
- **两作用域**：项目（当前项目 docs/ 更新）与全局用户（skills 更新）。
- ** reckom 演进为 /reckon command**：daemon 注册到 pi 的命令，按当前 session id 启发式展示该 session 订阅的实体/事件状态（自动忽略未订阅实体与自动订阅），父子关系树形展示（分支-mr-ci-job 一棵、env-依赖包一棵）。
- 投递与 daemon 形态沿承已定稿的 spec #26（两段式 ack、edge-trigger、batch 合流、dead-letter、跨 session）。

## 定位（2026-09-17 裁定，详见 #29）

daemon = 中介 broker + 状态登记处：每订阅者的边际成本从全量 prompt 降到一条通知行（notificationId + evidenceRef 指针；Delivery 行数仍随订阅者数 O(N)，省的是 token）；离线 parked 补投；共享抓取（N 谓词一次 fetch）；非事件状态登记（/reckon 点查询）。等待不占 turn、通知本身极小——token 花在事件命中的处理上，而非轮询与广播冗余上。

## Constraints

- 通知必须能唤醒订阅的 pi session；中心化单实例 daemon；判定器可插拔（shell 单原语）
- 判定器契约：三态骨架（pass/fail/waiting），exit code 仅内部约定，agent 可见面一律语义命名
- 投递 durable：写前落盘 + 两段式 ack（accepted→verified）+ 退避重试 + dead-letter
- MVP 判定器：自定义命令/脚本 + HTTP + GitLab MR/CI/ticket + **本地文件监听（fs watch 原生推送，非轮询）**
- MVP 需支持跨 session 事件订阅
- **MVP 不做派生订阅**（订阅实体自动含子实体事件——噪声/风暴风险，post-MVP 讨论）
- 事件来源标记（2026-09-18 裁定：**post-MVP**）：MVP 不实现 provenance 字段；publish 无标记可用，幻觉断言污染风险由消费方自行警惕，风险行进 spec 增量清单；正式方案（事件带 probe-derived | agent-asserted + 消费方可见 + 探测修正豁免状态机检查）post-MVP 再裁
- 复用模式（#28 研究）：pi-schedule run ledger/single-flight/catch_up_one、pi-cron headless export/loop guard、pi-webhook polite injection/reattach

## Non-goals（2026-09-17 裁定）

- 不存储凭证（零凭证**存储**不是安全边界；check 运行时自取 glab 登录态，token 生命周期归 glab/用户）；不做 sandbox 级隔离——执行面清单（超时 10s/并发 8/token-pattern 拒绝/审计走运行日志）见 spec 增量（B3 裁定）
- 不做编排/leader 派活（8 月实验已失败；daemon 只做感知不做指挥——与 multi-agent-collab 分界：collab 管"对话"，daemon 管"知道"；持续演进不排除未来纳入编排或与 bg_* 更深度集成，当前按此边界）
- 不做通用消息队列（事件是实体转换的副产品，非 payload 传递服务；>2KB 走 evidenceRef）
- 不执行副作用工作（checks are probes，ADR 0004）
- 不替代 harness-v2 runtime lane（只做外挂 adapter，不侵入内核）
- 不对源系统特判（全部经 profile 模板 + check 抽象）
- 诊断/telemetry 后置，不进 MVP 目标
- 会话存储扫描约束：MVP 扫 JSONL（v3 custom_message / v4 custom agent message 双形态 + lane 信封字段透传 + 撕裂尾行容错）；**检测机制**：session-locator adapter 逐 session 探测（daemon 启动时 + 新 session 注册时，读 pi 配置的 storage backend + 会话文件形态），混合期（v3 JSONL 与 v4 SQLite 并存）按 session 分流，SQLite 在役则该 session 改 SQL 点查询；adapter 启动自检失败 → C1 降级路径

## Risks（2026-09-18 补，ddd-scope 校验清单要求）

- **集成（最大外部依赖风险）**：I9 两段式 ack 系于 transcript adapter 对 v3→v4 迁移中私有格式（custom_message → custom agent message、lane 信封）的识别——格式漂移直接破坏 verified 判定。缓解：adapter 双形态 + 启动自检 + C1 降级；harness-v2 迁移节奏盯 #27 双维度重启条件
- **一致性**：parked → SESSION_START drain 窗口内订阅者永久退场 → 事件永不兑现。缓解：dead-letter + reckon 对账
- **业务**：agent 习惯手写轮询，不主动 subscribe（行为假设，上线观测采纳率）
- **交付**：范围蔓延——从"感知"滑向"编排"（Non-goals 第 2 条是最大引力，演进预留 bg_* 集成时须重新裁定边界）

## Open questions（2026-09-18 按 #29 裁定清账）

已裁定关闭（详见 #29，v2 汇总 spec 展开实体章）：实体父子关系 = parent 字段（EntityRef key opaque，listChildren(parentRef) 查询）；作用域 = scope 字段 + key 前缀 external/project/user 双机制（前缀即单一事实源，subscribe scope 参数为按前缀过滤的视图）；订阅编址 = origin: session | auto + sourceSessionId；ProbeSpec = Specification 模式一等构造块（check 命令、fs-watch 谓词、GitLab 模板实例均为实现形态）。

仍开放：

- 进度型状态建模：已裁定暂缓（payload 预留）；恢复时机与阈值触发/采样率定义？（sharp，post-MVP）
- 自动订阅默认集：机制已裁定（origin: auto）；共享文档默认集（INTENTS/CONSTRAINTS/CONTEXT/RESOURCE/ENV）是否内置？（sharp）
- 文件监听残留：fs-watch 已裁定为 ProbeSpec 实现形态；push 源与 poll 源在 checker 层的统一接口实现（待后续票）？（sharp）
- /reckon command：注册方式、session id 启发式过滤、树形 TUI 展示？（sharp）
- 事件来源标记：已裁定 post-MVP（见 Constraints），正式方案与探测修正豁免规则届时再裁（unsharp，post-MVP）
- 派生订阅（子实体事件随父订阅）与事件风暴治理（unsharp，post-MVP）
- 全局 TUI notify 通道细节（pi extension api）（unsharp）
