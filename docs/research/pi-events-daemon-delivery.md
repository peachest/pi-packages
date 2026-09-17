---
source: wayfinder ticket peachest/pi-packages#17（T1 调研：跨 session 通知投递通道 + bg_run 丢通知根因）
delegate: glm53-flash-internal, run d57fc3265cbe05a4769a42947d3983d21, answer sha256 51944c8588313a6e0bfce6960088a279c9b3025262fecdb8c055caf6d6aa2aa7
date: 2026-09-17
---

I have enough evidence. Composing the report.

# T1 Research Report — Notification Delivery Channels, bg_run Loss Root Cause, controller-runtime Minimal Subset

## Q1 — Notification delivery channels in pi

Sources: `~/.pi/agent/npm/node_modules/pi-background-tasks/src/extension.ts`, `.../src/core/registry.ts`, `~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`, `docs/sdk.md`, `docs/rpc.md`, core `dist/core/agent-session.js`.

| # | Mechanism | Target session other than caller? | Ack? | Redeliver to offline session? | Evidence |
|---|-----------|---|---|---|---|
| 1 | `pi.sendMessage({customType, content, display, details}, {deliverAs: "steer"\|"followUp"\|"nextTurn", triggerTurn})` — injects a custom message that participates in LLM context; can trigger a follow-up agent turn | **No.** ExtensionAPI is bound per-session: `runner.js:162` wires `runtime.sendMessage` to one `AgentSession`; `agent-session.js:2011` → `this.sendCustomMessage` | **No.** Returns void; async rejection swallowed internally (see Q2) | **No.** Three of four paths are in-memory queues; nothing is persisted at enqueue time | docs/extensions.md:1416–1437; agent-session.js:1099–1128 |
| 2 | `pi.sendUserMessage(content, {deliverAs})` — user-visible message, always triggers a turn | No (same per-session binding) | No | No (same queue mechanics) | extensions.md:1439–1467; agent-session.js:1141+ |
| 3 | `pi.appendEntry(customType, data)` — **immediately persisted** custom entry via `sessionManager.appendCustomEntry` (agent-session.js:2022–2029); TUI-only, does NOT enter LLM context, does not trigger a turn | No | **Partial:** the synchronous append either succeeds (durable in session file) or throws — this is the only durable primitive | N/A — it is persistence, not delivery; a *reloaded* session re-reads entries on `session_start` (extensions.md:1480–1481), which is the only built-in "catch-up" mechanism | extensions.md:1471–1481 |
| 4 | `pi.events` event bus — `on/emit`, inter-extension, in-process | No | No | No (no persistence) | extensions.md:1729–1736 |
| 5 | `ctx.ui.notify(msg, level)` — TUI toast only, not persisted, no turn trigger | No | No | No | extension.ts:268, 387, 1024 |
| 6 | RPC mode (`pi --mode rpc`) — an external process drives a specific session over JSON: `sendUserMessage` with `"steer"`/`"followUp"` (rpc.md:62–63) | **Yes** — external caller picks the session | Partial: command success/failure returned, but no "entry persisted to transcript" ack | No — followUp queues in-memory; offline session = process not running at all | docs/rpc.md:60–67 |
| 7 | SDK `AgentSession.prompt/steer/followUp` (sdk.md:74–77, 214, 231) — programmatic embedding | Only sessions the embedding process owns | No | No | docs/sdk.md |
| 8 | herdr / peer-session bridges — external multiplexer types into another pane | Yes (out-of-band) | No | No — not a pi mechanism at all; zero pi-side durability | (multi-agent-collab skill, not pi core) |

**Nothing in pi's extension surface can target a session other than the caller.** Cross-session delivery today is only: (a) per-session RPC from an external process, (b) writing into another session's `.jsonl` file directly, or (c) SDK-embedded sessions. And **no channel has an ack or redelivery semantic** — the closest is `appendEntry`'s synchronous durable write plus re-read on session reload.

**Design implication for pi-events-daemon:**
- The daemon cannot be a normal in-session extension if it must notify sessions that aren't the caller. It must be an **out-of-process daemon** that delivers by one of: RPC per session, direct session-file append (`appendEntry`-shaped entry into the target `.jsonl`), or a small companion in-session extension that polls the daemon on `session_start` (replay). 
- The only ack pi gives you today is "entry exists in the session file" — which is exactly the ack definition already chosen. Build delivery as: daemon appends/pushes → verifier later reads the session file for the entry id → un-acked = redeliver on reconnect.
- `sendMessage`'s triggerTurn is worth keeping for the "wake idle session" UX, but it must be treated as **best-effort wake**, never as the delivery itself.

## Q2 — Root cause of bg_run notification loss

The notification path: `finalizeTask` → `notifyCompletion` (registry.ts:2291–2341) → `sendCompletionNotification` = `pi.sendMessage(message, {deliverAs: "followUp", triggerTurn})` (extension.ts:218–220) → `sendCustomMessage` (agent-session.js:1099).

**Root cause: `notified` is set true before delivery, and every async failure after that point is silently swallowed.** Three compounding code facts:

1. **Flag set before send** — `registry.ts:2293`: `task.notified = true;` executes *before* `sendCompletionNotification`. The only rollback is a **synchronous** throw inside the try (registry.ts:2327–2335).

2. **The send is fire-and-forget by construction** — extension.ts:219 calls `pi.sendMessage(message, options)` **without await/return of the promise**, and pi binds `sendMessage` as: `this.sendCustomMessage(message, options).catch((err) => runner.emitError({event: "send_message", error}))` (agent-session.js:2011–2016). The rejection is converted into an extension error event; the registry's try/catch can never see it. So any async failure leaves `notified: true` forever.

3. **Most delivery paths don't persist at enqueue time** — `sendCustomMessage` (agent-session.js:1099–1128) has four branches; only the idle+no-triggerTurn branch (`_appendCustomMessage`, agent-session.js:1133–1138) writes to the session file immediately. The bg_run path (`deliverAs: "followUp"` + `triggerTurn`):
   - session streaming → `this.agent.followUp(appMessage)` — **in-memory agent queue** (agent-session.js:1111–1113); `clearQueue()` on user abort empties it (agent-session.js:1191–1203, comment: "Useful for restoring to editor when user aborts") — never persisted.
   - session idle + triggerTurn → `await this._runAgentPrompt(appMessage)` (agent-session.js:1123) → `agent.prompt()`. The custom message is persisted **only when the agent loop emits its `message_end` event** (agent-session.js:390–394: `if (event.message.role === "custom") → appendCustomMessageEntry`). If the triggered turn is aborted (Esc), errors out (provider error, model/key unavailable after hours idle), or the session shuts down mid-turn, `message_end` for the custom message never fires → **no transcript entry**, while metadata already says `notified: true`.
   - `deliverAs: "nextTurn"` and the `_pendingCustomMessages` branch sit in in-memory arrays flushed only in `_runAgentPrompt`'s `finally` (agent-session.js:779–780) — session exit loses them.

4. **No recovery path**: on session restart the extension only shows a status-widget count of unseen finished tasks (extension.ts:264–290); the persisted `notified: true` flag (common.ts:768) suppresses any re-notify (registry.ts:2292 checks it on load).

**Most likely root cause for the 7 lost notifications:** the task completed while the session was idle or streaming; `notifyCompletion` flagged `notified: true` and handed off to `pi.sendMessage`; the resulting triggered turn (or queued followUp) **died before the custom message's `message_end` was emitted** — abort, provider error, or session shutdown/reload race — and the rejection was swallowed at agent-session.js:2012, so the metadata's `notified: true` was never corrected. (Compaction is not implicated: compaction only touches history context, not entry persistence.)

**Design implication for pi-events-daemon:**
- **Never mark delivered on send.** The only truth is the transcript: delivered ⇔ entry present in the target session file. Ack must be verified by reading, not assumed from API success.
- Persist the event + delivery attempt **before** the first send (write-ahead), and flip `delivered` only after ack verification — the inverse of registry.ts:2293.
- Treat all four `sendCustomMessage` branches as unreliable; the durable primitive is `appendEntry`/direct session-file append. Best design: daemon writes the notification entry durably into the target session file (or a per-session inbox the extension drains on `session_start` and `agent_end`), and optionally *additionally* calls RPC/`sendMessage` to wake an idle session — wake is an optimization, delivery is the file.
- A crash/shutdown mid-send must be recoverable: on daemon restart, rescan un-acked events (see Q3 resync).

## Q3 — controller-runtime minimal subset for a Node/TS single-process daemon

**Keep (trimmed):**

- **Event store (the informer's durable shadow, minus the machinery):** one append-only table (SQLite or JSONL) of events: `{eventId, type, payload, createdAt, deliveries: [{sessionId, attempts, nextAttemptAt, state: pending|delivered|failed|expired}]}`. Level-trigger truth: the *condition state* (e.g. "MR !123 merged") is separate from the *event stream* — a subscription re-evaluates current state on reconnect, so a missed event is recoverable from state, not just replay.
- **Subscription index:** `Map<subscriptionId, {check, interval, sessionId, ttl?, waitOnce?, createdAt}>` + reverse index `Map<sessionId, subscriptionId[]>`, rebuilt from the store on daemon start (the indexer idea reduced to two in-memory maps over a persisted table).
- **Delivery queue (workqueue trimmed):** a per-target-session FIFO of un-acked deliveries. In a single process you don't need the dirty-set/dedup hashing — the queue *is* the dedup: key deliveries by `(eventId, sessionId)` and upsert, so a re-fire collapses to one pending delivery.
- **Rate limiting / backoff per item:** workqueue's `AddRateLimited` ≈ exponential backoff with cap: `delay = min(base * 2^attempts + jitter, maxBackoff)`, e.g. base 2s, cap 5min, and a max attempts (say 10) after which the delivery goes to a dead-letter state (visible via daemon query tool, never silently dropped — that's the bug being fixed).
- **At-least-once + idempotent ack:** delivery attempt = write notification entry to target session (file append or RPC) → ack check = scheduled/passive verification that the entry exists in the session `.jsonl` (the ack definition already chosen). Idempotency: entry carries a deterministic `notificationId` (hash of eventId+sessionId); redelivery rewrites/references the same id, and the in-session companion extension dedupes by it, so a session that received but wasn't verified doesn't get a duplicate *turn trigger*.
- **Resync / reconcile on session reconnect (the resync period, event-driven instead of periodic):** on `session_start` (or daemon noticing the session file's mtime change), for each subscription of that session: ① re-evaluate current condition state against check (catches conditions that became true while unwatched), ② redeliver all `pending`/`failed` un-acked events, ③ expire subscriptions past `ttl`. One reconcile pass per reconnect, not a fixed resync interval — the k8s periodic resync exists because controllers can miss watch events; here the ack-scan on reconnect plays that role.
- **Single worker loop:** one `setTimeout`-driven scheduler ticks due items (checks to run, deliveries to (re)send, acks to verify). Sequential per session target preserves ordering; checks may run concurrently with a small concurrency cap.

**Skip (explicitly):**

- **Informer / watch cache / DeltaFIFO** — no API server; the daemon polls check commands directly.
- **Indexer / thread-safe store** — a single-process `Map` over a local table; no cross-goroutine consistency.
- **SharedInformerFactory & cross-controller informer sharing** — one daemon, one consumer.
- **Workqueue dirty set / processing set / deferred set as separate structures** — collapse into one queue with per-item state; the dedup key makes the sets redundant.
- **Leader election** — single machine, single instance (a pidfile/lock is enough).
- **Per-item exponential failure rate limiter per controller with `MaxOfRateLimiter`s composition** — one simple backoff function, capped.
- **Metrics/health endpoints, generated clientsets, CRD machinery, finalizers, ownerReferences/GC** — out of scope for MVP.
- **Event broad-cast via watch streams** — delivery is pull-on-reconnect + push-best-effort, per Q1/Q2.

**Design implication for pi-events-daemon:**
- The store is the source of truth; the queue is a rebuildable view. Daemon restart = reload store → rebuild index → rescan un-acked → resume. No in-memory-only state anywhere in the delivery path.
- Ack-by-verification (not ack-by-API-success) is the single most important divergence from bg_run, and it maps cleanly onto workqueue's `Forget` only after verified delivery.
- Keep the check evaluation stateless per tick (level-trigger): the subscription's `Done when` is re-derived from the world each interval, so crashes/missed ticks self-heal on the next tick — this is what makes "resync" nearly free.

---

## 附录（2026-09-17 追加）：pi-subagents 的异步通知链路对比

来源：`~/.pi/agent/npm/node_modules/pi-subagents/`（v0.68.0）`src/runs/background/{notify,result-watcher,completion-batcher,completion-dedupe}.ts`、`docs/observability.md`。

### 它做对了什么（bg_run 没做到的）

| 机制 | 实现 | 证据 |
|---|---|---|
| **result file = durable 真相，delete-after-ack** | async 子任务写 result 文件；watcher 监听；**只有 `sendMessage` 接受通知后才删除文件**，未接受则 100ms 重试循环（`scheduleResult(file, triggerTurn, RETRY_DELAY_MS)`） | notify.ts 头注释；result-watcher.ts:574-578 |
| **事件总线 ≠ 投递确认** | "The event bus remains an observation channel, not a delivery acknowledgement" | notify.ts:2-4 |
| **所有权绑定** | `ownsResult(sessionId, completionOwnerId, epoch)`，foreground session 不匹配直接拒绝投递 | notify.ts deliver() |
| **去重 + TTL** | `buildCompletionKey` + `markSeenWithTtl`，dedupe 键按 session/cwd | completion-dedupe.ts |
| **成功项合流批量投递** | "Successful sibling completions are held briefly and delivered as a quiet grouped completion"；failed/paused 立即立即投 | observability.md:291-296 |
| **投递状态落盘** | `markDeliveredNotification()` 先标记 result 文件再 unlink，状态机在文件上 | result-watcher.ts:581 |
| **steer 回执** | async 子进程走 file control inbox，回执四态 queued/delivered/missed/failed，且"报告子进程的相关性消费，不止 inbox 接受" | tool-reference.md:149-151 |

### 它仍然没做到的（正是 daemon 的差异化空间）

1. **ack 仍是 API 接受而非 transcript 验证**——`sendMessage` 返回 true 就删文件重试循环终止；而 T1 已证明 sendMessage 接受 ≠ 条目落盘（触发 turn 被 abort 时条目不写入）。pi-subagents 缩小了丢失窗口（失败会重试），但没有关闭它（accepted 后删除文件 → abort 场景无补救）。daemon 的 ack-by-verification 更严。
2. **只回 originating session**："Async completions belong only to the originating session"——无跨 session 订阅。
3. **生命周期绑死父进程**：`session_shutdown` dispose 全部 in-process child sessions；`pi.events` 明确文档化为 in-process only，跨进程只能走文件 artifacts 或 pi-intercom。
4. **无独立 daemon**：watcher/notify 全部活在父 pi 进程内，父进程死则链路死。

### 设计指令（并入 #19 实现参考）

- **复用** delete-after-ack 重试循环 + result 文件状态机 + dedupe/TTL + batcher 合流——这是生态内已验证的最近似实现
- **升级** ack 终点：accepted 只是"可以停止重试的信号"，最终 ack 仍以 transcript 验证为准（两段式：accepted→停止高频重试，verified→标记 delivered）
- 跨 session / 跨进程按既定协议走 socket + store，不走 pi.events
- pi-subagents 的 `schedule.create`（持久 schedule + catchUp latest/none）是"离线补投"的半个先例，实现 daemon reconcile 时可参考其 miss 补偿语义
