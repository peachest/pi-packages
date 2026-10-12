import { describe, expect, it } from "vitest";
import { FakeClock, FakeExec, FakeFs, FakePusher } from "./index.ts";
import type { Clock, Exec, Fs, Pusher } from "./index.ts";

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

  it("重入 step：回调内 step 推进超过本步终点时保留最大值，now() 单调不减", () => {
    const clock = new FakeClock();
    const seenNow: number[] = [];

    clock.setTimeout(() => {
      seenNow.push(clock.now()); // 触发时刻 10
      clock.step(15); // 内层重入推进到 25
      seenNow.push(clock.now());
    }, 10);
    clock.step(10); // 外层终点 10——不得把 25 拉回 10

    expect(seenNow).toEqual([10, 25]);
    expect(clock.now()).toBe(25);
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

  it("enqueueFailure 注入 Promise 拒绝：与 enqueue 同队按调用序混排消费", async () => {
    const exec = new FakeExec();
    exec.enqueue({ exitCode: 0 });
    exec.enqueueFailure(new Error("boom"));
    exec.enqueue({ exitCode: 2 });
    await expect(exec.run("first")).resolves.toMatchObject({ exitCode: 0 });
    await expect(exec.run("second")).rejects.toThrowError("boom");
    await expect(exec.run("third")).resolves.toMatchObject({ exitCode: 2 });
  });

  it("enqueueFailure(err, true) 同步抛错——run 不返回 Promise（调用方 try/catch 面的 fake 载体，票 13 契约延续）", () => {
    const exec = new FakeExec();
    exec.enqueueFailure(new Error("sync boom"), true);
    expect(() => exec.run("x")).toThrowError("sync boom");
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

describe("票 13 FakeFs：内存树 + 撕裂尾行 fixture（fx.md 钉死契约）", () => {
  it("readFile 返回内存树内容；树可变（重写后新读生效）", async () => {
    const ffs = new FakeFs({ "/t/a.jsonl": '{"v":3}\n' });
    await expect(ffs.readFile("/t/a.jsonl")).resolves.toBe('{"v":3}\n');
    ffs.files.set("/t/a.jsonl", '{"v":3}\n{"v":4}\n');
    await expect(ffs.readFile("/t/a.jsonl")).resolves.toBe('{"v":3}\n{"v":4}\n');
  });

  it("缺失路径 reject code=ENOENT（与 NodeFs 同形，ENOENT 等分类归调用方）", async () => {
    const ffs = new FakeFs();
    await expect(ffs.readFile("/t/missing.jsonl")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("撕裂尾行 fixture：无尾换行的截断行原样往返（transcript-adapter 撕裂场景载体）", async () => {
    const torn = '{"v":3}\n{"v":4'; // 末条撕裂：截断且无换行
    const ffs = new FakeFs({ "/t/b.jsonl": torn });
    await expect(ffs.readFile("/t/b.jsonl")).resolves.toBe(torn);
  });
});

describe("票 13 四 fake 经公共面注入各自端口（每端口恰好两 adapter：real + fake）", () => {
  it("四 fake 满足端口类型且经 fx 入口可用", () => {
    const clock: Clock = new FakeClock();
    const exec: Exec = new FakeExec();
    const pusher: Pusher = new FakePusher();
    const ffs: Fs = new FakeFs();
    void clock;
    void exec;
    void pusher;
    void ffs;
  });
});
