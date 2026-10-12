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

describe("票 16 — checker 池 ≤8（第 9 个排队，空位释放才启动）", () => {
  it("9 个 slot 只跑 8 个，按提交序取前 8", () => {
    const exec = new DeferredExec();
    const p = new prober.Prober({ exec, clock: new fx.FakeClock(), onResult: () => undefined });
    for (let i = 0; i < 9; i++) p.probe({ slotKey: `s${i}`, check: `c${i}` });
    expect(exec.calls).toHaveLength(8);
    expect(exec.calls.map((c) => c.command)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
  });

  it("一个 slot 结算即释放空位，队首第 9 个补位启动", async () => {
    const exec = new DeferredExec();
    const p = new prober.Prober({ exec, clock: new fx.FakeClock(), onResult: () => undefined });
    for (let i = 0; i < 9; i++) p.probe({ slotKey: `s${i}`, check: `c${i}` });
    exec.resolve(3, { exitCode: 0 });
    await tick();
    expect(exec.calls).toHaveLength(9);
    expect(exec.calls[8].command).toBe("c8");
  });

  it("超时结算不释放执行容量：exec 未终止不补位（实际并发不超 8），Exec 终止（超时杀形）后才补位", async () => {
    const exec = new DeferredExec();
    const clock = new fx.FakeClock();
    const results: prober.ProbeResult[] = [];
    const p = new prober.Prober({ exec, clock, onResult: (r) => results.push(r) });
    for (let i = 0; i < 9; i++) p.probe({ slotKey: `s${i}`, check: `c${i}` });
    expect(exec.calls).toHaveLength(8);
    clock.step(10_000); // 8 个全部超时结算：结果回流，但进程（fake 挂起未决）仍在「跑」
    expect(results).toHaveLength(8); // 超时结果照常回流
    expect(exec.calls).toHaveLength(8); // 未确认执行终止：不补位
    exec.resolve(0, { exitCode: null, timedOut: true }); // ShellExec 超时杀形终止（fx Exec 契约）
    await tick();
    expect(exec.calls).toHaveLength(9); // 执行终止 → 此时才补位
    expect(exec.calls[8].command).toBe("c8");
  });
});

describe("票 16 — completion queue 回流顺序与提交序一致", () => {
  it("完成乱序（b 先于 a）→ 回流仍按提交序，先完成者缓冲待序", async () => {
    const exec = new DeferredExec();
    const results: prober.ProbeResult[] = [];
    const p = new prober.Prober({ exec, clock: new fx.FakeClock(), onResult: (r) => results.push(r) });
    p.probe({ slotKey: "a", check: "c1" });
    p.probe({ slotKey: "b", check: "c2" });
    p.probe({ slotKey: "c", check: "c3" });
    exec.resolve(1, { exitCode: 2 }); // b 先完成
    await tick();
    expect(results).toEqual([]); // 前序 a 未结算，b 缓冲不回流
    exec.resolve(0); // a 完成 → a,b 按序回流
    await tick();
    expect(results.map((r) => r.slotKey)).toEqual(["a", "b"]);
    exec.resolve(2, { exitCode: 1 });
    await tick();
    expect(results.map((r) => r.slotKey)).toEqual(["a", "b", "c"]);
  });

  it("超时结算也占序位：a 超时、b 先完成，回流仍 a 在前", async () => {
    const exec = new DeferredExec();
    const clock = new fx.FakeClock();
    const results: prober.ProbeResult[] = [];
    const p = new prober.Prober({ exec, clock, onResult: (r) => results.push(r) });
    p.probe({ slotKey: "a", check: "c1" });
    p.probe({ slotKey: "b", check: "c2" });
    exec.resolve(1, { exitCode: 0 }); // b 先完成
    await tick(); // b 结算落缓冲（a 未结算不回流）
    expect(results).toEqual([]);
    clock.step(10_000); // a 超时结算 → a,b 按提交序回流
    expect(results.map((r) => r.slotKey)).toEqual(["a", "b"]);
    expect(results.map((r) => r.verdict)).toEqual(["waiting", "passed"]);
  });
});

describe("票 16 — B2② no_proxy 全局注入 / B2③ token 脱敏", () => {
  it("noProxy 注入 exec env（no_proxy + NO_PROXY 大小写双形，内网 checker 免代理）", () => {
    const exec = new DeferredExec();
    new prober.Prober({ exec, clock: new fx.FakeClock(), onResult: () => undefined, noProxy: "gl.corp,.internal" }).probe({
      slotKey: "s",
      check: "curl -sf http://gl.corp/api/health",
    });
    expect(exec.calls[0].opts?.env).toEqual({ no_proxy: "gl.corp,.internal", NO_PROXY: "gl.corp,.internal" });
  });

  it("未配 noProxy → 不传 env（fx 叠加语义不空转）", () => {
    const exec = new DeferredExec();
    new prober.Prober({ exec, clock: new fx.FakeClock(), onResult: () => undefined }).probe({ slotKey: "s", check: "true" });
    expect(exec.calls[0].opts?.env).toBeUndefined();
  });

  it("stdout 命中 glpat token → 掩码 ***，明文不出模块（B2③ 执行点）", async () => {
    const exec = new fx.FakeExec();
    exec.enqueue({ exitCode: 0, stdout: "curl ok, used glpat-AbCdEf123456 confidentially" });
    const results: prober.ProbeResult[] = [];
    new prober.Prober({ exec, clock: new fx.FakeClock(), onResult: (r) => results.push(r) }).probe({ slotKey: "s", check: "x" });
    await tick();
    expect(results[0].evidence).toBe("curl ok, used *** confidentially");
  });

  it("Bearer 头与赋值形机密同款掩码；stdout+stderr 合流后一并脱敏", async () => {
    const exec = new fx.FakeExec();
    exec.enqueue({ exitCode: 3, stdout: "Bearer abc123.XYZ sent", stderr: "password=hunter2 rejected" });
    const results: prober.ProbeResult[] = [];
    new prober.Prober({ exec, clock: new fx.FakeClock(), onResult: (r) => results.push(r) }).probe({ slotKey: "s", check: "x" });
    await tick();
    expect(results[0].evidence).toBe("*** sent\n*** rejected");
  });

  it("自定义 tokenPatterns 替换内置集", async () => {
    const exec = new fx.FakeExec();
    exec.enqueue({ exitCode: 0, stdout: "glpat-AbCdEf123456 sk-zebra-99" });
    const results: prober.ProbeResult[] = [];
    new prober.Prober({
      exec,
      clock: new fx.FakeClock(),
      onResult: (r) => results.push(r),
      tokenPatterns: [/sk-[\w-]+/g],
    }).probe({ slotKey: "s", check: "x" });
    await tick();
    expect(results[0].evidence).toBe("glpat-AbCdEf123456 ***");
  });
});

describe("票 16 修复 — ocr 评审 Finding 1：rejection reason 同套掩码", () => {
  it("exec 拒绝携带凭据 → reason 掩码，明文不出模块（拒绝路径与 evidence 同一规则）", async () => {
    const exec = new fx.FakeExec();
    exec.enqueueFailure(new Error("authorization: Bearer abc123.XYZ expired"));
    const results: prober.ProbeResult[] = [];
    new prober.Prober({ exec, clock: new fx.FakeClock(), onResult: (r) => results.push(r) }).probe({
      slotKey: "s",
      check: "x",
    });
    await tick();
    expect(results[0].verdict).toBe("waiting");
    expect(results[0].reason).toBe("exec error: authorization: *** expired");
  });

  it("自定义 tokenPatterns 对拒绝路径同样生效（替换内置集）", async () => {
    const exec = new fx.FakeExec();
    exec.enqueueFailure(new Error("dump: sk-zebra-99 leaked"));
    const results: prober.ProbeResult[] = [];
    new prober.Prober({
      exec,
      clock: new fx.FakeClock(),
      onResult: (r) => results.push(r),
      tokenPatterns: [/sk-[\w-]+/g],
    }).probe({ slotKey: "s", check: "x" });
    await tick();
    expect(results[0].reason).toBe("exec error: dump: *** leaked");
  });
});

describe("票 16 修复 — ocr 评审 Finding 2：onResult 回调异常隔离", () => {
  it("onResult 抛错：该条目不重复投递，后续缓冲照常排空", async () => {
    const exec = new fx.FakeExec();
    exec.enqueue({ exitCode: 0 }, { exitCode: 0 });
    const delivered: string[] = [];
    let calls = 0;
    const p = new prober.Prober({
      exec,
      clock: new fx.FakeClock(),
      onResult: (r) => {
        calls++;
        if (calls === 1) throw new Error("consumer boom");
        delivered.push(r.slotKey);
      },
    });
    p.probe({ slotKey: "a", check: "c1" });
    p.probe({ slotKey: "b", check: "c2" });
    await tick();
    expect(calls).toBe(2); // a 只投递一次（抛错即消费，不重投）
    expect(delivered).toEqual(["b"]); // b 未被卡死
  });

  it("超时回流遇 onResult 抛错：异常不逃逸 Clock 定时器，后续到期定时器照常结算", () => {
    const exec = new DeferredExec();
    const clock = new fx.FakeClock();
    const delivered: string[] = [];
    let calls = 0;
    const p = new prober.Prober({
      exec,
      clock,
      onResult: (r) => {
        calls++;
        if (calls === 1) throw new Error("consumer boom");
        delivered.push(r.slotKey);
      },
    });
    p.probe({ slotKey: "a", check: "c1" });
    p.probe({ slotKey: "b", check: "c2" });
    clock.step(10_000); // a、b 定时器同刻到期，按调度序先后触发；首抛不得中断 step 循环
    expect(calls).toBe(2);
    expect(delivered).toEqual(["b"]);
    expect(clock.pendingCount).toBe(0); // 两笔定时器都取消（都结算）
  });
});

describe("票 16 修复 — ocr 评审 Finding 4：timeoutMs 分配前校验/规范化", () => {
  it("timeoutMs 非法（0/负数/NaN/Infinity）→ probe 同步抛参数错，不启动 exec 不占容量", () => {
    const exec = new DeferredExec();
    const p = new prober.Prober({ exec, clock: new fx.FakeClock(), onResult: () => undefined });
    expect(() => p.probe({ slotKey: "s", check: "x", timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => p.probe({ slotKey: "s", check: "x", timeoutMs: -1 })).toThrow(/timeoutMs/);
    expect(() => p.probe({ slotKey: "s", check: "x", timeoutMs: Number.NaN })).toThrow(/timeoutMs/);
    expect(() => p.probe({ slotKey: "s", check: "x", timeoutMs: Number.POSITIVE_INFINITY })).toThrow(/timeoutMs/);
    expect(exec.calls).toHaveLength(0);
  });

  it("timeoutMs 小数规范化为整数毫秒（向上取整，不短于请求值）后再封顶 300s", () => {
    const exec = new DeferredExec();
    const p = new prober.Prober({ exec, clock: new fx.FakeClock(), onResult: () => undefined });
    p.probe({ slotKey: "a", check: "x", timeoutMs: 0.5 });
    p.probe({ slotKey: "b", check: "x", timeoutMs: 1500.7 });
    p.probe({ slotKey: "c", check: "x", timeoutMs: 300_000.9 });
    expect(exec.calls.map((c) => c.opts?.timeoutMs)).toEqual([1, 1501, prober.PROBE_TIMEOUT_MAX_MS]);
  });
});

describe("票 16 修复 — ocr 评审 Finding 5：run 同步抛错转 waiting", () => {
  it("第 9 个 run 同步抛错：该任务 waiting 回流，前后任务按提交序照常回流（前任务 seq 不缺失）", async () => {
    const exec = new fx.FakeExec();
    for (let i = 0; i < 8; i++) exec.enqueue({ exitCode: 0 });
    exec.enqueueFailure(new Error("spawn ENOENT"), true); // 补位启动的 s8 同步抛
    const results: prober.ProbeResult[] = [];
    const p = new prober.Prober({ exec, clock: new fx.FakeClock(), onResult: (r) => results.push(r) });
    for (let i = 0; i < 9; i++) p.probe({ slotKey: `s${i}`, check: `c${i}` });
    await tick();
    expect(results.map((r) => r.slotKey)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]);
    expect(results[8].verdict).toBe("waiting");
    expect(results[8].reason).toBe("exec error: spawn ENOENT");
  });

  it("onResult 内重入 probe + 抛错：重入任务取后续 seq 照常执行，队列不卡死", async () => {
    const exec = new fx.FakeExec();
    exec.enqueue({ exitCode: 0 }, { exitCode: 0 }, { exitCode: 0 }, { exitCode: 2 });
    const delivered: string[] = [];
    let reentered = false;
    const p = new prober.Prober({
      exec,
      clock: new fx.FakeClock(),
      onResult: (r) => {
        if (r.slotKey === "a") {
          if (!reentered) {
            reentered = true;
            p.probe({ slotKey: "d", check: "c4" }); // 重入
          }
          throw new Error("consumer boom"); // a 的每次投递都抛
        }
        delivered.push(r.slotKey);
      },
    });
    p.probe({ slotKey: "a", check: "c1" });
    p.probe({ slotKey: "b", check: "c2" });
    p.probe({ slotKey: "c", check: "c3" });
    await tick();
    expect(reentered).toBe(true);
    expect(exec.calls.map((c) => c.command)).toEqual(["c1", "c2", "c3", "c4"]); // 重入 probe 照常执行
    expect(delivered).toEqual(["b", "c", "d"]); // a 抛错即消费不重投；b、c、d 按序排空
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
