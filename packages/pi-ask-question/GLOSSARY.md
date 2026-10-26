# pi-ask-question

结构化提问对话框扩展：agent 通过 `ask_user` 工具向用户提问，TUI 呈现带上下文回忆面板的问题卡片，用户可选选项、多选、输入自定义文本，或要求重问。Vendor 自 `@juicesharp/rpiv-ask-user-question` 2.13.9 后改造（spec #127，2026-10-26 合入 main）。

## Domain

**Structured questioning** — tool schema 强制上下文 → TUI 首屏回忆面板 → 判别联合答案 → LLM-facing envelope，四段同源（同一 formatter 产出提交页预览与 agent 收到的 envelope）。

## Vocabulary

- **ask_user** — 注册的工具名（rpiv 上游为 `ask_user_question`；改名以与 rpiv 原版并存期区分）。
- **context** — 必填（40-400 字），三句式：session 总目标 / 当前进度 / 这批问题解决什么。validator 拒缺失并教补写。设计动机：71% 冷问无上下文、用户切走回来后不翻历史即可回忆（spec #127 数据）。
- **recent** — 可选 string[]（≤5 条），动作锚点清单，必须锚定可验证材料（文件路径/ticket 号/CI 结果），区别于 context 的叙述。
- **background** — 每问可选。该问题的来源现象/分歧。写不出 = 该问不该问的自检器。
- **rephrase** — 第 4 种 answer kind（option/custom/multi 之外）。用户对某题不满意，Enter "↻ 没说清，重新问" 标记该题、焦点跳下一题；envelope 携带问题原文+原因+指令"必须重问不得跳过"。永不视作 decline。
- **rephrase cap** — per-invocation 3 次封顶：第 3 次自动转 cancel 路径（envelope 带其余已答答案于 details + "改用普通文本讨论"指引）。计数在 dialog 状态内，agent 重问开新 dialog 归零——"已重问 N 次"的 context 进度是唯一跨次通道。2026-10-26 冒烟实测熔断路径触发正确。
- **reasonByTab** — rephrase 原因的独立 per-tab 槽（不复用 rpiv 的 notesByTab），原因与 notes 共存互不覆盖，envelope 各自成段。原因可选永不强制（2026-10-21 用户裁定）。
- **merge semantics（多选合并）** — kind:"multi" 的答案同时携带勾选 labels（`selected`）与自定义文本（`answer`），两者叠加不替换。TUI 三处显式化：输入行 label "与以上勾选项同时生效"、输入行下实时合成回显、Submit 页两行预览。
- **decision card（决策卡）** — submit 后 transcript 里的工具渲染：context + 每问 header→答案，与 envelope segment 同 formatter 同源；默认折叠 5 行可展开。
- **collapse widget** — ctrl+] 隐藏对话框期间的 persistent widget（id `ask_user`），显示待答进度；reopen/submit/两种 cancel 四出口清除。
- **recall panel（回忆面板）** — TUI 首屏头部：context 三句 + recent 锚点常驻，用户不翻聊天历史即可重建决策上下文。

## Decisions

- **Vendor 后改而非重写**（2026-10-21 拍板）：6200 行 rpiv 基线，改动 ~300 行集中在 tool schema / reducer sentinel / view 文案；reducer 的多选合并与 tab 导航语义未动。
- **每问一次 ≤4 题**：维持 rpiv MAX_QUESTIONS=4（FINDINGS"≤3 问"是个人提问习惯，不进 schema）。
- **事件通道名不变**：`rpiv:ask-user:*` 逐字保留（pi-herdr-ask-bridge 依赖）。
- **包根 seams re-export**：tests 只 import 包根（repo 边界规则），见 `seams.ts`。
