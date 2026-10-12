import { describe, expect, it } from "vitest";
import { FakeClock, FakeExec, FakePusher } from "./index.ts";

describe("票 13 FakeClock：manual drive（fx.md 钉死契约：手动推进、到期定时器按序触发后返回）", () => {
  it("step 推进 now；到期定时器按（到期时刻, 调度序）同步触发后返回", () => {
    const clock = new FakeClock();
    expect(clock.now()).toBe(0);

    const fired: string[] = [];
    clock.setTimeout(() => fired.push("a"), 10);
    clock.setTimeout(() => fired.push("b"), 5);
    clock.setTimeout(() => fired.push("c"), 5); // 同到期时刻：按调度序 FIFO

    clock.step(5);
    expect(clock.now()).toBe(5);
    expect(fired).toEqual(["b", "c"]); // 只触发已到期者，其余不动

    clock.step(5);
    expect(clock.now()).toBe(10);
    expect(fired).toEqual(["b", "c", "a"]);
  });

  it("cancel 阻止触发；回调内再调度：到期内链式触发，超出本步不触发", () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    const seenNow: number[] = [];

    const cancelled = clock.setTimeout(() => fired.push("x"), 10);
    cancelled.cancel();
    clock.setTimeout(() => {
      seenNow.push(clock.now()); // 触发时刻语义：回调内 now() = 该定时器到期时刻，非 step 终点
      fired.push("chain");
      clock.setTimeout(() => fired.push("inner-due"), 5); // due 15 ≤ 本步终点 20
      clock.setTimeout(() => fired.push("inner-late"), 100); // due 120 > 20
    }, 10);

    clock.step(20);
    expect(fired).toEqual(["chain", "inner-due"]);
    expect(seenNow).toEqual([10]);
    expect(clock.now()).toBe(20);

    clock.step(100);
    expect(fired).toEqual(["chain", "inner-due", "inner-late"]);
  });

  it("step(0) 触发 setTimeout(fn,0)；pendingCount 供零副作用断言（spec31 parked 断言载体）", () => {
    const clock = new FakeClock();
    const fired: number[] = [];

    clock.setTimeout(() => fired.push(1), 0);
    clock.step(0);
    expect(fired).toEqual([1]);

    clock.setTimeout(() => fired.push(2), 30);
    expect(clock.pendingCount).toBe(1);
    clock.step(30);
    expect(clock.pendingCount).toBe(0);
    expect(fired).toEqual([1, 2]);
  });
});

describe("票 13 FakeExec：脚本化响应序列（fx.md 钉死契约）", () => {
  it("按入队次序逐个消费；partial 结果补平台原形默认值（exitCode 0/空流/无信号/未超时）", async () => {
    const exec = new FakeExec();
    exec.enqueue({ stdout: "v3\n" }, { exitCode: 2, stderr: "assert failed\n" });

    await expect(exec.run("echo v3")).resolves.toEqual({
      exitCode: 0,
      signal: null,
      stdout: "v3\n",
      stderr: "",
      timedOut: false,
    });
    await expect(exec.run("false")).resolves.toMatchObject({ exitCode: 2, stderr: "assert failed\n" });
  });

  it("calls 按序记录每次执行的 command+opts（执行面收到的命令可断言）", async () => {
    const exec = new FakeExec();
    exec.enqueue({ exitCode: 0 });
    await exec.run("curl -sf https://x/status", { timeoutMs: 10_000, env: { no_proxy: "*" } });
    expect(exec.calls).toEqual([
      { command: "curl -sf https://x/status", opts: { timeoutMs: 10_000, env: { no_proxy: "*" } } },
    ]);
  });

  it("脚本耗尽再 run = 响亮失败（脚本不匹配是测试 bug，静默默认值会掩扇真断言）", async () => {
    const exec = new FakeExec();
    exec.enqueue({ exitCode: 0 });
    await exec.run("only-scripted");
    await expect(exec.run("un-scripted")).rejects.toThrowError(/script exhausted.*un-scripted/s);
  });
});

describe("票 13 FakePusher：push 记录 + 注入投递失败（fx.md 钉死：close/reject 路径）", () => {
  it("push 逐行按序记录；无注入时 resolve", async () => {
    const pusher = new FakePusher();
    await pusher.push('{"jsonrpc":"2.0","method":"wake/1"}');
    await pusher.push('{"jsonrpc":"2.0","method":"wake/2"}');
    expect(pusher.pushed).toEqual(['{"jsonrpc":"2.0","method":"wake/1"}', '{"jsonrpc":"2.0","method":"wake/2"}']);
  });

  it("预注入失败：push reject 该错误且不记录；失败耗尽后恢复投递（k 次失败后成功可脚本化）", async () => {
    const pusher = new FakePusher();
    const closed = new Error("socket closed");
    pusher.failures.push(closed, new Error("EPIPE"));

    await expect(pusher.push("m1")).rejects.toBe(closed);
    expect(pusher.pushed).toEqual([]); // 失败的投递不记入 pushed
    await expect(pusher.push("m2")).rejects.toThrowError("EPIPE");
    await pusher.push("m3");
    expect(pusher.pushed).toEqual(["m3"]);
  });
});
