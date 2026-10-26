# Bash Guards

Pi 全局行为守卫（kendex hook 脚本包）——把 session 挖掘出的「绝不规则」在工具调用层强制执行：每条 bash 命令先经守卫裁决，危险命令在执行前被拦截并给出正确替代。

本包域语言围绕三个概念分层：**命令位置**（引擎解析什么）、**Guard 规则**（规则怎么声明）、**Verdict**（裁决怎么表达）。架构重构（统一解析入口 + 声明式规则表，spec 137 审定）以此词汇为准。

## Language

**Command position**:
命令文本中"实际会执行的命令"所在的位置。一条 payload 经归一化后是段（segment）的序列；规则只在 command position 上匹配，绝不全文扫描。归一化包括：rtk 前缀剥离、secret-store 注入剥离、注释行剔除、heredoc 正文豁免、复合关键字剥离（if/while/! 等）、env/command/nohup 透明前缀剥离、引号感知切分、`-C` 与 cd 段的 cwd 状态跟踪。
_Avoid_: full-text match, substring scan, 整条命令匹配

**Segment**:
命令文本按分隔符（`|;()&`，引号外）切分后的最小执行单元，携带其前置分隔符（子 shell 深度由括号分隔符推算）与滚动 cwd。解析器产出的核心数据；规则的 matcher 消费它。
_Avoid_: line, command string, chunk

**Linked worktree**:
`.git` 为**文件**的检出（git worktree 机制），区别于主检出（`.git` 为目录）。跨分支移动在 linked worktree 内被拦截（走 `wt switch`），在主检出放行——判定依据是 `.git` 的形态，不是路径。
_Avoid_: worktree checkout（歧义：主检出也是 worktree）

**Guard 规则**:
一条可独立裁决的行为约束，声明为规则表条目：`{id, scope, matcher, message}`。matcher 是 regex 或谓词函数（多态）；message 是含三要素（原因 + 正确替代命令 + 示例/出口）的模板。新规则 = 加一个表条目，不改引擎。
_Avoid_: check, hook script, 拦截逻辑

**Verdict**:
一次裁决的终态，遵守 Claude Code hook 约定：exit 0 = 放行；exit 2 + stderr = 拦截且 stderr 即给模型的理由。解析失败一律 exit 0（fail-open）——守卫自己的 bug 不许变成对所有命令的封锁。
_Avoid_: block/allow 布尔（丢失理由通道）, exit code 裸数字语义

**Fail-open**:
守卫无法得出结论时放行并留痕，与 fail-closed 相对。适用于：payload 不可解析、subprocess 探测异常、未知 remote 平台。红线：fail-open 永不适用于"解析成功且规则命中"的场景。
_Avoid_: 静默放行（无留痕的 fail-open 是 bug 不是策略）

**Guard-override**:
命令文本内 `# guard-override: <理由>` 注释标记，显式绕过全部守卫，stderr 留审计痕。仅真注释位置生效（引号字符串/参数内的标记不认）。用途限定应急抢救（如 worktrunk 工具不可用需 bash 应急）。
_Avoid_: -f/--force 语义混淆（那是 git 自身的），禁用词式豁免

**Fixture suite**:
表驱动回归测试：一个 .sh 文件含自报数的用例序列（给定命令 payload → 断言 exit code 与 stderr 要点），由 vitest spawn 执行并断言零失败。三套件：A（全局规则）、B（P6 身份矩阵）、C（worktree 生命周期 + 绕过回归）。新守卫规则必须先在 fixture 里红。
_Avoid_: unit test（fixtures 是行为级黑盒，非函数级）

**Session 挖掘**:
规则的证据来源流程：从 pi session 日志统计某反模式的真实调用频次（calls/sessions 数），作为规则存在的依据写入注释与 README。没有挖掘证据的规则不许进表。
_Avoid_: 拍脑袋规则, best practice 引用（无本机数据支撑的）
