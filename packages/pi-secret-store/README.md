# pi-secret-store

Pi 扩展：持久化凭证存储，双层语义——

1. **供给正道**：`secret_ensure`（TUI 掩码弹窗录入，agent 与 session log 全程无明文）/ `secret_query`（存在性查询，精确+子序列模糊匹配，永不含明文）/ `secret_env`（全量变量名清单）。凭证经存储后端落盘（#173：缺省 age 密文，见下节）。扩展给 bash 命令做选择性注入（原地 mutate `event.input.command`）：解析命令文本中的 `$NAME`/`${NAME}` 引用，只 export 被引用且存在于 store 的变量（内存快照，逐变量 shell 单引号字面量），agent 在 bash 里直接引用 `$NAME` 拿到明文而 transcript 拿不到；无引用的命令无注入前缀，行为与无凭证库时完全一致。凭证可配 `allowedPrefix`（字符串数组，#171）：命令词（剥 sudo/env/nohup/`VAR=x` 赋值 token 后取第一个真命令词，r2；sh/bash 族 wrapper 的 `-c`/`-lc` 载荷递归取词，r3）命中任一前缀才注入该凭证，不命中则不注入并报错（含凭证名/限定前缀/实际比对命令词/secret_ensure 重设指引）；空数组/缺省 = 任意命令可用（与票1行为一致）。命令文本含已存值明文（无 `$NAME` 引用）时先机械回填为 `$NAME` 再走同一注入路径（#172；r3 #1 起替换仅限裸 token——引号字符串/heredoc 体等数据位命中不改写而是拦截报错，防静默篡改数据语义；反查源 = redactor 累积值，forget 后旧值仍回填，回填产物未存名则静默跳过）；P1 检测先于回填，已知格式 token 不因回填放行。`secret_query` 与 `/secret-store list` 呈现限定信息（存在性层面，不含值）。
2. **泄漏执法（P1 凭证检测）**：拦含明文凭证 token 的 bash 命令（20 族前缀：glpat-/ghp_/sk-/AIza/AKIA/LTAI/…），报错文案含平台名+指纹前 8 字符+轮换 URL，并互指 `secret_ensure`。白名单：`$`/`{` 前缀的 shell 变量引用与占位值（dummy/fake/example/…）。迁自 `~/.pi/agent/kendex/hooks/bash-guards.sh` P1 段（检测先于 env 注入执行，故 hook 的 marker 剥离逻辑无需迁移）。

另有 `tool_result` + `context` 双层挂 Redactor：已存明文出现在工具输出或上下文消息中时替换为 `[REDACTED]`。存储 guard 拦 agent 读存储正典文件（plain json / age 密文）与身份密钥本身（读密钥 = 绕过全部加密），引导用 `secret_query`；遗留 env 文件删除失败期间同样纳入保护（r3 #2，fail closed）。`/secret-store` 命令：list（缺省）/ `forget <name>`。

范围边界（map #123 决策③）：不做保护区（不拦 dotfiles 读取）；不做轮换/历史清洗。

## 存储后端（#173）

存储后端接口化（`lib/backend.ts`），磁盘正典可插拔：

- **age（缺省）**：密文 `~/.pi/agent/secret-store.json.age` + 身份密钥 `~/.pi/agent/secret-store.key`（0600，与密文分离）。session_start 经 `age -d -i` 解密进内存（注入/查询/脱敏全走内存快照，链路与 plain 一致）；写时 `age -r <pub>` 加密 tmp+rename 原子落盘。身份密钥首次不存在时零交互 `age-keygen` 自动生成（0600）；口令加密形态不做（后续可选）。首次检测到遗留明文 `secret-store.json` → 自动加密迁移为 `.age` 并 `shred -u` 原文件（迁移在扩展进程内存完成，agent 与上下文不经手明文）。
- **plain（兜底）**：#170 现行为原样（明文 json 0600），仅显式配置才用。
- **配置**：`~/.pi/agent/secret-store.conf` 单行 `backend = age` 或 `backend = plain`（`#` 注释行忽略）；缺省 age，非法值 fail closed 报错。
- **age 安装/检查**：从 [age releases](https://github.com/FiloSottile/age/releases) 下载并将 `age` 与 `age-keygen` 放入 `~/.local/bin`（或系统包管理器安装），验证：`~/.local/bin/age --version`。扩展解析顺序：`PI_SECRET_STORE_AGE_BIN` 环境变量（定向，不回退）→ `PATH` → `~/.local/bin/age`。
- **不静默降级**：age 二进制缺失 / 解密失败 / 错钥 / 损坏密文 → 显式报错（含安装指引与文件路径），凭证功能停用、密文不销毁；降级 plain 必须显式配置。

## 威胁模型与已知边界

**防护目标**：明文不进 session log 与上下文——session log 落盘的是 mutate 前原始 command（已实跑验证），mutate 后含明文的 command 文本仅存在于单次执行进程内；存储 0600、agent 只见存在性/指纹、输出经 Redactor。非同机对手模型——不防御已获本机执行权的攻击者。已知窄缝：若 bash 工具未来在报错时回显完整命令，注入前缀可能进 tool_result（当前不回显，理论路径）。

已知边界（r2 #170 起注入改走内存快照，原「注入与 source 非同一事务」竞态整类消失）：

0. **age 后端不防本机攻击者（#173）**：密钥与密文同机，已获本机执行权（或本机 root）的攻击者可直接读身份密钥解密——age 后端缩的是密文文件/备份/同步盘泄漏面（磁盘只剩密文+密钥两个 0600 文件，原明文 shred 删除），不是对抗本机攻击者的边界。密钥文件被 guard 拦截 agent 读取，但对绕过 agent 的本机进程无效。

1. **选择注入缩半径不防外显**：按命令文本引用集注入（仅裸 `$NAME` 与纯 `${NAME}` 计入；`${NAME:-def}` 等展开式形态不计——命令不消费真实值时不注入真值；文本级扫描，单引号内的 `$NAME` 同样计入——不展开，多注入只是环境多一个未用变量，无行为影响）；agent 主动 `echo $NAME` 等外显行为照常注入不拦，`$NAME` 外显不防（外显策略见 #169）。
2. **文件工具 guard 为解析路径比对**：symlink 间接寻址不拦（能在 agent 目录内建 symlink = 已有本机执行权，超出威胁模型）。
3. **锁协议 10s stale 抢占**：对 SIGSTOP 持锁者非安全（同机对手模型；mutator 窗口毫秒级，实际风险可忽略）。

## 结构

- `index.ts` — 唯一入口，default export 工厂（2 钩子注入/脱敏 + session_start 重载 + 3 工具 + 1 命令）
- `lib/backend.ts` — 存储后端接口化（#173）：age/plain 实现、遗留明文迁移+shred、conf 选择、updateStore 锁协议
- `lib/store.ts` — plain 存储原语：0600/唯一 tmp+rename/损坏 JSON 容错/跨进程锁
- `lib/credentials.ts` — P1 TOKEN_TABLE 20 族 + 白名单 + 报错文案
- `lib/redact.ts` — Redactor（vendor 自 pi-secret-drop 0.1.6，单遍交替正则改写+编译缓存 r3 #4；回填边界/数据位扫描 r3 #1）
- `lib/secret-input.ts` — SecretInput 掩码弹窗（vendor 同上；非 TUI 环境 secret_ensure throw 引导，不静默跳过）
- `tests/` — 走入口 import（vitest）

## 测试

```bash
npm test        # 本包目录内
```
