# logs — effort 运行日志（每次一行）

格式沿用 `~/skills/wiki/`：日期 | 做了什么 | 关键产出/教训。

- 2026-09-15 | pi-workflow 报告 §5.4 提出"中心化 daemon"设想（reckon 的下一站）| 记入 memory pi-events-daemon
- 2026-09-17 | 考古 speculative-training：65 次 bg_run 对账，29 次纯等待包装 + 6 轮 relaunch + wait 脚本三态实践 | 问题定形
- 2026-09-17 | 找回 sglang-slo-analysis 时代的 k8s 三态 probe 词汇表 | 判定器语义的种子
- 2026-09-17 | bg_run 实现研读（pi-background-tasks docs）| 三结构性缺口定案；intent 落盘 commit c4ec981/c5c327e
- 2026-09-17 | 通知丢失实锤：7/58 丢失，metadata notified:True 与 transcript 无条目矛盾 | 立项的直接量化证据
- 2026-09-17 | wayfinder 建图（map #16 + 4 票）| grilling 定案三态判定器/持久订阅/durable 投递
- 2026-09-17 | T1 调研（#17，bg_delegate 3 次尝试：abort×2 + turn limit×1 后放宽预算成功）| 丢通知根因钉到 file:line；controller-runtime 裁剪清单；关票
- 2026-09-17 | T5 调研（#21）：生态先例（仅 nemo-relay 独立 daemon）+ XDG 布局 | 用户裁定 .pi 根 + XDG 式相对布局；关票
- 2026-09-17 | #18 grilling 全轮（Q1-Q7）+ fork 实证（新 UUID）+ 三事件同至论证 | 全决议关票；决议图 HTML
- 2026-09-17 | 长任务全量挖掘：825 文件镜像/pip（1728 次前台 ~15h，通知丢失语境）→ 2461 文件全量（6380 条轨迹，跨天弃置 30 例）| 五类 check 抽象 + #19 场景 comment；挖掘法可复用（见 references.md §8）
- 2026-09-17 | pi-subagents 源码调研：delete-after-ack 模式 | 两段式 ack 终点确立；delivery 调研追加附录 a00f552
- 2026-09-17 | #19 原型三轮迭代（v0.1 边沿触发缺口 → v0.2 batch 窗口+failed 绕行 → v0.3 evidence 阈值化）9/9 绿 | 关票；7 操作定稿
- 2026-09-17 | context-mode 源码调研（阈值常量/FTS5 schema/tool_result 真相）| event_chunks 自有库设计；query 跨 session 裁定
- 2026-09-17 | wiki 建立（本目录）| 下一次站在已有知识之上
- 2026-09-17 | T4（#20）GitLab 判定器挖掘：310 文件 6008 条轨迹，两实例成功形态提取（差异在凭证引用/代理而非端点）；用户裁定模板参数化+零凭证逻辑 | 关票；数据 ~/tmp/gitlab-check-mining.json
- 2026-09-17 | T7（#23）telemetry+doctor 需求提出后整体撤销：store 即遥测、采集组件=新增长源、nemo-relay 类比不成立 | 关票进 Out of scope
- 2026-09-17 | T6（#22）三裁定：validate 独立 op+smoke 代跑；两阶段扁平参数；fail 即终态 | 关票——map destination 达成，待交 to-spec
- 2026-09-17 | T8（#24）branch 状态机：全自动链+CI 失败自动拉日志+弃置不处置+reckon 改造读 daemon | 关票——spec 范围再增状态面
- 2026-09-17 | T9（#25）状态建模通用化：泛化 schema+typed status op，MVP 仅 git-branch profile（用户裁定等调用数据再提取），不做状态机引擎 | 关票——状态面定稿
- 2026-09-17 | to-spec 产出 Spec #26（ready-for-agent）：seam=socket 集成（用户裁定）；spec 草稿 ~/tmp/pi-events-daemon-spec.md | map 收官，进入实施阶段
- 2026-09-17 | pi harness v2 浅调研（#27）：存储地基已铺/coding-agent 未接线/无时间表 → spec 加单一 adapter 注记，#27 关成 watch | 重启条件=SessionRepo 默认化
- 2026-09-17 | 研究（#28）事件驱动 agent：5 方向+合成落 ~/research/event-driven-agents/；投递契约获 Temporal 同构验证、wake 推送无先例、70-90% 数字为引用死循环、D5 裁决 build+reuse patterns | 12 项裁定全部获佐证
- 2026-09-17 | pi harness v2 文章对读（harness-v2/j4 分支 3446 行设计稿）：意图/结果配对与两段式 ack 同构、ID 预分配验证 Subscribe 例外、fx:Effects 测试模式入 spec 增量、lane 感知并入 #27 | 六条映射落 #29
