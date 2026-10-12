/**
 * prober — 探针执行引擎（票 16）。零依赖（eda-adapter-fx-only：只 import fx 端口，
 * 不 import kernel/domain/store——D4 裁定：结果经 completion queue 回流，由 loops 消费后调 kernel）。
 *
 * 执行面（#31 B3 清单）本模块全部拥有：checker 池 ≤8 并发（第 9 个排队）、超时缺省 10s
 * 上限 300s（fx Clock 计时 + Exec timeoutMs 双停点）、三态映射（0=passed / 2=failed 断言 /
 * 其他=waiting；verdict 一律语义名，退出码只进 reason 文本）、no_proxy 全局注入（B2②）、
 * token 脱敏（B2③）。checker 本体是 shell 命令字符串，来自 profile 模板资产 / ad-hoc 声明
 * （shell 是唯一判定原语，HTTP 经 curl -sf 包装）——本模块只含执行引擎，不含 checker 实现。
 */
import type { Clock, Exec, ExecResult } from "../fx/index.ts";

/** 判定三态（#31 正典命名）。与 domain.Verdict 同字面量联合：D4 禁 import，结构兼容即 seam。 */
export type Verdict = "passed" | "failed" | "waiting";

/** 探针源（#31 A3 构造块，随 checker 声明携带）；fs-watch/k8s-watch 原生推送的监听建立/关闭归 watch 票。 */
export type ProbeSource = "poll" | "fs-watch" | "k8s-watch";

/** probe 执行请求：slotKey 是调用方（loops RunnerSlot）定义的关联键，回流原样带回。 */
export type ProbeSlot = {
  slotKey: string;
  /** checker shell 命令（模板资产派生 / ad-hoc）。 */
  check: string;
  /** 超时：缺省 10s，上限 300s（prober 执行面策略，fx 不持）。 */
  timeoutMs?: number;
  source?: ProbeSource;
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

/** 内置 token 脱敏 pattern（B2③ 执行点）：glab token / Bearer 头 / 赋值形机密。 */
const DEFAULT_TOKEN_PATTERNS: readonly RegExp[] = [
  /\bglpat-[\w-]{8,}\b/g,
  /\bBearer\s+[\w.~+/=-]{8,}/gi,
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
};

export class Prober {
  private readonly deps: ProberDeps;
  private readonly patterns: readonly RegExp[];
  private nextSeq = 0;
  private inflight = 0;
  private readonly queued: { seq: number; slot: ProbeSlot }[] = [];
  /** 回流稳序缓冲：结果先按 seq 落位，前序全部结算后才交付（回流序=提交序，票面验收）。 */
  private readonly buffered = new Map<number, ProbeResult>();
  private nextDeliverSeq = 0;

  constructor(deps: ProberDeps) {
    this.deps = deps;
    // /g 归一：非全局 pattern 只掩首现，违背「出现即掩码」
    this.patterns = (deps.tokenPatterns ?? DEFAULT_TOKEN_PATTERNS).map((p) =>
      p.flags.includes("g") ? p : new RegExp(p.source, `${p.flags}g`),
    );
  }

  /**
   * 提交 probe：入池即返（不 await）。并发 ≤8，第 9 个起排队；结果经 onResult 回流。
   * 非 poll source 同步拒绝——watch 监听建立/关闭归 watch 票，静默按 poll 执行是错语义。
   */
  probe(slot: ProbeSlot): void {
    if (slot.source !== undefined && slot.source !== "poll") {
      throw new Error(`prober: source "${slot.source}" 的 watch 执行未落地（#31 A3 构造块已裁，MVP 待 watch 票）——现仅支持 poll`);
    }
    const seq = this.nextSeq++;
    if (this.inflight < PROBE_POOL_MAX) this.start(seq, slot);
    else this.queued.push({ seq, slot });
  }

  private start(seq: number, slot: ProbeSlot): void {
    this.inflight++;
    const timeoutMs = Math.min(slot.timeoutMs ?? PROBE_TIMEOUT_DEFAULT_MS, PROBE_TIMEOUT_MAX_MS);
    const t0 = this.deps.clock.now();
    let settled = false;
    const settle = (result: ProbeResult) => {
      if (settled) return; // 超时到点后迟到的 exec 结果丢弃，不二次回流
      settled = true;
      timer.cancel();
      this.inflight--;
      // 池空位按结算序立即释放（与回流序解耦：稳序缓冲不得拖慢池周转）
      const next = this.queued.shift();
      if (next) this.start(next.seq, next.slot);
      this.deliver(seq, result);
    };
    const timer = this.deps.clock.setTimeout(() => {
      settle({
        slotKey: slot.slotKey,
        verdict: "waiting",
        reason: `timeout after ${timeoutMs}ms`,
        evidence: "",
        durationMs: this.deps.clock.now() - t0,
      });
    }, timeoutMs);
    this.deps.exec
      .run(slot.check, { timeoutMs, env: this.envFor() })
      .then((raw) =>
        settle({
          slotKey: slot.slotKey,
          ...classify(raw, timeoutMs),
          evidence: this.mask(raw),
          durationMs: this.deps.clock.now() - t0,
        }),
      )
      .catch((err: unknown) =>
        // exec 停点自身故障不得吞槽位：按 waiting 回流
        settle({
          slotKey: slot.slotKey,
          verdict: "waiting",
          reason: `exec error: ${err instanceof Error ? err.message : String(err)}`,
          evidence: "",
          durationMs: this.deps.clock.now() - t0,
        }),
      );
  }

  /** 回流交付：seq 稳序（票面验收「回流顺序与提交序一致」，完成乱序时缓冲待序）。 */
  private deliver(seq: number, result: ProbeResult): void {
    this.buffered.set(seq, result);
    while (this.buffered.has(this.nextDeliverSeq)) {
      this.deps.onResult(this.buffered.get(this.nextDeliverSeq)!);
      this.buffered.delete(this.nextDeliverSeq);
      this.nextDeliverSeq++;
    }
  }

  /** B2② env 注入面：只叠 no_proxy 策略（fx ExecOptions.env 是叠加语义；白名单沙箱待 fx env-replace 语义）。 */
  private envFor(): Record<string, string> | undefined {
    return this.deps.noProxy === undefined ? undefined : { no_proxy: this.deps.noProxy, NO_PROXY: this.deps.noProxy };
  }

  /** B2③：stdout+stderr 合并后逐 pattern 掩码（命中即 ***，明文不出模块）。 */
  private mask(raw: ExecResult): string {
    let text = [raw.stdout, raw.stderr].filter((s) => s !== "").join("\n");
    for (const p of this.patterns) text = text.replace(p, "***");
    return text;
  }
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
