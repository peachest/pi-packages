# pi-secret-store

Pi 扩展：持久化凭证存储，双层语义——

1. **供给正道**：`secret_ensure`（TUI 掩码弹窗录入，agent 与 session log 全程无明文）/ `secret_query`（存在性查询，精确+子序列模糊匹配，永不含明文）/ `secret_env`（全量变量名清单）。凭证存 `~/.pi/agent/secret-store.json`（0600，tmp+rename 原子写），同步生成 `~/.pi/agent/secret-store.env` 供 bash source——扩展给 bash 命令注入 source 前缀（原地 mutate `event.input.command`），agent 在 bash 里直接引用 `$NAME` 拿到明文而 transcript 拿不到。
2. **泄漏执法（P1 凭证检测）**：拦含明文凭证 token 的 bash 命令（20 族前缀：glpat-/ghp_/sk-/AIza/AKIA/LTAI/…），报错文案含平台名+指纹前 8 字符+轮换 URL，并互指 `secret_ensure`。白名单：`$`/`{` 前缀的 shell 变量引用与占位值（dummy/fake/example/…）。迁自 `~/.pi/agent/kendex/hooks/bash-guards.sh` P1 段（检测先于 env 注入执行，故 hook 的 marker 剥离逻辑无需迁移）。

另有 `tool_result` + `context` 双层挂 Redactor：已存明文出现在工具输出或上下文消息中时替换为 `[REDACTED]`。存储 guard 拦 agent 读 `secret-store.json`/`secret-store.env` 本身，引导用 `secret_query`。`/secret-store` 命令：list（缺省）/ `forget <name>`。

范围边界（map #123 决策③）：不做保护区（不拦 dotfiles 读取）；不做轮换/历史清洗。

## 威胁模型与已知边界

**防护目标**：agent 上下文与 session log 无明文（存储 0600、agent 只见存在性/指纹、输出经 Redactor）。非同机对手模型——不防御已获本机执行权的攻击者。

已知边界（均为 r3 review 发现，超出威胁模型不修）：

1. **注入与 source 非同一事务**：跨 session 写入瞬间存在竞态窗口（注入前重读 store 已尽量缩窗，残余窗口扩展侧无法根除）。
2. **文件工具 guard 为解析路径比对**：symlink 间接寻址不拦（能在 agent 目录内建 symlink = 已有本机执行权，超出威胁模型）。
3. **锁协议 10s stale 抢占**：对 SIGSTOP 持锁者非安全（同机对手模型；mutator 窗口毫秒级，实际风险可忽略）。
4. **updateStore 两阶段提交**：极端磁盘故障下 json/env 可能短暂不一致（重启 session_start 修复）。

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
