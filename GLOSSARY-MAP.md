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
| [pi-bash-guards](packages/pi-bash-guards/GLOSSARY.md) | Behavior guards | 全局 bash 守卫：命令位置解析引擎 + 声明式规则表，危险命令执行前拦截并给替代（ADR 0001） |
| [pi-ask-question](packages/pi-ask-question/GLOSSARY.md) | Structured questioning | `ask_user` 提问对话框：强制 context 回忆面板 + 多选合并语义显式化 + rephrase 重问 sentinel + transcript 决策卡（vendor rpiv） |
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

## System-level vocabulary（跨包）

- **local-path package / 本地路径包** — settings.packages 里以 `../../projects/pi-mypackage/packages/<name>` 相对路径安装的包。pi 不装其依赖（作者责任），jiti 从扩展文件位置向上解析。安装正典见 docs/adr/0002。
- **pi npm 区** — `~/.pi/agent/npm/node_modules/`。npm:/git: 源包的物理安装地；本地包经 `scripts/link-pi-packages.sh` 软链至此获得平级依赖解析与生态可见性。
- **包链接（node link）** — npm 区内指向 repo 包目录的软链接。链接名 = package.json 的 name（npm 正典，scoped 包进 @org/ 子目录）。由 post-commit hook 自动维护；与 settings 相对路径条目**单点注册**，禁止双写。

`GLOSSARY.md` for each package is created lazily by `/domain-modeling` when terms or decisions actually need recording.（2026-10-19 由 CONTEXT.md 统一迁移更名）
