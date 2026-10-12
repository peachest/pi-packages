/**
 * loops — 五控制循环的调度与触发（模块 spec loops.md）。本票（25）：L0 Mutation 唯一写者 + startLoops 骨架。
 *
 * startLoops(ctx) 装配形态：fx 四端口 + Store 注入（票 25 面定）；Kernel 由 startLoops 构造并私有持有——
 * 与 loops.md「ctx 内注入 kernel」的偏差按票 25 要点裁定：kernel.transition/consumeIntent 是 L0 消费终点、
 * 票 10 双轨恢复前提（decisionOrder←mutation line、eventSeq←事件流尾）在 L0 侧落地（构造先于位点注入）。
 *
 * L0 唯一写者：kernel 变更方法的唯一调用路径 = submit() 队列，串行消费（提交序 = 消费序，
 * 双轨游标按消费序分配）。缓存纪律：状态缓存只在 store 提交回调（update_hook 等价）更新——
 * 写路径单一，缓存不可能先于提交。全部循环 level-trigger：L0 消费队列至空（无边缘依赖）；
 * L1-L4 随后续票挂入同一 ctx（exec/pusher/fs/clock 已就位）。
 */
import { type EntityRef, type TransitionIntent, type Verdict, entityRefKeyOf } from "../domain/types.ts";
import { Kernel, type ProfileRegistryEntry } from "../kernel/index.ts";
import type { Clock, Exec, Fs, Pusher } from "../fx/index.ts";
import type { Store } from "../store/index.ts";

/** L0 变更请求——kernel 变更方法（票 10 消费终点 transition/consumeIntent）的队列载体。 */
export type MutationRequest =
  | { kind: "transition"; ref: EntityRef; verdict: Verdict; occurredAt: string }
  | { kind: "consumeIntent"; intent: TransitionIntent };

/** 提交回调维护的状态缓存（只读视图；唯一写点在 store.onWrite 回调内，票 25 验收面）。 */
export interface LoopsCache {
  /** refKey（entityRefKeyOf）→ 已提交状态；逐提交与 store 实体表同步。 */
  readonly states: ReadonlyMap<string, string | null>;
}

/** startLoops 注入面（票 25：fx 四端口 + Store；states/registry/ownerEpoch 是 kernel 构造数据）。 */
export interface LoopsCtx {
  clock: Clock;
  exec: Exec;
  pusher: Pusher;
  fs: Fs;
  /** 真相源：L0 唯一写者的持久化面（提交回调挂这里） */
  store: Store;
  /** I-01：封闭状态集（数据，profiles 装载产物） */
  states: ReadonlySet<string>;
  /** I-01：profile 注册表静态面（kernel validate/templates 消费） */
  registry?: ReadonlyArray<ProfileRegistryEntry>;
  /** I12：本 daemon 实例世代（缺省 0 = 未接线） */
  ownerEpoch?: number;
}

export interface LoopsHandle {
  /** L0 唯一写路径：变更请求入队串行消费；stopped 后抛错（重启经 stop → 重新 startLoops）。 */
  submit(req: MutationRequest): void;
  /** 提交回调维护的缓存快照（L1-L4 的 level-trigger 扫描输入）。 */
  readonly cache: LoopsCache;
  /** 逐请求捕获的消费错误（kernel 越界 dead-letter 抛出在此可见；队列不死，消费继续）。 */
  readonly errors: readonly unknown[];
  /** 停机：L0 队列关闭、提交回调脱钩（幂等）。 */
  stop(): void;
}

/**
 * 决策轨恢复（R1 双轨前提，loops 侧落地）：mutation line 的持久形态 = 事件流——单写者纪律下
 * 每个已提交决策恰一事件（I1：transition+事件+outbox 行同事务原子），decisionOrder 内嵌于
 * 确定性 event id 尾段 `#N`（deterministicEventId）。outbox 行与 transition 1:1（与 kernel
 * recoverEventSeq 同源同法，事件流直查归 store 接口后续票精化），max = mutation line 位点，重放不重新编号。
 */
function recoverDecisionOrderTail(store: Store): number {
  let tail = 0;
  for (const row of store.outboxBatch(Number.MAX_SAFE_INTEGER)) {
    const order = Number(row.notificationId.slice(row.notificationId.lastIndexOf("#") + 1));
    if (Number.isInteger(order) && order > tail) tail = order;
  }
  return tail;
}

/** startLoops——loops 模块唯一入口：装配 L0（唯一写者）；L1-L4 后续票在此挂入。 */
export function startLoops(ctx: LoopsCtx): LoopsHandle {
  const kernel = new Kernel(ctx.store, ctx.states, recoverDecisionOrderTail(ctx.store), {
    ownerEpoch: ctx.ownerEpoch,
    registry: ctx.registry,
  });

  // 缓存：唯一写点 = 提交回调（store 契约：提交成功后按提交序同步触发，fake/SQLite 两实现一致）。
  // 全量重投影 = 接口忠实形态（回调只给表名，无行级增量；行级下推归 store 接口后续票）。
  const states = new Map<string, string | null>();
  let stopped = false;
  ctx.store.onWrite((tables) => {
    if (stopped || !tables.includes("entities")) return;
    states.clear();
    for (const e of ctx.store.queryEntities({})) {
      states.set(entityRefKeyOf({ type: e.type, key: e.key }), e.state);
    }
  });

  const queue: MutationRequest[] = [];
  const errors: unknown[] = [];
  let draining = false;

  const apply = (req: MutationRequest): void => {
    switch (req.kind) {
      case "transition":
        kernel.transition(req.ref, req.verdict, req.occurredAt);
        return;
      case "consumeIntent":
        kernel.consumeIntent(req.intent);
        return;
    }
  };

  // L0 串行消费：队列至空；重入提交（提交回调内再 submit，C2 编排形态）由外层收尾按 FIFO 继续。
  const drain = (): void => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const req = queue.shift()!;
        try {
          apply(req);
        } catch (err) {
          errors.push(err); // 队列不死：坏请求不阻断后续消费（level-trigger 自愈），dead-letter 语义在 errors 可见
        }
      }
    } finally {
      draining = false;
    }
  };

  return {
    submit(req: MutationRequest): void {
      if (stopped) throw new Error("loops stopped: L0 queue closed");
      queue.push(req);
      drain();
    },
    cache: { states },
    errors,
    stop(): void {
      stopped = true;
    },
  };
}
