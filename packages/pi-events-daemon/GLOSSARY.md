# pi-events-daemon — 领域术语表

实体状态机事件守护进程：实体镜像外部系统，转换作为副产品产生事件，session 订阅后被唤醒。正典 spec：GitHub #31（取代 prototype 期的 #26/#29）；实现票：#71–#111。本表是该包唯一术语正典——prototype-events-daemon/GLOSSARY.md 是前身副本（历史参照，不再演进）。

## Language

### 实体模型

**Entity（实体）**:
外部系统（或本地资产）中一件事物的持久镜像，由 EntityRef 标识，携带封闭状态集内的一个状态与 payload。最富聚合的聚合根；其状态是转换事件的纯归约。
_Avoid_: resource, object, topic（topic 仅是内部路由键）

**EntityRef**:
实体身份：源系统原生标识符（GitLab/GitHub 页面 URL、k8s REST URL、镜像 transport ref、本地路径）加 key 前缀 `external/`/`project/`/`user/`。Agent 从不铸造或解析它们；由 key generator 生成。
_Avoid_: id, uuid, entity-id

**entityRef wire 形态**:
`type:key` 全串（如 `gitlab:mr:project/<url>`）。跨 op 传输的正典形态；status op 的拆字段形态（type/key 分传）并存。（2026-10-19 类型统一收敛裁定）

**Payload**:
解释实体*当前*状态的属性——绝无历史、绝无大文本。其身份字段（digest、metadata.uid、contentHash）驱动自转换。
_Avoid_: metadata, data, body

**State（状态）**:
profile 定义的实体封闭状态集中的一个成员。首个 verdict 到达前为 null——不存在合成的"未探测"前状态。与 progress 值（刻意不算状态）、与 Delivery state（kernel 定义的簿记状态）相对。
_Avoid_: status（与 `status()` 登记写 op 撞名；读侧走 `query`）, phase

**Transition（转换）**:
实体的一次状态变更，与恰好一个事件在同一事务内提交（不变量 I1）。

**Self-transition（自转换）**:
状态不变但内容身份变化的转换——(state, contentIdentity) 才是真实的对。镜像 digest 变化或文件内容变化在状态不变时也发出事件。

**Content identity（内容身份）**:
仅凭其变化就足以正当化一个事件的 payload 字段：镜像 digest、文件内容 hash、配置修订号。

**Transitioned（事件族）**:
唯一事件族名（单一事件族裁定）：eventSeq 全局单调、EntityRef、from、to、contentIdentity、occurredAt、evidenceRef。无 per-state 事件类型；自转换同族。实现事件 id = `deterministicEventId(ref, decisionOrder)`（内容派生方案废弃：occurredAt 参与导致重放幂等失效）。
_Avoid_: event type（没有类型，只有族）

**Ephemeral entity（临时实体）**:
由一条 ad-hoc 条件催生、无外部身份的实体（key = check + schedule + cwd 的 daemon 铸 sha1），到达终态后退役。设计上短命。
_Avoid_: temporary entity, ad-hoc watch

**Persistent entity（持久实体）**:
镜像真实外部对象或长寿资产的实体，无订阅者也持续存在。缺省形态；仅在区分有必要时才说 ephemeral。

### 探测与订阅

**ProbeSpec**:
完整描述"如何对一个实体求值一个条件"的值对象（check 命令、source、schedule、thresholds、envAllowlist）。check 命令文本是其组件之一；checker 是执行它的原语。ProbeSpec 相同的两个订阅共享一个 runner（I5）。
_Avoid_: watcher, monitor, poller

**Schedule**:
ProbeSpec 的时间维度：`{ type: "interval", intervalMs }` 或 `{ type: "cron", cron, tz? }`。属模板资产——agent 从不在 subscribe opts 里设置（B1 裁定）；MVP 的 cron/interval 全 UTC（tz 字段保留未消费）。

**Subscription（订阅）**:
持有一个 agent 对一个实体的常设兴趣的聚合：open/re-arm/cancel 生命周期、per-leg、check 变化时关旧开新可替换。幂等比较域 = check/on/once/flip/readyCheck/ttl/origin/scope（thresholds 是槽级先建者定，不入比较域）。
_Avoid_: topic subscription, listener（注册永远经 daemon，绝无 pub/sub topic 面）

**Runner slot**:
一个 fetch key（EntityRef, template）的运行时执行器——持 run ledger 与引用计数；首个订阅创建，最后一个关闭销毁；非持久（daemon 重启自订阅重建）。
_Avoid_: worker, probe instance, runner pool

**Checker**:
probe 执行的 shell 级原语，产出三态语义 verdict（**passed / failed / waiting**——#31 正典语义名；退出码 0=passed、2=waiting、其他=failed）加 evidence。
_Avoid_: script, command

**Evidence ref（evidence 指针）**:
probe evidence 的可寻址指针，L1 回流处（loops）落盘时铸造：`ev:<内容 sha256 前 16 hex>` 内容寻址——同 probe 结果重放同 ref，upsert 幂等不重复行。翻转沿事件旁车携带；evidence op 按 ref 精确读（点查），billboard 截断指针形态的 ref = notificationId。保留期归 L4（passed 7d / 其余 30d）。（票 47，2026-10-19 收口）
_Avoid_: evidence id（铸造方是内容哈希，非序号）, log

**envAllowlist**:
订阅/模板显式追加的 checker 环境变量白名单（默认 PATH/HOME/no_proxy 之上合并）。凭据纪律：敏感凭据首选文件路径，allowlist 只用于非敏感运行时标识符；smoke 路径不开放。（2026-10-19 生产反馈裁定）

### 投递

**Delivery**:
一条通知到一个 session 的旅程，单行聚合：pending → accepted（session 在线重试）→ verified，或 parked（session 已关，等 SESSION_START drain）→ verified；出口 failed / dead-letter。每 (notification, session) 恰一行——I10。verified 判定 = 确定性 notificationId 出现在 session transcript（I9）。
_Avoid_: message, push

**Delivery state**:
kernel 定义的固定封闭簿记状态集：pending | accepted | parked | verified | failed | dead-letter。非 profile 定义，且从不产生事件（只有实体转换产生事件）。
_Avoid_: delivery status

**dead-letter**:
终态 = 系统不再自动重试，**且不参与 drain**（D2a 裁定——drain 只投 parked）。出口 = reckon 对账 + query 查看 + 24h verified-absence 幂等 re-push，无其他复活路径。同 key 锁死时换 check 内容变 hash 绕过是设计行为。

**Notification**:
值对象而非聚合：一个命中事件被推送的内容（确定性 notificationId + billboard 视图）。一个 notification 扇出为多个 Delivery。
_Avoid_: notice, alert

**epoch**:
daemon 代的单调标识（pidfile+flock 单实例仲裁 + I12 投递所有权防僵尸 daemon 误投）。socket 旁车 `pi-events.sock.epoch` 随换代更新；客户端连接必须携带当前 epoch。

### 呈现

**Footer status（footer 状态位）**:
extension 在 pi footer 的常驻状态位 `setStatus("pi-events")`，只显示 daemon 存活，无更多状态（订阅明细归票 45 dock）。三态对齐 herdr indicators 视觉语法：`● pi-events running` / `○ pi-events idle`（socket 不存在=未启动，首操作自动拉起） / `✗ pi-events down`（socket 在但连接失败）。零副作用探测：session_start 只读 socket+一次握手，不 spawn daemon（惰性拉起语义不变）。沿驱动刷新：session_start 探测、op 副作用（成功/业务错误=running，传输失败按 socket 存在性归类）、wake 连接沿；同态不重绘。降级 notify 去重：每次断供只通知一次，恢复复位。（票 46，#111）
_Avoid_: daemon health check（不是轮询健康检查，是沿驱动状态位）, footer polling

### 角色

**Profile**:
per-entity-type 领域知识层：状态机定义、payload schema、key generator（URL 解析/规范化）、探测模板。daemon kernel 零领域知识。
_Avoid_: plugin, provider, adapter（adapter 指 session-locator adapter）

**Session-locator adapter**:
唯一知道 pi 如何持久化 session 的模块（今天：JSONL transcript 与 `custom_message` 条目）。

**TxOps**:
Store 接口的共享事务原语单点声明面（票 41）：15 个原语一次声明，acceptedDeliveries 重复清理内聚。读侧/写侧实现共享同一声明。
_Avoid_: tx helper（不是工具函数，是接口面）
