/**
 * Ticket 08 acceptance tests — TransitionIntent 双轨 + verdict 阈值 + once/readyCheck + RunLedger 归零重探.
 * B 层：零 IO 零 fake 纯函数断言（spec #31 领域模型；模块 spec domain.md）。
 */
import { describe, it, expect } from "vitest";
import {
  FIRST_SEQUENCE,
  TRANSITIONED_FIELDS,
  planTransition,
  deterministicEventId,
  intentToEvent,
  appendIfMissing,
  reduceState,
  sameEventContent,
} from "./intent.ts";

const ref = (type = "gitlab:mr", key = "external/https://gitlab.example/a/b/-/merge_requests/1") => ({ type, key });
const clock = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`;

describe("R1 双轨：决策序与 eventSeq 各自单调，Intent 预分配确定性 event id", () => {
  it("两条轨道独立推进，互不替代", () => {
    const { intent, sequences } = planTransition(FIRST_SEQUENCE, {
      entityRef: ref(),
      from: null,
      to: "open",
      occurredAt: clock(1),
    });
    expect(intent.decisionOrder).toBe(1);
    expect(intent.eventSeq).toBe(1);
    expect(sequences).toEqual({ decisionOrder: 1, eventSeq: 1 });

    // 轨道位置不同的起点：各自 +1，eventSeq 不由 decisionOrder 推导
    const offset = planTransition({ decisionOrder: 41, eventSeq: 7 }, {
      entityRef: ref(),
      from: "open",
      to: "merged",
      occurredAt: clock(2),
    });
    expect(offset.intent.decisionOrder).toBe(42);
    expect(offset.intent.eventSeq).toBe(8);
  });

  it("连续规划：两轨道严格单调", () => {
    let seq = FIRST_SEQUENCE;
    const orders: number[] = [];
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const step = planTransition(seq, {
        entityRef: ref(),
        from: i === 0 ? null : "open",
        to: "open",
        occurredAt: clock(i),
      });
      orders.push(step.intent.decisionOrder);
      seqs.push(step.intent.eventSeq);
      seq = step.sequences;
    }
    expect(orders).toEqual([1, 2, 3, 4, 5]);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  it("event id 确定性：同 (entityRef, decisionOrder) 不同内容 → 同 id（appendIfMissing 异内容检测的前提）", () => {
    const a = deterministicEventId(ref(), 7);
    const b = deterministicEventId(ref(), 7);
    expect(a).toBe(b);
    expect(a).not.toBe(deterministicEventId(ref("gitlab:mr", "external/other"), 7));
    expect(a).not.toBe(deterministicEventId(ref(), 8));
  });
});

describe("appendIfMissing：同 id 跳过、异内容 = corruption（跨聚合一致性，#31）", () => {
  const make = (to: string, seq = FIRST_SEQUENCE) =>
    planTransition(seq, { entityRef: ref(), from: null, to, occurredAt: clock(1) }).intent;

  it("新 id → appended，事件字段与 Intent 逐一对应", () => {
    const intent = make("open");
    const { log, outcome } = appendIfMissing([], intent);
    expect(outcome.kind).toBe("appended");
    expect(log).toHaveLength(1);
    const event = intentToEvent(intent);
    expect(log[0]).toEqual(event);
    expect(event.entityRef).toEqual(intent.entityRef);
    expect(event.from).toBe(intent.from);
    expect(event.to).toBe(intent.to);
    expect(event.eventSeq).toBe(intent.eventSeq);
  });

  it("同 id 同内容 → skipped，幂等不重复追加", () => {
    const intent = make("open");
    const first = appendIfMissing([], intent);
    const second = appendIfMissing(first.log, intent);
    expect(second.outcome.kind).toBe("skipped");
    expect(second.log).toHaveLength(1);
  });

  it("同 id 异内容（to 不同）→ corruption，日志不动", () => {
    const intent = make("open");
    const first = appendIfMissing([], intent);
    const drifted = { ...intent, to: "merged" };
    const { log, outcome } = appendIfMissing(first.log, drifted);
    expect(outcome.kind).toBe("corruption");
    if (outcome.kind === "corruption") {
      expect(outcome.stored.to).toBe("open");
      expect(outcome.incoming.to).toBe("merged");
    }
    expect(log).toHaveLength(1);
  });

  it("同 id 异内容（eventSeq 不同）→ corruption——eventSeq 在字段清单内", () => {
    const intent = make("open");
    const first = appendIfMissing([], intent);
    const drifted = { ...intent, eventSeq: intent.eventSeq + 100 };
    const { outcome } = appendIfMissing(first.log, drifted);
    expect(outcome.kind).toBe("corruption");
  });
});

describe("Transitioned 事件族字段清单类型定死（09 corruption 异内容语义依赖）", () => {
  it("事件形状恰为清单字段（含可选字段全出现）", () => {
    const { intent } = planTransition(FIRST_SEQUENCE, {
      entityRef: ref(),
      from: null,
      to: "passed",
      contentIdentity: "sha256:abc",
      occurredAt: clock(1),
      evidenceRef: "evd:1",
    });
    const event = intentToEvent(intent);
    expect(Object.keys(event).sort()).toEqual([...TRANSITIONED_FIELDS].sort());
  });

  it("sameEventContent 逐字段比较清单内容（eventId 为匹配键，不参与内容比较）", () => {
    const { intent } = planTransition(FIRST_SEQUENCE, {
      entityRef: ref(),
      from: null,
      to: "passed",
      contentIdentity: "sha256:abc",
      occurredAt: clock(1),
      evidenceRef: "evd:1",
    });
    const event = intentToEvent(intent);
    expect(sameEventContent(event, { ...event })).toBe(true);
    expect(sameEventContent(event, { ...event, contentIdentity: "sha256:other" })).toBe(false);
    expect(sameEventContent(event, { ...event, occurredAt: clock(2) })).toBe(false);
    expect(sameEventContent(event, { ...event, evidenceRef: undefined })).toBe(false);
    // eventId 变化不影响内容比较（它是 appendIfMissing 的查找键）
    expect(sameEventContent(event, { ...event, eventId: "evt:other" })).toBe(true);
  });
});

describe("I1：transition 与 Transitioned 事件同事务原子（纯层：状态是事件流的纯归约）", () => {
  it("消费一个 Intent = 恰一条新事件 + 状态随之翻转，不可拆分", () => {
    const { intent } = planTransition(FIRST_SEQUENCE, {
      entityRef: ref(),
      from: null,
      to: "open",
      occurredAt: clock(1),
    });
    expect(reduceState([], ref())).toBeNull();
    const { log, outcome } = appendIfMissing([], intent);
    expect(outcome.kind).toBe("appended");
    expect(log).toHaveLength(1);
    expect(reduceState(log, ref())).toBe("open");
  });

  it("skipped（幂等重放）不改日志不改状态", () => {
    const { intent } = planTransition(FIRST_SEQUENCE, {
      entityRef: ref(),
      from: null,
      to: "open",
      occurredAt: clock(1),
    });
    const first = appendIfMissing([], intent);
    const second = appendIfMissing(first.log, intent);
    expect(second.outcome.kind).toBe("skipped");
    expect(second.log).toEqual(first.log);
    expect(reduceState(second.log, ref())).toBe("open");
  });

  it("多实体归约互不串扰，eventSeq 定归约顺序", () => {
    const a = ref("gitlab:mr", "external/mr-a");
    const b = ref("gitlab:mr", "external/mr-b");
    const ia = planTransition(FIRST_SEQUENCE, { entityRef: a, from: null, to: "open", occurredAt: clock(1) }).intent;
    const ib = planTransition({ decisionOrder: 1, eventSeq: 1 }, { entityRef: b, from: null, to: "running", occurredAt: clock(2) }).intent;
    const ic = planTransition({ decisionOrder: 2, eventSeq: 2 }, { entityRef: a, from: "open", to: "merged", occurredAt: clock(3) }).intent;
    const log = [ia, ib, ic].map(intentToEvent);
    expect(reduceState(log, a)).toBe("merged");
    expect(reduceState(log, b)).toBe("running");
    expect(reduceState(log, ref("gitlab:mr", "external/none"))).toBeNull();
  });
});

describe("I3：封闭集状态——消费侧同步拒绝集合外状态（查值不 import profiles，I-01）", () => {
  const states = new Set(["open", "merged", "closed"]);

  it("to 在集合外 → 抛错拒绝", () => {
    const { intent } = planTransition(FIRST_SEQUENCE, {
      entityRef: ref(),
      from: null,
      to: "bogus",
      occurredAt: clock(1),
    });
    expect(() => appendIfMissing([], intent, { states })).toThrow();
  });

  it("from 非空且在集合外 → 抛错；from=null 首转换合法", () => {
    const badFrom = planTransition(FIRST_SEQUENCE, {
      entityRef: ref(),
      from: "bogus",
      to: "open",
      occurredAt: clock(1),
    }).intent;
    expect(() => appendIfMissing([], badFrom, { states })).toThrow();

    const nullFrom = planTransition(FIRST_SEQUENCE, {
      entityRef: ref(),
      from: null,
      to: "open",
      occurredAt: clock(1),
    }).intent;
    expect(appendIfMissing([], nullFrom, { states }).outcome.kind).toBe("appended");
  });

  it("合法 to/from 通过；不传 states 不做校验", () => {
    const ok = planTransition(FIRST_SEQUENCE, {
      entityRef: ref(),
      from: "open",
      to: "merged",
      occurredAt: clock(1),
    }).intent;
    expect(appendIfMissing([], ok, { states }).outcome.kind).toBe("appended");
    expect(appendIfMissing([], ok).outcome.kind).toBe("appended");
  });
});

import {
  DEFAULT_THRESHOLDS,
  INITIAL_THRESHOLD_STATE,
  observeVerdict,
  onVerdict,
  checkForPhase,
  type Verdict,
} from "./intent.ts";

describe("verdict 阈值计数（k8s probe 语义）：N-1 不翻转、第 N 次翻转；成功恢复对称", () => {
  const drive = (verdicts: Verdict[], cfg = DEFAULT_THRESHOLDS) => {
    let state = INITIAL_THRESHOLD_STATE;
    const flips: boolean[] = [];
    for (const v of verdicts) {
      const step = observeVerdict(state, v, cfg);
      state = step.state;
      flips.push(step.flipped);
    }
    return { state, flips };
  };

  it("failureThreshold=3：F,F 不翻不发；第 3 次 F 翻转为 failed", () => {
    const { state, flips } = drive(["failed", "failed", "failed"], { failureThreshold: 3, successThreshold: 1 });
    expect(flips).toEqual([false, false, true]);
    expect(state.settled).toBe("failed");
    expect(state.consecutiveFails).toBe(3);
  });

  it("成功恢复对称：先 failed 到达，再 P,P 不翻；第 3 次 P 翻回 passed", () => {
    const drive = (verdicts: Verdict[], cfg = DEFAULT_THRESHOLDS) => {
      let st = INITIAL_THRESHOLD_STATE;
      const flips: boolean[] = [];
      for (const v of verdicts) {
        const step = observeVerdict(st, v, cfg);
        st = step.state;
        flips.push(step.flipped);
      }
      return { state: st, flips };
    };
    const arrived = drive(["failed", "failed", "failed"], { failureThreshold: 3, successThreshold: 1 });
    expect(arrived.state.settled).toBe("failed");
    const recovery = drive(["passed", "passed", "passed"], { failureThreshold: 1, successThreshold: 3 });
    expect(recovery.flips).toEqual([false, false, true]);
    expect(recovery.state.settled).toBe("passed");
  });

  it("默认阈值 1/1：首个 failed/passed 即翻转", () => {
    expect(drive(["failed"]).state.settled).toBe("failed");
    expect(drive(["passed"]).state.settled).toBe("passed");
  });

  it("计数期内不翻转不发事件：F,F 后 waiting 断连，重新计数", () => {
    const { state, flips } = drive(
      ["failed", "failed", "waiting", "failed"],
      { failureThreshold: 3, successThreshold: 1 },
    );
    expect(flips).toEqual([false, false, false, false]);
    expect(state.settled).toBeNull();
    expect(state.consecutiveFails).toBe(1);
  });

  it("持续失败不重复发：翻转后继续 failed 不再 flipped", () => {
    const { flips } = drive(
      ["failed", "failed", "failed", "failed"],
      { failureThreshold: 2, successThreshold: 1 },
    );
    expect(flips).toEqual([false, true, false, false]);
  });

  it("passed 与 failed 计数互斥重置（迟滞不对称场景）", () => {
    const { state, flips } = drive(
      ["failed", "passed", "failed", "failed", "failed"],
      { failureThreshold: 3, successThreshold: 2 },
    );
    expect(flips).toEqual([false, false, false, false, true]);
    expect(state.settled).toBe("failed");
  });
});

describe("I7 收窄：wait/flip 双形态 failed 处理差异（onVerdict 真值表 + 阈值联动逐例）", () => {
  it("onVerdict 真值表（once/twoStage/phase × verdict）", () => {
    const cases: Array<{
      shape: { once: boolean; twoStage: boolean };
      phase: "startup" | "flip";
      verdict: Verdict;
      want: { action: string; reason?: string };
    }> = [
      // waiting 永不关闭、不推进
      { shape: { once: true, twoStage: false }, phase: "flip", verdict: "waiting", want: { action: "stay-open" } },
      { shape: { once: false, twoStage: true }, phase: "startup", verdict: "waiting", want: { action: "stay-open" } },
      // failed：wait 形态（once 或 startup 阶段）终态关闭；flip 监视不关闭
      { shape: { once: true, twoStage: false }, phase: "flip", verdict: "failed", want: { action: "close", reason: "failed-terminal" } },
      { shape: { once: false, twoStage: true }, phase: "startup", verdict: "failed", want: { action: "close", reason: "failed-terminal" } },
      { shape: { once: false, twoStage: true }, phase: "flip", verdict: "failed", want: { action: "stay-open" } },
      { shape: { once: false, twoStage: false }, phase: "flip", verdict: "failed", want: { action: "stay-open" } },
      // passed：startup 通过 → 推进 flip；once 首 passed 关闭；普通监视不关闭
      { shape: { once: false, twoStage: true }, phase: "startup", verdict: "passed", want: { action: "advance" } },
      { shape: { once: true, twoStage: false }, phase: "flip", verdict: "passed", want: { action: "close", reason: "once-passed" } },
      { shape: { once: true, twoStage: true }, phase: "flip", verdict: "passed", want: { action: "close", reason: "once-passed" } },
      { shape: { once: false, twoStage: true }, phase: "flip", verdict: "passed", want: { action: "stay-open" } },
      { shape: { once: false, twoStage: false }, phase: "flip", verdict: "passed", want: { action: "stay-open" } },
    ];
    for (const c of cases) {
      const got = onVerdict(c.shape, c.phase, c.verdict);
      expect(got.action).toBe(c.want.action);
      if (c.want.reason) expect(got).toEqual({ action: "close", reason: c.want.reason });
    }
  });

  it("逐例：failureThreshold=3 时 wait 形态第 3 次 failed = 事件+终态关闭；flip 形态 = 翻转沿事件+继续监视", () => {
    const cfg = { failureThreshold: 3, successThreshold: 1 };
    let state = INITIAL_THRESHOLD_STATE;
    const waitCloses: boolean[] = [];
    const flipEvents: boolean[] = [];
    for (const v of ["failed", "failed", "failed", "failed"] as Verdict[]) {
      const step = observeVerdict(state, v, cfg);
      state = step.state;
      // wait 形态（ad-hoc 一次性等待）：failed 翻转到达即终态关闭
      waitCloses.push(step.flipped && onVerdict({ once: true, twoStage: false }, "flip", v).action === "close");
      // flip 形态：翻转沿发事件（flipped=true），订阅不关
      flipEvents.push(step.flipped && onVerdict({ once: false, twoStage: false }, "flip", v).action === "stay-open");
    }
    expect(waitCloses).toEqual([false, false, true, false]);
    expect(flipEvents).toEqual([false, false, true, false]);
  });

  it("flip 形态持续 failed 不重复发事件（翻转沿语义）", () => {
    const cfg = { failureThreshold: 1, successThreshold: 1 };
    let state = INITIAL_THRESHOLD_STATE;
    const flips: boolean[] = [];
    for (const v of ["failed", "failed", "failed"] as Verdict[]) {
      const step = observeVerdict(state, v, cfg);
      state = step.state;
      flips.push(step.flipped);
      expect(onVerdict({ once: false, twoStage: false }, "flip", v).action).toBe("stay-open");
    }
    expect(flips).toEqual([true, false, false]);
  });
});

describe("once / readyCheck 判定真值表", () => {
  it("once：首 passed 关闭判定已含于 onVerdict 表（once-passed / failed-terminal / waiting 不关）", () => {
    expect(onVerdict({ once: true, twoStage: false }, "flip", "passed")).toEqual({ action: "close", reason: "once-passed" });
    expect(onVerdict({ once: true, twoStage: false }, "flip", "failed")).toEqual({ action: "close", reason: "failed-terminal" });
    expect(onVerdict({ once: true, twoStage: false }, "flip", "waiting")).toEqual({ action: "stay-open" });
  });

  it("readyCheck：flip 判定第二 check，缺省沿用 check", () => {
    const spec = { check: "curl -sf localhost:8080/healthz", readyCheck: "curl -sf localhost:8080/ready" };
    expect(checkForPhase(spec, "startup")).toBe("curl -sf localhost:8080/healthz");
    expect(checkForPhase(spec, "flip")).toBe("curl -sf localhost:8080/ready");
    const noReady = { check: "curl -sf localhost:8080/healthz" };
    expect(checkForPhase(noReady, "startup")).toBe("curl -sf localhost:8080/healthz");
    expect(checkForPhase(noReady, "flip")).toBe("curl -sf localhost:8080/healthz");
  });
});
