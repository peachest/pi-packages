# store.db 调试指针 — 落库排查入口

排 daemon 订阅/投递问题时的第一站：直接读 SQLite store，绕过 op 面。本页只记
**路径、表结构关键列、已知脏数据形态**；协议语义见 op.schema.json 与 ADR。

## 存储位置

- 库文件：`~/.pi/data/pi-events/store.db`（WAL 模式，旁边 `-wal`/`-shm`）
- 只读打开：`sqlite3 "file:$HOME/.pi/data/pi-events/store.db?mode=ro"`（本机无 sqlite3
  CLI 时用 `python3` 的 sqlite3 模块，同样带 `?mode=ro` URI）
- daemon 进程：`~/.pi/run/pi-events.sock`（epoch 旁车 `.epoch`）、日志 `~/.pi/run/pi-events-daemon.log`

## subscriptions 表关键列

| 列 | 语义 |
|---|---|
| `session_id` | wake 编址 + dock 过滤键；**必须**是 pi session UUID（#190 闸门执法） |
| `closed_at` / `closed_reason` | null = 开放订阅；reason 常见 `once-passed`/`cancelled`/`ttl`/`failed-terminal` |
| `entity_ref_type` / `entity_ref_key` | 目标实体（`type` + `key` 两列拆分） |
| `check_name` | 探针命令文本（ad-hoc 形态的实体键即其 sha1） |

常用查询——查某 session 的开放订阅：

```sql
SELECT subscription_id, entity_ref_key, closed_reason FROM subscriptions
WHERE session_id = '<uuid>' AND closed_at IS NULL;
```

## 已知脏数据形态（#189 前的历史遗留）

`session_id` 出现以下值即僵尸订阅（wake 永不投递、dock 永不计入），直接 cancel：

- `''`（空串）——客户端缺省注入漏（extension 票 136 缺口，sub-0301/0302 及 10-19/20 的 sub-00xx）
- `'current'`——agent 猜测的字面量（sub-0296）

两形态已被 #190 闸门（op-dispatch sessionId UUID 形状执法）在创建时拦截；
存量僵尸已于 2026-10-28 清理。若再现，先查客户端注入面（extension live 并入 /
transport 连接声明）是否回归。
