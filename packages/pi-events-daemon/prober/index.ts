/**
 * prober — 探针执行引擎（票 16）。零依赖（eda-adapter-fx-only：只 import fx 端口，
 * 不 import kernel/domain/store——D4 裁定：结果经 completion queue 回流，由 loops 消费后调 kernel）。
 *
 * 执行面（#31 B3 清单）本模块全部拥有：checker 池 ≤8 并发（第 9 个排队）、超时缺省 10s
 * 上限 300s（fx Clock 计时 + Exec timeoutMs 双停点）、三态映射（0=passed / 2=failed 断言 /
 * 其他=waiting；verdict 一律语义名，退出码只进 reason 文本）、env 白名单注入（B2②，不继承
 * 全环境——终审 Gap 1 落地）、token 脱敏（B2③）、fs-watch 原生推送（票 18：监听建立/关闭归执行引擎，推送事件触发 check
 * 执行、结果经同一 completion queue 回流）。checker 本体是 shell 命令字符串，来自 profile
 * 模板资产 / ad-hoc 声明（shell 是唯一判定原语，HTTP 经 curl -sf 包装）——本模块只含执行
 * 引擎，不含 checker 实现。
 */
import type { Clock, Exec, ExecResult, Fs } from "../fx/index.ts";

/** 判定三态（#31 正典命名）。与 domain.Verdict 同字面量联合：D4 禁 import，结构兼容即 seam。 */
export type Verdict = "passed" | "failed" | "waiting";

/** 探针源（#31 A3 构造块，随 checker 声明携带）：poll=调度触发；fs-watch=文件变化原生推送触发（票 18）；k8s-watch=同待遇接口，MVP 实现待票。 */
export type ProbeSource = "poll" | "fs-watch" | "k8s-watch";

/** probe 执行请求：slotKey 是调用方（loops RunnerSlot）定义的关联键，回流原样带回。 */
export type ProbeSlot = {
  slotKey: string;
  /** checker shell 命令（模板资产派生 / ad-hoc）。 */
  check: string;
  /** 超时：缺省 10s，上限 300s（prober 执行面策略，fx 不持）。 */
  timeoutMs?: number;
  source?: ProbeSource;
  /** fs-watch 源监听目标（checker 声明携带；source=fs-watch 必填）。 */
  watchPath?: string;
  /** 显式 env 追加白名单（与默认 PATH/HOME/no_proxy 合并；凭据纪律首选文件路径）。 */
  envAllowlist?: string[];
};

/** probe 结果（completion queue 回流行）。 */
export type ProbeResult = {
  slotKey: string;
  verdict: Verdict;
  reason: string;
  /** stdout+stderr 合并、token 掩码后的输出；evidenceRef 由 loops 落盘后铸造（prober 零 store 依赖）。 */
  evidence: string;
  /** fx Clock 计时（now 差值）。 */
  durationMs: number;
};

/** checker 池并发上限（#31 B3：全局并发 8，probe storm 不打满节点）。 */
export const PROBE_POOL_MAX = 8;
/** 超时缺省（#31 B3）。 */
export const PROBE_TIMEOUT_DEFAULT_MS = 10_000;
/** 超时上限（#31 B3：hung checker 不得 wedge 池）。 */
export const PROBE_TIMEOUT_MAX_MS = 300_000;

/** 内置 token 脱敏 pattern（B2③ 执行点）：glab token / Bearer 头 / 赋值形机密。引号双形态（响应体场景）须排在通配赋值形之前——通配形遇引号值只掩到首个空格、遇引号字段名不命中。 */
const DEFAULT_TOKEN_PATTERNS: readonly RegExp[] = [
  /\bglpat-[\w-]{8,}\b/g,
  /\bBearer\s+[\w.~+/=-]{8,}/gi,
  // 引号字段名形态（JSON 响应体）："token":"..." → 连值整体掩码（值内 \" 转义段不截断）
  /"(?:token|password|secret|api[-_]?key)"\s*:\s*"(?:[^"\\]|\\.)*"/gi,
  // 引号值形态（shell/env 赋值）：password="..." → 值含空格/转义整体掩码
  /\b(?:token|password|secret|api[-_]?key)\s*=\s*"(?:[^"\\]|\\.)*"/gi,
  /\b(?:token|password|secret|api[-_]?key)\s*[=:]\s*\S+/gi,
];

export type ProberDeps = {
  /** checker 执行停点（#31 fx 四停点之一）：真壳 ShellExec，B 层测试 FakeExec/可控延迟执行器。 */
  exec: Exec;
  /** 超时计时停点：真壳 SystemClock，B 层 FakeClock 手动推进。 */
  clock: Clock;
  /** completion queue 消费面（D4 回流）；loops L1 消费后调 kernel。 */
  onResult: (result: ProbeResult) => void;
  /** B2② no_proxy 全局注入（内网清单，命中即免代理）。 */
  noProxy?: string;
  /** B2③ 脱敏 pattern（替换内置集）。 */
  tokenPatterns?: readonly RegExp[];
  /** watch 停点（票 18 fs-watch 源必填；poll-only 装配可省）。 */
  fs?: Fs;
};

export class Prober {
  private readonly deps: ProberDeps;
  private readonly patterns: readonly RegExp[];
  private nextSeq = 0;
  private inflight = 0;
  private readonly queued: { seq: number; slot: ProbeSlot; timeoutMs: number }[] = [];
  /** 回流稳序缓冲：结果先按 seq 落位，前序全部结算后才交付（回流序=提交序，票面验收）。 */
  private readonly buffered = new Map<number, ProbeResult>();
  private nextDeliverSeq = 0;
  /** fs-watch 活跃监听（slotKey → 句柄）：建立/关闭归执行引擎（票 18）。 */
  private readonly watchers = new Map<string, { close(): void }>();

  constructor(deps: ProberDeps) {
    this.deps = deps;
    // /g 归一：非全局 pattern 只掩首现，违背「出现即掩码」
    this.patterns = (deps.tokenPatterns ?? DEFAULT_TOKEN_PATTERNS).map((p) =>
      p.flags.includes("g") ? p : new RegExp(p.source, `${p.flags}g`),
    );
  }

  /**
   * 提交 probe：入池即返（不 await）。并发 ≤8，第 9 个起排队；结果经 onResult 回流。
   * poll（缺省）立即执行一次；fs-watch 建立原生推送监听（声明 ≠ 执行），文件变化触发 check
   * 执行、结果经同一 completion queue 回流（与 poll 结果同一消费面，票 18）；k8s-watch 一等
   * 构造块已裁（#31 A3）、MVP 实现待票——同步拒绝，静默按 poll 执行是错语义。
   * timeoutMs 在分配 seq 与容量前校验/规范化（非法即抛参数错，不占序位不占池）。
   */
  probe(slot: ProbeSlot): void {
    const timeoutMs = normalizeTimeoutMs(slot.timeoutMs);
    if (slot.source === "k8s-watch") {
      throw new Error(`prober: source "k8s-watch" 一等构造块已裁（#31 A3），MVP 实现待票——静默按 poll 执行是错语义`);
    }
    if (slot.source === "fs-watch") {
      if (slot.watchPath === undefined) {
        throw new Error("prober: source fs-watch 需要 watchPath（监听目标由 checker 声明携带）");
      }
      if (this.deps.fs === undefined) throw new Error("prober: source fs-watch 需要 deps.fs（fx watch 停点）");
      this.establishWatch(slot, timeoutMs);
      return;
    }
    this.submitRun(slot, timeoutMs);
  }

  /**
   * 单发同步等待执行（票 40：op validate live-run / subscribe smoke 预检）：不走池不回流，
   * Promise 结算。三态归类与输出掩码与池路径同一套（classify/mask 复用）——语义不二源。
   */
  /**
   * 单发同步等待执行（票 40：op validate live-run / subscribe smoke 预检）：不走池不回流，
   * Promise 结算。三态归类与输出掩码与池路径同一套（classify/mask 复用）——语义不二源。
   * timeoutMs 同池路径规范化（票 40 评审 F10：0/负/NaN/Infinity 拒，>300s 封顶）。
   */
  async runOnce(check: string, timeoutMs: number = PROBE_TIMEOUT_DEFAULT_MS): Promise<Omit<ProbeResult, "slotKey">> {
    const ms = normalizeTimeoutMs(timeoutMs);
    const t0 = this.deps.clock.now();
    let raw: Awaited<ReturnType<Exec["run"]>>;
    try {
      raw = await this.deps.exec.run(check, { timeoutMs: ms, env: this.envFor() });
    } catch (err) {
      return {
        verdict: "waiting",
        reason: `exec error: ${this.maskText(err instanceof Error ? err.message : String(err))}`,
        evidence: "",
        durationMs: this.deps.clock.now() - t0,
      };
    }
    return { ...classify(raw, ms), evidence: this.mask(raw), durationMs: this.deps.clock.now() - t0 };
  }

  /** poll 立即执行与 watch 事件触发共用的入池路径：seq 分配、池 ≤8、第 9 个起排队。 */
  private submitRun(slot: ProbeSlot, timeoutMs: number): void {
    const seq = this.nextSeq++;
    if (this.inflight < PROBE_POOL_MAX) this.start(seq, slot, timeoutMs);
    else this.queued.push({ seq, slot, timeoutMs });
  }

  /**
   * fs-watch 监听建立（票 18，监听建立/关闭归执行引擎）：声明即建立，不立即执行；同 slotKey
   * 重复 probe = 关旧开新（subscribe 换参同构语义）。watch() 同步抛错（路径不存在等）原样
   * 上抛 = 参数错（与 timeoutMs 校验同面）。
   */
  private establishWatch(slot: ProbeSlot, timeoutMs: number): void {
    this.watchers.get(slot.slotKey)?.close();
    const t0 = this.deps.clock.now();
    let handle: { close(): void } | undefined;
    const onEvent = (): void => this.submitRun(slot, timeoutMs);
    const onError = (err: unknown): void => {
      // 监听器故障：同 failExec 语义可见回流（waiting + 掩码 reason）并关闭监听（坏源不再触发）
      handle?.close();
      this.watchers.delete(slot.slotKey);
      this.deliver(this.nextSeq++, {
        slotKey: slot.slotKey,
        verdict: "waiting",
        reason: `watch error: ${this.maskText(err instanceof Error ? err.message : String(err))}`,
        evidence: "",
        durationMs: this.deps.clock.now() - t0,
      });
    };
    handle = this.deps.fs!.watch(slot.watchPath!, onEvent, onError);
    this.watchers.set(slot.slotKey, handle);
  }

  /** 关闭 watch 源监听（资源清理归执行引擎，幂等）：关闭后文件变化不再触发回流。 */
  closeWatch(slotKey: string): void {
    this.watchers.get(slotKey)?.close();
    this.watchers.delete(slotKey);
  }

  private start(seq: number, slot: ProbeSlot, timeoutMs: number): void {
    this.inflight++;
    const t0 = this.deps.clock.now();
    let settled = false;
    let released = false;
    // 容量释放 = 执行终止（Exec 结算，无论正常还是超时杀形），与结果结算解耦：
    // Clock 超时只判结果，进程可能仍在跑，提前补位会突破池上限（ocr 评审 3H：实际并发 >8）
    const release = () => {
      if (released) return;
      released = true;
      this.inflight--;
      const next = this.queued.shift();
      // 补位经微任务：同步抛错的 run 否则会形成 release→start→failExec→release 无界同步递归，栈溢出点不定且静默卡死剩余容量与序号
      if (next) queueMicrotask(() => this.start(next.seq, next.slot, next.timeoutMs));
    };
    const emit = (result: ProbeResult) => {
      if (settled) return; // 超时到点后迟到的 exec 结果丢弃，不二次回流
      settled = true;
      timer.cancel();
      this.deliver(seq, result);
    };
    const timer = this.deps.clock.setTimeout(() => {
      emit({
        slotKey: slot.slotKey,
        verdict: "waiting",
        reason: `timeout after ${timeoutMs}ms`,
        evidence: "",
        durationMs: this.deps.clock.now() - t0,
      });
    }, timeoutMs);
    const failExec = (err: unknown) => {
      emit({
        slotKey: slot.slotKey,
        verdict: "waiting",
        // 错误消息可携带响应体凭据：与 evidence 同一套掩码规则（ocr 评审 1H）
        reason: `exec error: ${this.maskText(err instanceof Error ? err.message : String(err))}`,
        evidence: "",
        durationMs: this.deps.clock.now() - t0,
      });
      release();
    };
    let pending: Promise<ExecResult>;
    try {
      pending = this.deps.exec.run(slot.check, { timeoutMs, env: this.envFor(slot.envAllowlist) });
    } catch (err) {
      // run 同步抛错：转该任务 waiting 结果（不走 .catch 面），槽位照常释放、
      // 补位不中断——否则异常逃进前一任务的 settle 链，其 seq 永久缺失卡死稳序缓冲（ocr 评审 2M）
      failExec(err);
      return;
    }
    pending
      .then((raw) => {
        emit({
          slotKey: slot.slotKey,
          ...classify(raw, timeoutMs),
          evidence: this.mask(raw),
          durationMs: this.deps.clock.now() - t0,
        });
        release();
      })
      .catch(failExec);
  }

  /** 回流交付：seq 稳序（票面验收「回流顺序与提交序一致」，完成乱序时缓冲待序）。 */
  private deliver(seq: number, result: ProbeResult): void {
    this.buffered.set(seq, result);
    while (this.buffered.has(this.nextDeliverSeq)) {
      const head = this.buffered.get(this.nextDeliverSeq)!;
      // 先删后调：序号推进先于外部回调提交——回调抛错不重投、不阻塞后续排空（ocr 评审 2H）
      this.buffered.delete(this.nextDeliverSeq);
      this.nextDeliverSeq++;
      try {
        this.deps.onResult(head);
      } catch {
        // 消费侧异常逐条隔离：后续缓冲结果仍排空，异常不逃逸进 Clock 定时器/Exec 回调链
      }
    }
  }

  /**
   * B2② env 白名单（终审 prober Gap 1 落地，2026-10-18 裁定）：probe 执行不继承全环境
   * （spec prober.md「脱敏 token、no_proxy、必要 PATH」）。白名单 = PATH + HOME（必要运行项：
   * glab 自取 token 需 ~/.config、kubectl 需 ~/.kube——HOME 非 credential 载体，与 PATH 同类
   * 「必要」）+ no_proxy/NO_PROXY（配置时）；token 不入白名单（脱敏承诺的 env 侧执行点，输出侧
   * maskText 兜底）。fx ExecOptions.env 为替换语义：此处返回值即 checker 的整环境。
   */
  private envFor(extraAllowlist?: string[]): Record<string, string> {
    const env: Record<string, string> = {};
    const allowed = new Set(["PATH", "HOME", ...(extraAllowlist ?? [])]);
    for (const key of allowed) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    if (this.deps.noProxy !== undefined) {
      env.no_proxy = this.deps.noProxy;
      env.NO_PROXY = this.deps.noProxy;
    }
    return env;
  }

  /** B2③ 掩码公共面：任意文本（evidence 与错误 reason）逐 pattern 掩码（命中即 ***，明文不出模块）。 */
  private maskText(text: string): string {
    let out = text;
    for (const p of this.patterns) out = out.replace(p, "***");
    return out;
  }

  /** B2③：stdout+stderr 合并后掩码。 */
  private mask(raw: ExecResult): string {
    return this.maskText([raw.stdout, raw.stderr].filter((s) => s !== "").join("\n"));
  }
}

/** 超时规范化：缺省 10s；小数向上取整为整数毫秒（不短于请求值）后封顶 300s；0/负数/NaN/Infinity 非法即抛参数错（分配 seq/容量前调用）。 */
function normalizeTimeoutMs(raw: number | undefined): number {
  const ms = raw ?? PROBE_TIMEOUT_DEFAULT_MS;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`prober: timeoutMs 非法（${ms}）——须为正有限毫秒数`);
  }
  return Math.min(Math.ceil(ms), PROBE_TIMEOUT_MAX_MS);
}

/** 三态映射（#31）：0=passed / 2=failed 断言 / 其他（含超时、信号、无退出码）=waiting。 */
function classify(raw: ExecResult, timeoutMs: number): { verdict: Verdict; reason: string } {
  if (raw.timedOut) return { verdict: "waiting", reason: `timeout after ${timeoutMs}ms` };
  if (raw.exitCode === 0) return { verdict: "passed", reason: "exit 0" };
  if (raw.exitCode === 2) return { verdict: "failed", reason: "exit 2" };
  if (raw.exitCode !== null) return { verdict: "waiting", reason: `exit ${raw.exitCode}` };
  if (raw.signal !== null) return { verdict: "waiting", reason: `signal ${raw.signal}` };
  return { verdict: "waiting", reason: "no exit" };
}
