# known-unresolved — 已知遗留与裁定台账（正典位）

终审（2026-10-18 challenge-audit，可信度 84/100、零假 finding、1B3C）收口后仍明确在账的事项。
规则：只记**已裁定**的遗留——每项带来源与处置；未裁定的发现走 issue tracker，不入本账。

## 既有遗留（终票 worker 报告，2026-10-16，五项）

1. ~~**probe evidence 落盘链未接**~~ → **已收口（票 47/GitHub #112，2026-10-19）**：L1 回流处（loops
   `ingestProbeResult`）evidence 非空即落盘铸造 `ev:<sha256 前 16 hex>` 内容哈希 ref（同结果重放同 ref，
   upsert 幂等不重复行）→ `probeVerdict` 请求携带 → 翻转沿事件旁车；fanOut billboard 同步改 `getEvidence`
   点查（原 `evidenceSearch` 对含 `:` 的 ref FTS MATCH 抛 "no such column"，真实链一接即炸）。
   验收补注（同日，实战误报排障）：落盘内容 = **verdict reason + checker 输出**（stdout+stderr prober
   已合并掩码）——静默失败（curl -sf 401 类零输出）时 reason 单独可答「probe 当时看到了什么」。
   e2e（subscribe→probe→evidence op 读回）+ 幂等单测全绿；保留期归票 28/L4 既有删除域不变。
   原问题：evidence op 的 probe 路径解引用空——prober 回流的 evidence 文本尚未经
   loops 落盘铸造 evidenceRef（ProbeResult.evidenceRef 由 loops 落盘后铸造的 D4 分工，最后一公里未接）。
2. **ad-hoc ephemeral L4 retired 清理域未注入**：ephemeral 实体 terminal→retired 标记与 7d 到期清残留
   （票 28 L4）只覆盖 profile 形态；ad-hoc 声明的 ephemeral 清理域未在组合根注入。
3. **subscribe url 多参数 keyGenerator**：url 路由的 keyGenerator 需 extension instantiate 随帧补齐
   （票 32 路由 × 票 34 extension 接缝）。
4. **query scope/session 过滤部分接入**：store.notifications(filter) 双实现已齐；query op 侧过滤接线
   部分完成（票 40 ocr F5 修复后仍余子面）。
5. **全量套件高负载偶发真进程时序 flake**：真 spawn 冒烟与 kill 自愈组在全量并发下偶发时序竞争
   （wake 屏障已改 level-trigger，剩余为观测项）。

## 终审修复批处置（2026-10-18）

- **prober env 白名单（审计 prober Gap 1）→ 已落地（批 2，fix(fx) + fix(prober)）**：fx ExecOptions.env
  改**替换语义**（env 给出 = checker 整环境，缺省继承 process.env）；prober `envFor()` 恒返回白名单全量
  env = PATH + HOME（必要运行项：glab 自取 token 需 ~/.config、kubectl 需 ~/.kube——HOME 非 credential
  载体，与 PATH 同类「必要」）+ no_proxy/NO_PROXY（配置时）；token 不入白名单（脱敏承诺的 env 侧执行点，
  输出侧 maskText 兜底）。威胁面收口：checker 不再可见全环境变量。
- **notifications 实体/会话过滤、kernel.unregister、C2 on-transition 编排 → 已裁补实现（批 1，
  integration branch 直做——落地状态以 feat/pi-events-daemon 分支为准）**。

## 终审三笔裁定记录（2026-10-18，spec 同步账）

- **cron tz = 授权全 UTC**：schedule `{type:"cron", expr, tz?}` 的 tz 字段保留不消费，cron 到点计算统一
  按 UTC（domain cronNextMs 单一解析）；非 UTC 时区（如国内 +8h）为已知行为差，不视为缺陷。
  spec 已同步：spec-modules/profiles.md（schedule/cron 行）+ domain.md（cronNextMs 一笔）。
- **evidence 点查 = ref 精确读**：kernel.evidence() 走 getEvidence 精确读而非 evidenceSearch(FTS5
  MATCH)——确定性 event id 形 ref 含 ":"，FTS5 会解析成列过滤器，不承载点查（技术理由成立）；
  FTS5 索引面 evidenceSearch 保留作搜索。spec 已同步：spec-modules/kernel.md evidence 方法行。
- **known-unresolved 台账**：本文件即第三笔——已知遗留集中登记处，此后新遗留先裁定后入账。

## 后续调研票注记

- **QuickJS-WASI 沙箱（终审裁定④衍生）**：用 pi v1.0 codemode / quickjs-wasi（独立 npm 包、纯库可嵌入
  daemon）为 checker 提供强隔离执行面（WASI 零 fs/网络/env 天然强隔离）；checker 需改 JS 片段或受控
  exec 注入。与本次 env 白名单是**不同威胁面**：codemode 隔离 pi 会话脚本，env 白名单隔离 daemon 子进程
  环境。立票待调研，不进当前 MVP。
