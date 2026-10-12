import { describe, expect, it } from "vitest";
import { FakeClock } from "./index.ts";

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
