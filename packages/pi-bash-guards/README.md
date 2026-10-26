# pi-bash-guards

Pi 全局行为守卫（kendex hook 脚本包）——把 session 挖掘出的「绝不规则」在工具层强制执行。纯 python 单文件引擎（spec #142：PARSER/RULES/MESSAGES 三分区 + 声明式规则表，见 `docs/adr/0001`），无 TS 扩展入口（`pi` manifest 字段省略）。

## 用途

注册为 pi-hooks 的 `tool_call` listener（matcher `Bash`）后，每条 bash 命令先经守卫裁决：exit 2 + stderr 阻止该调用并给理由，exit 0 放行。守卫按 session cwd 分层：`~/projects` 下 session 额外启用 projects 组。

## Guards 一览（每条一行 + 证据指针）

| Guard（规则表 id） | 范围 | 规则 | 证据 |
|---|---|---|---|
| bare-cd | 全局 | 整条命令只有 `cd`（无后续动作）→ 提示合并 | 2026-09-15 挖掘 49 calls/38 sessions |
| docker | 全局 | docker 命令位置 → 改 `sudo nerdctl`（本节点容器管理规范） | 353 calls/77 sessions |
| worktree-add | 全局 | `git worktree add` → 改 `wt switch -c`（worktrunk 统一管理）**〔全文匹配债，见已知债〕** | 139 calls/63 sessions |
| R1 删树/剪枝 | 全局 | `git worktree remove/prune`（命令位置锚定）→ 改 `wt remove`（wt 拒删 session 脚下的树） | MR !688 HAMi 清场；2026-10-21 fix-eda-scan-fixes（bash 自删 cwd → spawn ENOENT 卡死 2h） |
| R2 合并 | 全局 | `git merge`（非 `--ff-only` 语义）→ 个人仓改 `wt merge`、远端已合场景改 `git pull --ff-only`；`git pull` 全家族与 `merge --abort/--continue/--quit` 放行 | spec #137 三条正典路径 |
| R3 跨分支 | wt 布局 linked worktree（`~/projects/<repo>-<slug>`，`.git` 为**文件**） | `git checkout/switch <branch>` → 改 `wt switch`（随 checkout 迁移 session）；主检出（`.git` 为目录）不受影响，`checkout -- <path>`、`checkout <rev> -- <path>`、`-b/-B/-c/-C/--orphan` 本树新建、完整 40 位 sha 物化、非 wt 布局自管树放行（#153） | 同 R1 事故类（session 滞留旧分支）；#153 ascend e932/e958/e960 |
| R4 wt merge 审批 | 全局 | `wt merge -y/--yes` → 阻（合并审批是用户决定，不归 agent） | AGENTS.md 审批约定（spec #137 user story 5） |
| no-verify | 全局 | `git commit/push --no-verify` → 阻止（绕过钩子需显式理由） | 17 calls/7 sessions |
| G1 手拷入 agent 目录 | 全局 | 手动复制文件进 `~/.pi/agent/{extensions,npm}` / `~/.agents/skills` → 用 `pi install`/skills 安装链 | 2026-10-20 四轮挖掘 |
| P2 git add -A | projects | `git add -A`/`git add .` → 逐文件显式 add **〔全文匹配债〕** | 250 calls（ppu 仓 AGENTS.md 同源） |
| P3 长 sleep | projects | `sleep` ≥60s → 改 pi-events-daemon 订阅或后台任务 **〔全文匹配债〕** | sleep 轮询四轮挖掘共识 |
| P6 commit 身份 | projects | `git commit` 的 user.email 必须匹配**任一 remote** 的平台（github→peachest/QQ 邮箱、transwarp→侯雨希/transwarp 邮箱；多 remote any-match；pushRemote/pushDefault 链解析；rtk 与 secret-store 注入前缀穿透） | P6 矩阵 29 用例（tests/fixtures/test-p6-multiremote.sh） |

P1（凭证指纹检测）已于 2026-10-20 迁入 [pi-secret-store](../pi-secret-store)（随包演进，方案 A），本包不再含 P1。

### 匹配位置约束（spec #137 教训）

R1/R2/R3/R4 只在**命令位置**锚定匹配（行首 token 序列，经 rtk/secret-store 前缀剥离、env/sudo 剥离、段切分），不做全文子串——全文匹配曾两次误拦 heredoc 文档正文（spec #137 创建过程实证）。heredoc 正文行整体豁免（正文是文档不是命令）。在文档里引用这些命令时改写措辞或 base64（R1 报错文案会提示）。拦截不允许绕过（#153 用户裁定）：文案里的替代命令即唯一出口，误拦走新挖掘修规则。

## 安装

```bash
pi install ./packages/pi-bash-guards   # 注册为 pi package（可追踪）
cd packages/pi-bash-guards && npm run sync   # 脚本落盘到 kendex/hooks + 校验注册表
```

`npm run sync`（= `bash scripts/install.sh`）做三件事：cp 包内 guard 引擎 → `~/.pi/agent/kendex/hooks/bash-guards.py`、校验 `hooks.json` 注册表条目存在（不代写——注册表由 pi-hooks 创建）、diff 校验逐字节一致。

首次接线（通常已存在）：hooks.json 需有 `tool_call` listener（matcher `"Bash"`，command `python3 <home>/.pi/agent/kendex/hooks/bash-guards.py`，timeout 10）。脚本变更即时生效，无需重启 session。

## 测试

```bash
cd packages/pi-bash-guards && npm test
```

vitest 包一层 spawn 跑三套原始 fixture（`tests/fixtures/*.sh` 原样保留，fixtures 经 `bash "$GUARD"` 调引擎——引擎首行 exec-polyglot 使纯 python 文件可被 bash 直调，spec #142），断言末行 `PASS=/FAIL=` 计数：

- Suite A（全局回归，46 用例）：bare-cd / docker / worktree / --no-verify / G1 / P2 / P3
- Suite B（P6 多 remote 矩阵，29 t-calls → 27 计数用例，1 对 re-judge 注释化）：身份解析链 / any-match 语义 / 降级路径
- Suite C（worktree 生命周期 R1-R4，95 用例，tests/fixtures/test-wt-lifecycle.sh）：R1/R2/R4 拦截+放行、R3 真实 main-vs-wt 布局 linked worktree 边界（git init + worktree add 构造 `.git` 文件/目录两态）、R3 豁免（40 位 sha 物化 ×2 / 非 wt 布局树 ×2 / wt 布局对照 ×1，#153）、rtk 前缀穿透、heredoc 正文不误拦回归（锁 spec #137 创建事故）

另有 2 个直接 payload 探针（docker 拦截 / ls 放行）守 sync 后的运行时行为，外加两组 spec #142 新增：三要素渲染断言（tests/messages.test.ts：15 条 verdict 消息逐条渲染并断言含推荐命令 token）与金输出回归（tests/golden.test.ts：重跑 tests/golden/capture.sh 并 diff 存档 tests/golden/verdicts.jsonl，248 条 verdict 逐字节一致，非空即语义漂移）。测试跑包内源码（`GUARD` 默认指 `scripts/bash-guards.py`），`npm run sync` 负责 parity。

## 与 packages/README.md 四规则的关系（纯脚本包适配说明）

四规则为 TS 扩展包设计，本包按精神适配：

1. **入口边界**：本包的"入口"是 `scripts/bash-guards.py`（运行时唯一被外部引用的文件）+ `scripts/install.sh`（唯一落盘通道）；tests/fixtures 原样保留不作为公共面。
2. **包内自由**：scripts/ 与 tests/ 内部组织不受限。
3. **测试走入口**：fixture 全部经 `GUARD` 指向包内源码执行，不引用 live 同步副本。
4. **无环**：单文件脚本，无依赖图。

## 证据链

四轮挖掘合成报告（hook-candidates）与历史备份原在 `~/tmp/hook-mining/`（易失），本包内 `tests/fixtures/` 为测试正本；挖掘方法论见 skills 仓 `in-progress/hook-me`。变更记录：见 git log 与脚本头注释。

## 已知债（spec#137 review 裁定 backlog，spec#142 迁移后状态）

- **全文匹配债（迁移后仍开放）**：worktree-add（规则表 id `worktree-add`，旧名 guard-3）、P2、P3 仍是全文正则，heredoc 正文/echo 字面量会误拦——语义随迁移原样保留（债随迁不随消，引擎内已逐条标注），修复 = 换到 segments() seam 上的独立专项。docker matcher 走 `code` 行扫描（heredoc 正文**不**豁免——现状行为，金输出锁定），同属全文类债。
- **P6 注释重复**：已随 spec#142 迁移合并为单块（顺带清理项完成）。
- **worktrunk 双注册债**：不受本包影响（pi-wt-lite 域）。
- 规则表 12 条目 → 15 verdict：no-verify/G1/P6 各携两条消息，其内部选择对段序敏感（拆成单消息规则会改变先触发哪条——金输出锁定），故保持单条目多消息。
