# pi-secret-store

Pi 扩展：持久化凭证存储，双层语义——

1. **供给正道**：`secret_ensure`（TUI 掩码弹窗录入，agent 与 session log 全程无明文）/ `secret_query`（存在性查询，精确+子序列模糊匹配，永不含明文）/ `secret_env`（全量变量名清单）。凭证存 `~/.pi/agent/secret-store.json`（0600，tmp+rename 原子写）。扩展给 bash 命令做选择性注入（原地 mutate `event.input.command`）：解析命令文本中的 `$NAME`/`${NAME}` 引用，只 export 被引用且存在于 store 的变量（内存快照，逐变量 shell 单引号字面量），agent 在 bash 里直接引用 `$NAME` 拿到明文而 transcript 拿不到；无引用的命令无注入前缀，行为与无凭证库时完全一致。
2. **泄漏执法（P1 凭证检测）**：拦含明文凭证 token 的 bash 命令（20 族前缀：glpat-/ghp_/sk-/AIza/AKIA/LTAI/…），报错文案含平台名+指纹前 8 字符+轮换 URL，并互指 `secret_ensure`。白名单：`$`/`{` 前缀的 shell 变量引用与占位值（dummy/fake/example/…）。迁自 `~/.pi/agent/kendex/hooks/bash-guards.sh` P1 段（检测先于 env 注入执行，故 hook 的 marker 剥离逻辑无需迁移）。

另有 `tool_result` + `context` 双层挂 Redactor：已存明文出现在工具输出或上下文消息中时替换为 `[REDACTED]`。存储 guard 拦 agent 读 `secret-store.json` 本身，引导用 `secret_query`。`/secret-store` 命令：list（缺省）/ `forget <name>`。

范围边界（map #123 决策③）：不做保护区（不拦 dotfiles 读取）；不做轮换/历史清洗。

## 威胁模型与已知边界

**防护目标**：agent 上下文与 session log 无明文（存储 0600、agent 只见存在性/指纹、输出经 Redactor）。非同机对手模型——不防御已获本机执行权的攻击者。

已知边界（r2 #170 起注入改走内存快照，原「注入与 source 非同一事务」竞态整类消失）：

1. **选择注入缩半径不防外显**：按命令文本 `$NAME` 引用集注入（文本级扫描，单引号内的 `$NAME` 同样计入——不展开，多注入只是环境多一个未用变量，无行为影响）；agent 主动 `echo $NAME` 等外显行为照常注入不拦（外显策略另票）。
2. **文件工具 guard 为解析路径比对**：symlink 间接寻址不拦（能在 agent 目录内建 symlink = 已有本机执行权，超出威胁模型）。
3. **锁协议 10s stale 抢占**：对 SIGSTOP 持锁者非安全（同机对手模型；mutator 窗口毫秒级，实际风险可忽略）。

## 结构

- `index.ts` — 唯一入口，default export 工厂（2 钩子注入/脱敏 + session_start 重载 + 3 工具 + 1 命令）
- `lib/store.ts` — 存储 0600/原子写/损坏 JSON 容错
- `lib/credentials.ts` — P1 TOKEN_TABLE 20 族 + 白名单 + 报错文案
- `lib/redact.ts` — Redactor（vendor 自 pi-secret-drop 0.1.6，单遍交替正则改写，行为不变）
- `lib/secret-input.ts` — SecretInput 掩码弹窗（vendor 同上；非 TUI 环境 secret_ensure throw 引导，不静默跳过）
- `tests/` — 走入口 import（vitest）

## 测试

```bash
npm test        # 本包目录内
```
