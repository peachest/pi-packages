/**
 * Ticket 15 — 效应类别 ↔ 注入面映射验证（fx.md 映射表落测试，第五停点合流）。
 *
 * fx.md 裁定映射表：持久化写→Store fake 注入回调（第五停点，非 fx 端口）；
 * socket 推送→Pusher；checker 执行→Exec；transcript 扫描→Fs（只读）；时钟/定时→Clock。
 * 每类一条样例测试证明「经映射面注入可达」：消费方签名只收映射面（持久化写用真消费方
 * kernel.transition），注入 fake 后该类外部效应确定可产生、可观测、可控——loops 全部
 * 外部效应可注入的构造性事实（fx.md Solution）。X1/X2 经 Store fake 回调复现（与 23 联动）。
 *
 * 位置：integration 测试文件（票面允许）；tests/ 受 tests-through-entrypoints 约束，
 * 经包根入口命名空间导入（同 protocol-schemas.test.ts 惯例）。
 */
import { describe, expect, it } from "vitest";
import { fx, store, kernel } from "../index.ts";

const { FakeClock, FakeExec, FakeFs, FakePusher } = fx;
const { createMemoryStore, MemoryStore } = store;
const { Kernel } = kernel;
type Clock = fx.Clock;
type Exec = fx.Exec;
type Fs = fx.Fs;
type Pusher = fx.Pusher;
type EventRow = store.EventRow;
type Store = store.Store;
type MemStore = store.MemoryStore; // 类类型经命名空间限定别名（解构绑定仅值）

// --- fixture（数据，非 profile；同 kernel.test 惯例）---
const REF = { type: "fixture:widget", key: "external/fixture-1" } as const;
const VERDICT_STATES = new Set(["passed", "failed"]);
const at = (n: number) => `2026-10-12T00:00:${String(n).padStart(2, "0")}Z`;
const evRow = (n: number): EventRow => ({
  eventId: `evt:fixture:widget-1#${n}`,
  eventSeq: n,
  entityRefType: REF.type,
  entityRefKey: REF.key,
  from: "passed",
  to: "failed",
  contentIdentity: `sha-${n}`,
  occurredAt: at(n),
});
const seedPassed = (store: Store) => store.putEntity({ type: REF.type, key: REF.key, state: "passed" });

describe("票 15：五效应类别逐一经映射表注入可达（每类一条样例）", () => {
  it("时钟/定时 → Clock：1s 兜底扫只经 Clock 调度，manual drive 确定性触发", () => {
    const scheduleFallbackSweep = (clock: Clock, fire: () => void) => clock.setTimeout(fire, 1_000);
    const clock = new FakeClock();
    let swept = 0;
    scheduleFallbackSweep(clock, () => swept++);
    clock.step(999);
    expect(swept).toBe(0); // 未到期零副作用
    clock.step(1);
    expect(swept).toBe(1); // 到期恰触发一次，时间经注入面完全可控
  });

  it("socket 推送 → Pusher：L2 wake 投递只经 Pusher 出口，成功可断言、close/reject 可注入", async () => {
    const deliverWake = (pusher: Pusher, sessionId: string) => pusher.push(`wake ${sessionId}`);
    const pusher = new FakePusher();
    await deliverWake(pusher, "s1");
    expect(pusher.pushed).toEqual(["wake s1"]);
    pusher.failures.push(new Error("socket closed")); // fx.md 钉死的 close/reject 注入路径
    await expect(deliverWake(pusher, "s2")).rejects.toThrow("socket closed");
    expect(pusher.pushed).toEqual(["wake s1"]); // 失败的投递不产生外部效应
  });

  it("checker 执行 → Exec：checker 只经 Exec 执行，脚本化响应序列确定可控", async () => {
    const runChecker = (exec: Exec, command: string) => exec.run(command);
    const exec = new FakeExec();
    exec.enqueue({ exitCode: 0, stdout: "clean\n" }, { exitCode: 2 }); // 平台原形：0=passed / 2=failed 断言
    expect(await runChecker(exec, "tsc --noEmit")).toMatchObject({ exitCode: 0, stdout: "clean\n" });
    expect(await runChecker(exec, "tsc --noEmit")).toMatchObject({ exitCode: 2 });
    expect(exec.calls.map((c) => c.command)).toEqual(["tsc --noEmit", "tsc --noEmit"]);
  });

  it("transcript 扫描 → Fs：扫描只经只读 Fs 面，撕裂尾行 fixture 与 ENOENT 可复现", async () => {
    const lastLine = async (fs: Fs, path: string) =>
      (await fs.readFile(path)).split("\n").filter(Boolean).at(-1);
    const fs = new FakeFs({ "/sessions/a.jsonl": '{"seq":1}\n{"seq":2}\n{"seq":2' }); // 撕裂尾行：无尾换行截断
    expect(await lastLine(fs, "/sessions/a.jsonl")).toBe('{"seq":2');
    await expect(lastLine(fs, "/sessions/missing.jsonl")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("持久化写 → Store fake 第五停点：真消费方 kernel.transition 只经 Store 落库（transition+event+outbox 同事务 I1）", () => {
    const store = createMemoryStore();
    seedPassed(store);
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    expect(kernel.transition(REF, "failed", at(1))).toMatchObject({ eventSeq: 1, from: "passed", to: "failed" });
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("failed");
    // notificationId = 确定性 eventId（同 ref+decisionOrder 恒同 id，domain 正典）——
    // 格式断言归 kernel/domain 同位测试；此处验证映射面：经 Store 落库一行 outbox、eventSeq 对齐
    const [outboxRow] = store.outboxBatch(10);
    expect(outboxRow).toMatchObject({ eventSeq: 1 });
    expect(typeof outboxRow?.notificationId).toBe("string");
    expect(store.outboxBatch(10)).toHaveLength(1);
  });
});

describe("票 15：X1/X2 崩溃经 Store fake 回调（injectCrash）复现（与 23 联动）", () => {
  it("X1（事务中途）：injectCrash('tx') 复现 crash 态——staging 丢弃零残留、停点一次性；真消费方重试界内吸收同序收口", () => {
    const store = createMemoryStore();
    seedPassed(store);
    store.injectCrash("tx");
    expect(() =>
      store.tx((tx) => {
        tx.putEvent(evRow(1));
        tx.putEntity({ type: REF.type, key: REF.key, state: "failed" });
      }),
    ).toThrow(/X1 crash/); // 事务中途崩：注入沿第五停点触发
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("passed"); // 事务原子：staging 丢弃
    expect(store.tx((tx) => tx.getEvent(evRow(1).eventId))).toBeUndefined();
    // 真消费方（kernel.transition）经同一停点可达：一次性停点被重试界内吸收，同 eventSeq 幂等收口（不烧号）
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    expect(kernel.transition(REF, "failed", at(1))).toMatchObject({ eventSeq: 1, from: "passed", to: "failed" });
  });

  it("X2（已提交未写 outbox）：injectCrash('outbox') 复现——outbox 未落库、重放输入留痕（票 23 重启重放钩子）", () => {
    const store = createMemoryStore();
    store.injectCrash("outbox");
    expect(() =>
      store.tx((tx) => {
        tx.putEvent(evRow(1)); // transition 语义面已进 staging（"已提交"）
        tx.putOutbox({ notificationId: "n1", eventSeq: 1 }); // 注入点：outbox 写步
      }),
    ).toThrow(/X2 crash/);
    expect(store.outboxBatch(10)).toHaveLength(0); // 事务原子：重启后由重放补齐（appendIfMissing 幂等收口）
    expect((store as MemStore).getCommitOrder().at(-1)?.outboxPending).toEqual([
      expect.objectContaining({ notificationId: "n1", eventSeq: 1 }),
    ]);
  });
});
