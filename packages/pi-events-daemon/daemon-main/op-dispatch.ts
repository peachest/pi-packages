/**
 * daemon-main — 9 op dispatch 接线（票 40 终票）：wire 契约（protocol OpContract）→ kernel/loops 方法面的
 * 参数/返回适配。组合根胶水，无裁决：语义全部在 kernel（校验/封闭集/幂等）与 loops（L0 串行）。
 *
 * 结果管道选型（commit 记录）：写侧 op 经 loops.submit 返回 Promise<SubmitOutcome>（消费即结算，
 * 错误携回提交方）；读侧 query/evidence/templates 与 status 的 register/transition 底座经
 * LoopsHandle.kernel 直调（dispatch 与 L0 消费同为同步原子，单线程不交错）；validate live-run
 * 与 subscribe smoke 预检经组合根持有的 Prober 单发路径（exec 异步，kernel probeSync 同步注入不可达）。
 *
 * 错误面：kernel 域拒绝原样上抛（transport toRpcError 归一 -32603，原因随 message 可见）——
 * 不在本层发明错误码分类（protocol 未定义语义码，明示优于伪装）。
 */
import { createHash } from "node:crypto";
import type { OpRequestFrame } from "../protocol/index.ts";
import type { LoopsHandle, MutationRequest, SubmitOutcome } from "../loops/index.ts";
import type {
  DrainResult,
  QueryEntityEntry,
  SubscribeOpts,
  SubscribeResult,
  TransitionResult,
} from "../kernel/index.ts";
import { entityRefKeyOf, type Verdict } from "../domain/index.ts";
import type { Store } from "../store/index.ts";
import type { Clock } from "../fx/index.ts";
import { instantiateProfile, type ProfileRegistry } from "../profiles/index.ts";
import type { Prober } from "../prober/index.ts";

export interface OpDispatchDeps {
  loops: LoopsHandle;
  store: Store;
  registry: ProfileRegistry;
  clock: Clock;
  /** 单发执行面：validate live-run + subscribe smoke 预检（runOnce 不走池不回流）。 */
  prober: Prober;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** wire 单串（type:key 全串）→ EntityRef：以 (external|project|user)/ 锚点切分（type 可含冒号，如 fs:path）。 */
function parseWireEntityRef(wire: string): { type: string; key: string } {
  const m = /^(.+):(external|project|user)\/(.+)$/.exec(wire);
  if (!m) throw new Error(`entityRef wire 解析失败: "${wire}"（期望 type:external/|project/|user/<key>，ADR 0002）`);
  return { type: m[1], key: `${m[2]}/${m[3]}` };
}

/** wire schedule（every/expr 拼写）→ kernel ProbeSpec schedule（intervalMs/cron）。 */
function wireSchedule(raw: unknown): SubscribeOpts["schedule"] {
  if (!isRecord(raw)) return undefined;
  if (raw.type === "interval" && typeof raw.every === "number") return { type: "interval", intervalMs: raw.every };
  if (raw.type === "cron" && typeof raw.expr === "string") {
    return { type: "cron", cron: raw.expr, ...(typeof raw.tz === "string" ? { tz: raw.tz } : {}) };
  }
  throw new Error(`subscribe rejected: 非法 schedule ${JSON.stringify(raw)}（interval {every:ms} | cron {expr,tz?}）`);
}

export function createOpDispatch(deps: OpDispatchDeps): (frame: OpRequestFrame) => unknown | Promise<unknown> {
  const { loops, store, registry, clock, prober } = deps;
  const kernel = loops.kernel;
  const nowIso = (): string => new Date(clock.now()).toISOString();

  /** 写侧 op 唯一路径：L0 submit 串行消费，结算即返（错误携回 → 错误响应）。 */
  const submit = async (req: MutationRequest): Promise<unknown> => {
    const outcome: SubmitOutcome = await loops.submit(req);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  };

  /** status op 的 profile 归属：按 entityType 命中注册表首个 profile（未命中 = 无 profile 簿记，空串）。 */
  const resolveProfileId = (entityType: string): string =>
    registry.entries().find((e) => e.templates.some((t) => t.entityType === entityType))?.profileId ?? "";

  /** publish 同态无事件路径的实体既有尾序（outbox 行与事件 1:1；shortcut: O(outbox) 前缀扫，同态 publish 低频）。 */
  const latestSeqForEntity = (ref: { type: string; key: string }): number => {
    const prefix = `evt:${entityRefKeyOf(ref)}#`;
    let max = 0;
    for (const row of store.outboxBatch(Number.MAX_SAFE_INTEGER)) {
      if (row.notificationId.startsWith(prefix) && row.eventSeq > max) max = row.eventSeq;
    }
    return max;
  };

  const mapQueryEntity = (e: QueryEntityEntry): Record<string, unknown> => ({
    entityRef: entityRefKeyOf(e.entityRef),
    state: e.state,
    payloadSummary: e.payload ?? null,
    eventSeq: e.eventSeq,
    ...(e.lastProbedAt !== null ? { lastProbedAt: new Date(e.lastProbedAt).toISOString() } : {}),
    backlog: e.backlog,
    ...(e.children !== undefined ? { children: e.children.map(mapQueryEntity) } : {}),
  });

  return function dispatch(frame: OpRequestFrame): unknown | Promise<unknown> {
    const params = frame.params;
    switch (frame.op) {
      // --- 写侧（L0 submit 串行）---
      case "subscribe":
        return (async () => {
          const opts: Record<string, unknown> = { ...(isRecord(params.opts) ? params.opts : {}) };
          // 目标互斥：entityRef XOR url XOR（仅 check = ad-hoc ephemeral）。check 是判定器声明：
          // 可与 entityRef 并列（extension auto 声明链随帧携带代入后的模板 check）；与 url 并列 = 歧义
          // （url 已路由出模板 check）。
          const targets = [params.entityRef, params.url].filter((v) => v !== undefined);
          if (targets.length > 1 || (params.url !== undefined && params.check !== undefined)) {
            throw new Error(`subscribe rejected: 目标恰好其一（entityRef/url/check 单独；entityRef+check 合法）——得到 ${[
              params.entityRef !== undefined ? "entityRef" : null,
              params.url !== undefined ? "url" : null,
              params.check !== undefined ? "check" : null,
            ].filter(Boolean)
              .join("+")}`);
          }
          if (targets.length === 0 && params.check === undefined) {
            throw new Error("subscribe rejected: 缺 target（entityRef | url | check 恰好其一）");
          }
          let ref: { type: string; key: string };
          let check: string;
          let schedule = wireSchedule(opts.schedule);
          let profileId: string | undefined;
          if (params.url !== undefined) {
            // url 形态：registry url 路由（票 32）→ instantiate（keyGenerator 造 ref、check 代入）→ register
            const resolved = registry.resolve(String(params.url));
            if (!resolved.ok) throw new Error(`subscribe rejected: ${resolved.reason}`);
            if (opts.template !== undefined && resolved.template !== String(opts.template)) {
              throw new Error(`subscribe rejected: template "${String(opts.template)}" 与 URL 路由命中 "${resolved.template}" 不一致`);
            }
            const inst = instantiateProfile(registry.profiles(), resolved.profileId, resolved.template, { url: String(params.url) });
            if (!inst.ok) throw new Error(`subscribe rejected: ${inst.reason}`);
            ref = inst.entityRef;
            check = inst.check;
            schedule = inst.schedule;
            profileId = inst.profileId;
            kernel.register({ entityRef: ref, profileId, state: null });
          } else if (params.entityRef !== undefined) {
            ref = parseWireEntityRef(String(params.entityRef));
            if (params.check === undefined) {
              throw new Error(
                "subscribe rejected: entityRef 形态需显式 check（MVP：模板 check 代入归 extension instantiate 后随帧携带）",
              );
            }
            check = String(params.check);
          } else {
            // ad-hoc ephemeral（#31 L114）：key = sha1(check + schedule + cwd)；终态退役清理域未接（L4 ephemeral 缺省关）
            check = String(params.check);
            ref = {
              type: "adhoc",
              key: `external/${createHash("sha1")
                .update(`${check}\u0000${JSON.stringify(opts.schedule ?? null)}\u0000${process.cwd()}`)
                .digest("hex")}`,
            };
            kernel.register({ entityRef: ref, profileId: "", state: null });
          }

          // smoke 预检（live-run 失败 → {subscribed:false, validate} 不建订阅不抛错；通过 → 剥离 smoke 提交）
          let smokeValidate: { verdict: Verdict; reason: string; evidence: string; durationMs: number } | undefined;
          if (opts.smoke === true) {
            smokeValidate = await prober.runOnce(check);
            if (smokeValidate.verdict !== "passed") return { subscribed: false, validate: smokeValidate };
            delete opts.smoke;
          }

          const kernelOpts = {
            ...(opts.on !== undefined ? { on: opts.on } : {}),
            ...(opts.once !== undefined ? { once: opts.once } : {}),
            ...(opts.flip !== undefined ? { flip: opts.flip } : {}),
            ...(opts.readyCheck !== undefined ? { readyCheck: opts.readyCheck } : {}),
            ...(opts.ttl !== undefined ? { ttl: opts.ttl } : {}),
            ...(opts.failureThreshold !== undefined ? { failureThreshold: opts.failureThreshold } : {}),
            ...(opts.successThreshold !== undefined ? { successThreshold: opts.successThreshold } : {}),
            ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
            ...(schedule !== undefined ? { schedule } : {}),
          } as SubscribeOpts;
          const sessionId = typeof opts.sessionId === "string" ? opts.sessionId : "";
          const result = (await submit({
            kind: "subscribe",
            req: {
              sessionId,
              entityRef: ref,
              template: typeof opts.template === "string" ? opts.template : "adhoc",
              check,
              now: clock.now(),
              ...(profileId !== undefined ? { profileId } : {}),
              opts: kernelOpts,
            },
          })) as SubscribeResult;
          if (!result.subscribed) return result; // smoke 失败形态透传（kernel 侧 probeSync 未注入，此路防御）
          return {
            subscribed: true,
            subscriptionId: result.subscriptionId,
            entityRef: entityRefKeyOf(result.entityRef),
            state: result.state,
            ...(smokeValidate !== undefined
              ? { validate: smokeValidate }
              : result.validate !== undefined
                ? { validate: result.validate }
                : {}),
            warnings: [...result.warnings],
          };
        })();

      case "cancel":
        return submit({
          kind: "cancel",
          req: { subscriptionId: String(params.subscriptionId), now: clock.now() },
        }); // {cancelled} 幂等：未知/已关 = false 不抛错

      case "publish":
        return (async () => {
          if (params.entityRef === undefined) throw new Error("publish rejected: entityRef 必填");
          const ref = parseWireEntityRef(String(params.entityRef));
          const tr = params.transition;
          if (!isRecord(tr) || typeof tr.to !== "string") {
            throw new Error("publish rejected: transition.to 必填（字符串状态名）");
          }
          const result = (await submit({
            kind: "publish",
            ref,
            to: tr.to,
            ...(tr.contentIdentity !== undefined ? { contentIdentity: tr.contentIdentity as string | null } : {}),
            ...(tr.payload !== undefined ? { payload: tr.payload } : {}),
            occurredAt: nowIso(),
          })) as TransitionResult | null;
          if (result) return { eventSeq: result.eventSeq, from: result.from, to: result.to };
          // 同态无身份变化（ADR 0003 无事件）：当前态 + 实体既有尾序（eventSeq 不推进）
          return {
            eventSeq: latestSeqForEntity(ref),
            from: store.getEntity(ref.type, ref.key)?.state ?? null,
            to: tr.to,
          };
        })();

      case "drain":
        return (async () => {
          const r = (await submit({
            kind: "drain",
            ...(params.sessionId !== undefined ? { sessionId: String(params.sessionId) } : {}),
          })) as DrainResult;
          return {
            drained: r.drained.length,
            deadLetterSummary: { count: r.deadLetterSummary.count, oldestAge: r.deadLetterSummary.oldestAgeMs ?? 0 },
          };
        })();

      // --- 读侧（kernel 直调）---
      case "query": {
        const filter: { entityRef?: { type: string; key: string } } = {};
        if (params.entityRef !== undefined) filter.entityRef = parseWireEntityRef(String(params.entityRef));
        // scope/session 过滤 MVP 未接（kernel.query 过滤面仅 entityRef；清单归一全量返回）
        const r = kernel.query(filter);
        return {
          entities: r.entities.map(mapQueryEntity),
          deadLetters: r.deadLetters.map((d) => ({
            notificationId: d.notificationId,
            sessionId: d.sessionId,
            entityRef: entityRefKeyOf(d.entityRef),
          })),
        };
      }

      case "evidence":
        return kernel.evidence(String(params.evidenceRef)); // {content, truncated} 与 wire 同形

      case "status": {
        // 登记处写入（US-13/25）：register 簿记 + 状态变更自动发事件（首态 = from=null 首转换）
        if (typeof params.type !== "string" || typeof params.key !== "string") {
          throw new Error("status rejected: type/key 必填（typed 实体签名）");
        }
        const ref = { type: params.type, key: params.key };
        kernel.register({
          entityRef: ref,
          profileId: resolveProfileId(ref.type),
          ...(params.payload !== undefined ? { payload: params.payload } : {}),
        });
        const before = store.getEntity(ref.type, ref.key)?.state ?? null;
        let event: TransitionResult | null = null;
        if (params.state !== undefined && before !== params.state) {
          // 封闭集执法在 kernel（requireStateIn 同步拒）；MVP 状态集 = 判定三态（内置模板并集）
          event = kernel.transition(ref, params.state as Verdict, nowIso());
        }
        return {
          entityRef: entityRefKeyOf(ref),
          state: store.getEntity(ref.type, ref.key)?.state ?? null,
          ...(event ? { event } : {}),
        };
      }

      case "validate":
        return (async () => {
          if (typeof params.check !== "string" || params.check.trim() === "") {
            throw new Error("validate rejected: check 必须为非空命令文本");
          }
          const r = await prober.runOnce(params.check);
          return { syntaxOk: true, verdict: r.verdict, reason: r.reason, evidence: r.evidence, durationMs: r.durationMs, warnings: [] };
        })();

      case "templates": {
        const profile = params.profile !== undefined ? String(params.profile) : undefined;
        const list = kernel.templates(profile).templates; // 未知 profile 抛错（列可用选项）
        // 参数说明面在资产定义（entries() 只留参数名清单）——组合根持全定义补齐
        const paramDesc = new Map(
          registry.profiles().flatMap((d) => d.templates.map((t) => [`${d.id}/${t.name}`, t.params] as const)),
        );
        return {
          templates: list.map((t) => ({
            name: t.name,
            entityType: t.entityType,
            states: [...t.states],
            schedule: t.schedule ?? null,
            params: Object.fromEntries(
              ((t.params ?? []) as readonly string[]).map((n) => [n, String(paramDesc.get(`${t.profileId}/${t.name}`)?.[n] ?? "")]),
            ),
            usage: t.usage ?? "",
          })),
        };
      }
    }
  };
}
