# pi-wt-lite

vendored [pi-worktrunk](https://github.com/mavam/pi-worktrunk)（npm `0.12.2`，mavam）+ 本仓维护的 lite patch。**替代 `~/skills/extensions/pi-wt-lite.ts`**（原 vendored 副本，2026-10-21 迁入本仓统一 vendor 纪律）。

## 为什么 vendor

worktrunk 工具由本地 vendored 扩展提供（`wt` v0.77.0 配套），有两处手改：

1. **`buildReference` 替换为 `COMPACT_REFERENCE` 常量**：上游每次调用会对已安装 wt 的每个子命令跑 `--help-md` 探测（`HELP_PROBE_CONCURRENCY=8`）生成全量命令目录，token 开销大且每次启动重打。改为手写的常用子集参考（switch/remove/list/merge/step，其余子命令指引走 bash `wt <cmd> --help`）。
2. **`registerTool` description/promptGuidelines 压缩**：与紧凑参考对齐，去掉生成目录相关表述，强调 args 不重复命令名、codemode queued 即停。

## 结构

```
upstream/      # pi-worktrunk@0.12.2 原样副本（worktrunk.ts + package.json + LICENSE）
lite.patch     # 全部增量：COMPACT_REFERENCE 常量 + buildReference 调用替换 + registerTool 元数据压缩
sync.sh        # 上游刷新入口
package.json   # pi manifest：extensions 指向 upstream/worktrunk.ts，skills: []
```

## sync 上游新版本

```bash
npm pack pi-worktrunk@<ver> && tar xzf pi-worktrunk-<ver>.tgz
./sync.sh package        # 冲突即报错，人工裁决后重生成 patch
```

重生成 patch 的基线必须是 npm pristine 副本（repo index 里是已打补丁的树，`git diff -- upstream/` 会以旧补丁为基线累积叠加），并保持 `upstream/` 相对路径：

```bash
diff -u --label a/upstream/worktrunk.ts --label b/upstream/worktrunk.ts <pristine-pkg>/worktrunk.ts upstream/worktrunk.ts > lite.patch
diff -u --label a/upstream/package.json --label b/upstream/package.json <pristine-pkg>/package.json upstream/package.json >> lite.patch
```

重生成后必验：pristine + lite.patch 重新应用结果与 upstream/ 三文件逐字节 cmp 一致。

上游若升级（pi-worktrunk 发布新版本或 vendored 自 wt 升级后需手动 diff 同步），需重审：①`--help-md` 探测的 token 开销是否已被上游优化（是则 COMPACT_REFERENCE 可退役）；②新增子命令是否值得进紧凑参考；③与 `~/.config/worktrunk/config.toml` 全局配置的措辞是否仍一致。

## 验证

patched 产物与迁移源逐字节一致（零行为变化，2026-10-21 验证）：

```bash
diff upstream/worktrunk.ts <(git -C <旧skills仓> show d972f3c:extensions/pi-wt-lite.ts)  # 应无输出
node -e "import('./upstream/worktrunk.ts').then(()=>console.log('ok'))"  # 语法冒烟（需 node >=24 strip-types 环境）
```

安装方式见仓库根 AGENTS.md（`pi install` 规范）；settings.json 中原 `../../skills` 扩展目录条目保留（仍服务 pi-herdr-peer.ts），本包以 `../../projects/pi-mypackage/packages/pi-wt-lite` 相对路径条目接入。
