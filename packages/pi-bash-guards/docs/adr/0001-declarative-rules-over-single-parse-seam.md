# Guard rules are declarative table entries over a single parse seam

十六条守卫规则全部声明为规则表条目（`{id, scope, matcher, message}`），消费**唯一**的解析 seam（segments/pairs 双函数），而非各自内联解析逻辑。matcher 多态：简单规则用 regex 串，需要状态的规则（R3 cwd 跟踪、G1 argv 级 dest 判定、P6 探测链）用谓词函数——数据与谓词的边界按"是否需要解析器之外的上下文"划，不按规则新旧划。

这个 ADR 固化的是两轮 rolling review（35 条 findings，解析器类占 ~55%）换来的教训：此前同一"命令位置"归一化模型存在四个漂移变体（行切分/内联 re.split/_wt_pairs 全套/全文正则），每个绕过修复都修在调用点而非引擎，修完后旧变体继续产出同类 bug（heredoc 正文误拦三处、引号绕过、-C 与子目录逃逸）。统一入口后引擎层修复一次生效，新规则的成本收敛为"选 matcher + 写文案"。

Rejected alternatives:
- **多文件物理拆分（parse.py/rules.py + install 期拼装回单文件）**：运行时收益为零——kendex 注册链、install.sh、fixtures 全部只认单文件，拼装是纯仪式；单文件内 `# ═══ 分区 ═══` 达成同等导航性。
- **bash 脚本形态保留（python heredoc 内嵌）**：bash 壳只做 `read payload`，纯历史层；纯 python 单文件少一个进程/调用、少一层 heredoc 转义，且 fixtures 的 `GUARD` env 指向机制对文件类型无感知。
- **只数据化 8 条简单规则、4 条复杂规则留散文**：数据/谓词二分是假边界——matcher 多态下全部进表，"加规则只加一行"才完整成立；留散文的规则会重新长出绕过变体。

回退预案：金输出比对（重构前旧引擎对全部 fixture 输入的 verdict 逐条存档，新引擎逐条 diff exit code 与 stderr 要点）保证切换无语义漂移；verdict 协议（exit 2 + stderr / fail-open）不变，kendex 与 pi-hooks 无感知。
