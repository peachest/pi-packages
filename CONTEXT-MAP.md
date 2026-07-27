# Context Map

This is a monorepo with 9 packages under `packages/*`. Each package has its own domain vocabulary. This file points to the per-package `CONTEXT.md` files.

## Packages with CONTEXT.md

| Package | Domain | Description |
|---------|--------|-------------|
| [oh-my-pet](packages/oh-my-pet/CONTEXT.md) | Agent Pet | 数字宠物伴侣，binlog 驱动的属性系统，状态栏展示 |
| [pi-insight](packages/pi-insight/CONTEXT.md) | Insight | 会话洞察报告：量化产出、识别模式、发现摩擦点 |
| [pi-proxy](packages/pi-proxy/CONTEXT.md) | Proxy | 代理环境变量注入，spawnHook + user_bash 透明拦截 |
| [pi-thefuck](packages/pi-thefuck/CONTEXT.md) | Fuck | 撤销失败 tool call，context 过滤 + 自动重试 |
| [pi-think-tool](packages/pi-think-tool/CONTEXT.md) | Think/Env/Consequence | 推理记录、环境采集、后果评估三工具 |
| [pi-wishlist](packages/pi-wishlist/CONTEXT.md) | Wishlist | Pi Package 愿望单，后台更新检查和通知 |
| [pi-skill-presets](packages/pi-skill-presets/CONTEXT.md) | Presets | Skill 分组与动态加载：prefix-cache-aware 的 transient injection + persistent entry 状态跟踪 |

## Packages without CONTEXT.md yet

- earth-online-changelog
- modernize
- pi-json-output
- pi-project-manager
- pi-weave-a-towel
- pi-role

`CONTEXT.md` for each package is created lazily by `/domain-modeling` when terms or decisions actually need recording.
