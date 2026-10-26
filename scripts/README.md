# scripts/

- `sanitize-check.sh` — 推送前凭证/内部标识扫描（gitleaks 双层，pre-push hook 调用）
- `check-pi-settings.sh` — settings worktree-dep 检查（root npm run check 腿）
- `link-pi-packages.sh` — 把 settings 引用的本地路径包软链进 `~/.pi/agent/npm/node_modules/<name>`。
  pi 对 local-path 包不装依赖（官方："dependency tree remains the package author's responsibility"）；
  链接后依赖从 pi npm 区平级解析，与 repo 检出位置解耦，同时消除"settings 相对路径指向死 worktree"类 drift。
  幂等；`--prune` 清断链。post-commit hook 对本次 commit 改动的包自动 relink（见 githooks/post-commit）。
  注意：链接名 = package.json 的 name（npm 正典；多数包无 scope，pi-ask-question 是 @hyx/pi-ask-question）。
- `githooks/` — core.hooksPath 指向此处：pre-push（sanitize 硬门）+ post-commit（包链接自动维护）
- `link-pi-tui.mjs` — root postinstall：pi-tui 符号链接重建
