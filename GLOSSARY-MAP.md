# Glossary Map

This is a monorepo with 22 packages under `packages/*`. Each package has its own domain vocabulary. This file points to the per-package `GLOSSARY.md` files.

## Packages with GLOSSARY.md

| Package | Domain | Description |
|---------|--------|-------------|
| [pi-herdr-ask-bridge](packages/pi-herdr-ask-bridge/GLOSSARY.md) | Event bridging | 将 ask_user_question 的 blocked 信号桥接到 Herdr，pane 图标切换为 blocked 态 |
| [pi-herdr-tab-rename](packages/pi-herdr-tab-rename/README.md) | Event bridging | 将 pi session 重命名（session_info_changed）同步到 Herdr tab 标签 |
| [oh-my-pet](packages/oh-my-pet/GLOSSARY.md) | Agent Pet | 数字宠物伴侣，binlog 驱动的属性系统，状态栏展示 |
| [pi-insight](packages/pi-insight/GLOSSARY.md) | Insight | 会话洞察报告：量化产出、识别模式、发现摩擦点 |
| [pi-poll](packages/pi-poll/GLOSSARY.md) | Poll | 轮询 shell 条件直到 exit 0，替代固定 sleep 等待后台进程/CI/端口/文件 |
| [pi-proxy](packages/pi-proxy/GLOSSARY.md) | Proxy | 代理环境变量注入，spawnHook + user_bash 透明拦截 |
| [pi-thefuck](packages/pi-thefuck/GLOSSARY.md) | Fuck | 撤销失败 tool call，context 过滤 + 自动重试 |
| [pi-think-tool](packages/pi-think-tool/GLOSSARY.md) | Think/Env/Consequence | 推理记录、环境采集、后果评估三工具 |
| [pi-wishlist](packages/pi-wishlist/GLOSSARY.md) | Wishlist | Pi Package 愿望单，后台更新检查和通知 |
| [pi-skill-presets](packages/pi-skill-presets/GLOSSARY.md) | Presets | Skill 分组与动态加载：prefix-cache-aware 的 transient injection + persistent entry 状态跟踪 |
| [pi-timekeeper](packages/pi-timekeeper/GLOSSARY.md) | Timekeeper | Codex 式时间感知：run 边界拉式注入时间锚，节流双条件 + 压缩重锚，绝不唤醒 idle |
| [prototype-events-daemon](packages/prototype-events-daemon/GLOSSARY.md) | Events daemon (prototype) | 前身术语副本（历史参照）；正典见 pi-events-daemon |
| [pi-events-daemon](packages/pi-events-daemon/GLOSSARY.md) | Events daemon | **正典**：实体状态机基底 + 实现期裁定（Transitioned/epoch/TxOps/envAllowlist）；ADR docs/adr/0001-0008 |

## Packages without GLOSSARY.md yet

- earth-online-changelog
- modernize
- pi-json-output
- pi-project-manager
- pi-weave-a-towel
- pi-role
- pi-html-preview
- pitrace

`GLOSSARY.md` for each package is created lazily by `/domain-modeling` when terms or decisions actually need recording.（2026-10-19 由 CONTEXT.md 统一迁移更名）
