# pi-wt-lite

vendored [pi-worktrunk](https://github.com/mavam/pi-worktrunk)（npm `0.12.2`，mavam）+ 本仓维护的 lite patch。**替代 `~/skills/extensions/pi-wt-lite.ts`**（原 vendored 副本，2026-10-21 迁入本仓统一 vendor 纪律）。

## 为什么 vendor

worktrunk 工具由本地 vendored 扩展提供（`wt` v0.77.0 配套），有两处手改：

1. **`buildReference` 替换为 `COMPACT_REFERENCE` 常量**：上游每次调用会对已安装 wt 的每个子命令跑 `--help-md` 探测（`HELP_PROBE_CONCURRENCY=8`）生成全量命令目录，token 开销大且每次启动重打。改为手写的常用子集参考（switch/remove/list/merge/step，其余子命令指引走 bash `wt <cmd> --help`）。调用点删除后，整条死掉的 reference 生成管线（buildReference/renderReference/formatReference/truncateReference/mapConcurrent/attributeExamples/renderToolExample/firstSentence 及两个管线常量）在 patch 内一并删除，parseCommand/parseSectionEntries 等解析工具保留。
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

`verify.sh` 把「发布物与源一致」从手工纪律变成可执行不变量，四步链：npm pristine（`npm pack pi-worktrunk@<upstream/package.json 的 version>` 解包到干净临时目录）→ 应用 lite.patch → 产物与 `upstream/` 三文件逐字节 cmp → `node tests/remove-self-guard.test.mjs` 行为断言。

**何时跑**：每次 `sync.sh` 之后、每次上游升级（重生成 lite.patch）之后、怀疑 vendor 漂移时。

**失败含义**（任一步失败 exit 1 并指明步骤）：步骤 2 红 = lite.patch 与 pristine 版本不匹配，需按上文重新生成 patch；步骤 3 红 = `upstream/` 脱离「pristine+patch」可复现基线（手改了 upstream/ 没同步进 patch，或 patch 过期）；步骤 4 红 = patch 后行为断言失败，禁止安装。全过输出 `verified: pristine+patch==upstream, behavior green`。

历史上首次迁移（旧 skills 仓 `d972f3c:extensions/pi-wt-lite.ts` → 本包）的零行为变化等价性已于 2026-10-21 验证，持续的等价性证明由 `verify.sh` 承担。

安装方式见仓库根 AGENTS.md（`pi install` 规范）；settings.json 中原 `../../skills` 扩展目录条目保留（仍服务 pi-herdr-peer.ts），本包以 `../../projects/pi-mypackage/packages/pi-wt-lite` 相对路径条目接入。
