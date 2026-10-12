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
