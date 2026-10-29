# REVIEW.md — 评审应知

对本仓 diff 做评审（人工 / ocr / reviewer subagent）前先读本页。测试类发现对照 [TEST.md](./TEST.md) 的四条纪律逐条核对——那是 CI 五轮红的沉淀，评审透镜与本仓事故谱系一一对应。

## 前置：跑门禁并数数

```bash
npm run check          # depcruise 边界 + tsc --noEmit
```

通过判据 = 违规计数归零（数数纪律见 [TEST.md §4](./TEST.md#4-归零计数门禁输出必须数数)），tail 没红不算过。测试改动跑对应包自己的 runner（vitest 或文件头声明的 canonical 跑法），根级 `npm test` 不是门禁（既有红包清单见 workflow tests.yml 注释）。

## 评审透镜（本仓特有，机器门测不出的部分）

- **边界语义**：`packages/README.md` 四规则有 depcruise 机器门；评审关注机器测不出的——跨包语义契约（入口 re-export 面的承诺、deep module 边界的收敛/扩散）。
- **测试纪律**：diff 含测试改动时逐条对照 [TEST.md](./TEST.md)——环境前提（fresh-machine test）、`waitFor` 目标态、runner 形态声明。
- **三态退出码**：checker 语义 0=passed / 2=failed / 其他=waiting。凡涉及 probe/check/模板的 diff，核对退出码映射（票 137 教训：failed 被判 passed 是确定性死订阅）。
- **shellQuote 代入**：模板参数进 check 经 `shellQuote`（profiles/instantiate.ts）。评审任何"参数拼进 shell 串"的路径：代入值是否过 quote、caller 多余键是否触碰字面花括号。

## FP 与经验沉淀

历史 FP 模式与评审教训记录在 [review-knowledge.md](./review-knowledge.md)（⚠️ 现有条目源自 tracker 包先例，与本仓技术栈不同源，按相关性取用）。评审定谳的新 FP / 教训往该文件追加，一行模式 + 一行"为什么在这里是 FP"。
