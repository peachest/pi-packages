# pi-context-mode-lite

vendored [context-mode](https://github.com/mksglu/context-mode)（npm `1.0.169`，mksglu）+ 本仓维护的 lite patch。**替代 settings.json 里的 `npm:context-mode`**。

## 为什么 vendor

2026-10-20 对 ctx_\* 工具族做了全历史审计（8109 次调用 / 552 session，报告 `~/tmp/analysis-ctx-tools.md`）：

- **禁 `ctx_fetch_and_index`**：49.6% 错误率（全网络层），错误不缓存导致同 URL 跨 session 反复重打（42 次/21 session）；W38 周 agent 已自发弃用。
- **禁 `ctx_execute_file`**：44.8% 错误率（path scope 拦截 + language 必填漏传），且报错后 0 降级到 bash/read。
- **禁 `ctx_stats`**：全历史 3 次调用。
- **保留 `ctx_execute` / `ctx_batch_execute` / `ctx_search` / `ctx_index`**：batch 质量最佳（98% 带 queries、错误率 3.5%）；execute 真价值在 100KB 级大输出过滤，但 62% 调用 <2KB 白付包装费 → description 加了量化触发判据（~5KB / 多命令）+ 小输出反例。
- 8 个 ctx-\* skill 全部不装（skill 清单也是固定 token 税）。

**上游已停更**（终版 1.0.169，2026-06-29 发布，之后零发布）→ 给上游提 issue 修 fetch_and_index 无望，本地 patch 是唯一路径，且几乎零维护成本。估算每会话省 ~2-3K tokens（砍 3 个工具 schema + hierarchy 文本 + 8 个 skill 描述）。

## 结构

```
upstream/      # context-mode@1.0.169 原样副本（build/ + server.bundle.mjs + node_modules/zod + package.json）
lite.patch     # 全部增量：mcp-bridge.js 工具过滤 + 描述判据 + extension.js hierarchy 收敛
sync.sh        # 上游刷新入口
package.json   # pi manifest：extensions 指向 upstream 入口，skills: []
```

## sync 上游新版本

```bash
npm pack context-mode@<ver> && tar xzf mksglu-context-mode-<ver>.tgz
./sync.sh package        # 冲突即报错，人工裁决后重生成 patch
```

上游若恢复更新，需重审三件事：①fetch_and_index 是否修了错误缓存；②execute/batch 描述是否可去掉本地判据；③版本订阅（pi-events-daemon ad-hoc check）可在 settings 落地时补。

## 验证

```bash
node -e "import('./upstream/build/adapters/pi/extension.js').then(()=>console.log('ok'))"
```

安装方式见仓库根 AGENTS.md（`pi install` 规范）；settings.json 中 `npm:context-mode` 条目已替换为本包相对路径。
