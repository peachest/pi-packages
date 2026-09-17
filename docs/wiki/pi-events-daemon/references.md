# references — 研究对象与证据索引

每个对象：读什么、关键证据在哪、对本设计给了什么。按被研究的先后排序。

## 1. bg_run / pi-background-tasks（起点：为什么不满足需求）

- 位置: `~/.pi/agent/npm/node_modules/pi-background-tasks/`（docs 为 authored，先读 docs 再读 src）
- 关键文档: `docs/subsystems/background-task-runtime.md`、`docs/concepts/completion-delivery.md`、`docs/tools/bg_logs.md`
- 关键证据: 通知投递链 `src/extension.ts:219`（notified 先置 true）、`agent-session.js:2011-2016`（rejection 吞掉）、`agent-session.js:1099-1138`（四分支仅 idle 立即落盘）、`registry.ts:2292-2293`（notified 永不纠正）
- 结构性缺口: 事件只有"进程退出"、session-scoped（关闭即杀）、无跨 session、无判定语义
- 给了: durable 投递铁律的反面教材；output+metadata 文件模式（daemon 参考其形态）

## 2. pi-poll（仓库内的直接前身）

- 位置: `packages/pi-poll/`（CONTEXT.md 是最好的入口）
- 关键决策: check = shell 命令单一原语（拒绝类型化 port/file/http 快捷原语）；返回 last check output 作证据
- 局限: 前台阻塞、无通知唤醒、无跨 session
- 给了: 判定器契约的骨架（exit 0 = ready）；"HTTP 用 curl -sf 表达"的既有裁定

## 3. pi-subagents（生态内最接近的投递实现）

- 位置: `~/.pi/agent/npm/node_modules/pi-subagents/`（docs/ 与 src/ 同读）
- 关键证据: `src/runs/background/notify.ts:1-4`（"事件总线只是观察通道"）、`notify.ts` deliver()（所有权+epoch、dedupe TTL）、`result-watcher.ts:574-581`（delete-after-ack + markDelivered）、`completion-batcher.ts`（成功项合流）、`docs/tool-reference.md:149-151`（steer 回执四态 + 相关性消费）
- 明文边界: "Async completions belong only to the originating session"（observability.md:291）；`pi.events` in-process only
- 给了: delete-after-ack 重试循环、dedupe/TTL、batcher 合流、failed 立即投——全部照抄；ack 终点需升级为两段式
- 另有: `schedule.create`（持久 schedule + catchUp latest/none）——离线补投的半个先例

## 4. context-mode（大 payload 指针化范式）

- 位置: `~/.pi/agent/npm/node_modules/context-mode/build/`
- 关键证据: `server.js` 常量 `INTENT_SEARCH_THRESHOLD = 5_000` / `LARGE_OUTPUT_THRESHOLD = 102_400`；ctx_execute 三层决策（~82036 行附近）；`store.js` FTS5 schema（porter + trigram 双虚表，UNINDEXED 列含 `event_id/session_id/timestamp`，`sources.content_hash` 做 staleness）
- 重要澄清: `pi.on("tool_result")` **不拦减 bash 输出**（只做事件统计入库）；拦截只在 ctx_\* 工具自身路径
- 不抄的部分: RRF + proximity rerank + Levenshtein 纠错（daemon 用 FTS5 自带 BM25 足够）
- 给了: evidence 阈值化（>2KB 指针化）+ `evidence()` 按需取全文 + `event_chunks` 表设计

## 5. controller-runtime（架构血统）

- 来源: k8s 社区设计（未读本地源码，凭既有知识 + T1 调研裁剪）
- 保留: 事件表（informer cache 的持久化形态）、订阅索引（indexer 降维成两张内存 Map）、workqueue 重试/去重、rate limiting（指数退避 2s→5min→dead-letter）、resync（重连 reconcile 一次，非周期）
- 跳过: informer/DeltaFIFO、SharedInformerFactory、leader election、metrics、CRD 机械
- 给了: level-trigger 评估 + edge-trigger 通知语义（P-006 的理论根据）

## 6. herdr（session↔daemon 通信先例）

- 位置: `~/.pi/agent/extensions/herdr-agent-state.ts`（herdr 自动安装）、`packages/pi-herdr-tab-rename/`、skill `~/.pi/agent/skills/herdr/SKILL.md`
- 关键证据: env 发现三件套（`HERDR_ENV`/`HERDR_SOCKET_PATH`/`HERDR_PANE_ID`）、JSON-RPC 单行 `{id, method, params}\n`、每请求短连接 + 两次重试（500ms/1500ms）、`withSessionRef`（session 路径/id 随行）
- 下行真相: `herdr agent prompt` = **PTY 注入**（bracketed-paste + 编码 Enter），无消息通道；下行可靠性靠"5s 内必须观察到生命周期变化"
- 给了: `PI_EVENTS_SOCK` env 发现模式、JSON-RPC 基座、session 身份随行——上行照抄，下行反面教材
- 相关用户研究: `~/research/agent-terminals/herdr.md`、`~/research/.pi-subagents/artifacts/outputs/82f83ce9/vscode-agent/pi-architecture-research.md`（pi 原生 steer/followUp/nextTurn 三通道，L137/L623）

## 7. nemo-relay（唯一独立 daemon 先例）

- 证据: `~/.config/nemo-relay/`（config.toml/bootstrap/daemon）、端口绑定锁
- 给了: 手动启动模式的对照（被惰性拉起裁定否定）；unix socket + 锁的可行性背书

## 8. 实测 session 证据（问题的原始形态）

- speculative-training 3 session（2026-09-15/16/17）：65 次 bg_run、29 次纯等待包装、6 轮 relaunch、`wait_glm51.sh` 系手写 k8s probe（30s 轮询 phase+pod ready，exit 0/1/2 三态）、通知丢失 7/58
- 全量长任务扫描: `~/tmp/longtask-scan-v2.json`（6380 条，方法：toolCall/toolResult 时间戳配对 + 任务族正则；跨天弃置 >2h 需单独分桶，30 例）
- k8s 三态 probe 先例: sglang-testing-framework 领域词汇表（sglang-slo-analysis session 2026-08-17，Startup/Liveness/Readiness + pass/fail/waiting）

## 9. 本项目工件

- wayfinder map: GitHub [#16](https://github.com/peachest/pi-packages/issues/16)（已关 #17/#18/#19/#21；前沿剩 #20 GitLab 判定器）
- intent: `intent/pi-events-daemon.md`（c5c327e+）
- 原型: `packages/prototype-events-daemon/`（index.ts 300 行 + 9 场景测试）
- 决议图: `~/tmp/pi-events-daemon-architecture.html`
- 长任务挖掘脚本: 本 wiki logs.md 记录的可复用扫描法（toolCall/toolResult 配对 + 时间戳双格式解析）
