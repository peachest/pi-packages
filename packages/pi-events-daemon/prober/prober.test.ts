/**
 * Ticket 16 acceptance tests — probe 引擎 + completion queue 回流（D4 零依赖）。
 * B 层：fx FakeExec/FakeClock 注入，不 spawn 真进程（真执行器仅文末一条冒烟）。
 *
 * 零依赖断言（prober 不 import kernel/domain/store）由 lint:boundaries 的
 * eda-adapter-fx-only 规则机器执行（verify 链第三步），不在本文件重复。
 */
import { describe, expect, it, vi } from "vitest";
import * as fx from "../fx/index.ts";
import * as prober from "./index.ts";

/** 微任务冲刷：FakeExec 立即 resolve，settle→回流经微任务落地。 */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 可控延迟执行器：run 记录参数并挂起，测试按调用序手动放行（超时/乱序完成场景）。 */
class DeferredExec implements fx.Exec {
  readonly calls: { command: string; opts?: fx.ExecOptions }[] = [];
  private resolvers: ((r: fx.ExecResult) => void)[] = [];

  run(command: string, opts?: fx.ExecOptions): Promise<fx.ExecResult> {
    this.calls.push({ command, opts });
    return new Promise((resolve) => this.resolvers.push(resolve));
  }

  /** 手动放行第 at 次调用（缺省 exit 0；已超时结算的槽位迟到放行=死 promise，无害）。 */
  resolve(at: number, result: Partial<fx.ExecResult> = {}): void {
    this.resolvers[at]({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, ...result });
  }
}

describe("票 16 — 三态映射（#31 正典：0=passed / 2=failed 断言 / 其他=waiting）", () => {
  const MATRIX: [string, Partial<fx.ExecResult>, prober.Verdict, string][] = [
    ["exit 0 → passed", { exitCode: 0 }, "passed", "exit 0"],
    ["exit 2 → failed 断言", { exitCode: 2 }, "failed", "exit 2"],
    ["exit 1 → waiting", { exitCode: 1 }, "waiting", "exit 1"],
    ["exit 3 → waiting", { exitCode: 3 }, "waiting", "exit 3"],
    ["signal SIGTERM → waiting", { exitCode: null, signal: "SIGTERM" }, "waiting", "signal SIGTERM"],
    ["无退出码（spawn 失败形）→ waiting", { exitCode: null, signal: null }, "waiting", "no exit"],
  ];
  for (const [name, scripted, verdict, reason] of MATRIX) {
    it(name, async () => {
      const exec = new fx.FakeExec();
      exec.enqueue(scripted);
      const results: prober.ProbeResult[] = [];
      new prober.Prober({ exec, clock: new fx.FakeClock(), onResult: (r) => results.push(r) }).probe({
        slotKey: "s",
        check: "true",
      });
      await tick();
      // 退出码只进 reason 文本，verdict 一律语义名（#31：退出码不外泄）
      expect(results).toEqual([{ slotKey: "s", verdict, reason, evidence: "", durationMs: 0 }]);
    });
  }

  it("exec 报 timedOut → waiting（fx Exec 杀进程，prober 归类）", async () => {
    const exec = new fx.FakeExec();
    exec.enqueue({ exitCode: null, timedOut: true });
    const results: prober.ProbeResult[] = [];
    new prober.Prober({ exec, clock: new fx.FakeClock(), onResult: (r) => results.push(r) }).probe({
      slotKey: "s",
      check: "sleep 999",
    });
    await tick();
    expect(results).toEqual([
      { slotKey: "s", verdict: "waiting", reason: "timeout after 10000ms", evidence: "", durationMs: 0 },
    ]);
  });

  it("非 poll source 同步拒绝（watch 监听建立/关闭归 watch 票，静默按 poll 执行是错语义）", () => {
    const p = new prober.Prober({
      exec: new fx.FakeExec(),
      clock: new fx.FakeClock(),
      onResult: () => undefined,
    });
    expect(() => p.probe({ slotKey: "w", check: "x", source: "fs-watch" })).toThrow(/fs-watch/);
    expect(() => p.probe({ slotKey: "w", check: "x", source: "k8s-watch" })).toThrow(/k8s-watch/);
  });
});

describe("票 16 — 超时策略（缺省 10s / 上限 300s，fx Clock 计时）", () => {
  it("缺省 timeoutMs=10s 传给 Exec，Clock 10s 到点判 waiting 并取消定时器", () => {
    const exec = new DeferredExec();
    const clock = new fx.FakeClock();
    const results: prober.ProbeResult[] = [];
    new prober.Prober({ exec, clock, onResult: (r) => results.push(r) }).probe({ slotKey: "s", check: "sleep 999" });
    expect(exec.calls[0].opts?.timeoutMs).toBe(prober.PROBE_TIMEOUT_DEFAULT_MS);
    clock.step(9_999);
    expect(results).toHaveLength(0);
    clock.step(1);
    expect(results).toEqual([
      { slotKey: "s", verdict: "waiting", reason: "timeout after 10000ms", evidence: "", durationMs: 10_000 },
    ]);
    expect(clock.pendingCount).toBe(0);
  });

  it("timeoutMs 超上限封顶 300s（300_001 → 300_000），Clock 300s 到点判 waiting", () => {
    const exec = new DeferredExec();
    const clock = new fx.FakeClock();
    const results: prober.ProbeResult[] = [];
    new prober.Prober({ exec, clock, onResult: (r) => results.push(r) }).probe({
      slotKey: "s",
      check: "sleep 999",
      timeoutMs: 300_001,
    });
    expect(exec.calls[0].opts?.timeoutMs).toBe(prober.PROBE_TIMEOUT_MAX_MS);
    clock.step(300_000);
    expect(results).toEqual([
      { slotKey: "s", verdict: "waiting", reason: "timeout after 300000ms", evidence: "", durationMs: 300_000 },
    ]);
  });

  it("上限恰等 300_000 原样通过", () => {
    const exec = new DeferredExec();
    new prober.Prober({ exec, clock: new fx.FakeClock(), onResult: () => undefined }).probe({
      slotKey: "s",
      check: "x",
      timeoutMs: 300_000,
    });
    expect(exec.calls[0].opts?.timeoutMs).toBe(300_000);
  });

  it("exec 先决 → 定时器取消，不出超时结果", async () => {
    const exec = new fx.FakeExec();
    exec.enqueue({ exitCode: 0 });
    const clock = new fx.FakeClock();
    const results: prober.ProbeResult[] = [];
    new prober.Prober({ exec, clock, onResult: (r) => results.push(r) }).probe({ slotKey: "s", check: "true" });
    await tick();
    expect(results).toEqual([expect.objectContaining({ verdict: "passed" })]);
    expect(clock.pendingCount).toBe(0);
    clock.step(60_000);
    expect(results).toHaveLength(1);
  });

  it("到点后才放行的迟到结果被丢弃（不二次回流）", async () => {
    const exec = new DeferredExec();
    const clock = new fx.FakeClock();
    const results: prober.ProbeResult[] = [];
    new prober.Prober({ exec, clock, onResult: (r) => results.push(r) }).probe({ slotKey: "s", check: "sleep 999" });
    clock.step(10_000);
    expect(results).toHaveLength(1);
    exec.resolve(0, { exitCode: 0 });
    await tick();
    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe("waiting");
  });
});

describe("票 16 — 真 spawn 冒烟（真执行器 adapter 存在性证明，fx-ports-real 先例不跳过）", () => {
  it("ShellExec + SystemClock 全链：exit 0 → passed / exit 2 → failed", async () => {
    const results: prober.ProbeResult[] = [];
    const p = new prober.Prober({
      exec: new fx.ShellExec(),
      clock: new fx.SystemClock(),
      onResult: (r) => results.push(r),
    });
    p.probe({ slotKey: "ok", check: "true" });
    p.probe({ slotKey: "fail", check: "exit 2" });
    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(results.map((r) => r.verdict).sort()).toEqual(["failed", "passed"]);
  });
});
