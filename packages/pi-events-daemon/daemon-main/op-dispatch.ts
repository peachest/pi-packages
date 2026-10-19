/**
 * daemon-main — 9 op dispatch 接线（票 40 终票）：wire 契约（protocol OpContract）→ kernel/loops 方法面的
 * 参数/返回适配。组合根胶水，无裁决：语义全部在 kernel（校验/封闭集/幂等）与 loops（L0 串行）。
 *
 * 结果管道选型（commit 记录）：写侧 op（subscribe/cancel/publish/drain/status/register）全部经
 * loops.submit 返回 Promise<SubmitOutcome>（消费即结算，错误携回提交方；票 40 评审 F1：变更类
 * 只经 L0 单一写路径，stopped 后结算拒绝）；读侧 query/evidence 经 LoopsHandle.kernel 直调
 * （票 42 Pick 收窄至读侧）；templates/validate 静态面经 ProfileRegistry 组合根直调（票 42
 * owner 归位 profiles）；validate live-run 与 subscribe smoke 预检经组合根持有的 Prober 单发
 * 路径（exec 异步，kernel probeSync 同步注入不可达）。
 *
 * 错误面：kernel 域拒绝原样上抛（transport toRpcError 归一 -32603，原因随 message 可见）——
 * 不在本层发明错误码分类（protocol 未定义语义码，明示优于伪装）。
 */
import type { OpRequestFrame, ValidateReport } from "../protocol/index.ts";
import type { LoopsHandle, MutationRequest, SubmitOutcome } from "../loops/index.ts";
import type {
  DrainResult,
  QueryEntityEntry,
  QuerySubscriptionEntry,
  SmokeValidate,
  SubscribeOpts,
  SubscribeResult,
  TransitionResult,
} from "../kernel/index.ts";
import { entityRefKeyOf } from "../domain/index.ts";
import type { Store } from "../store/index.ts";
import type { Clock } from "../fx/index.ts";
import { ephemeralRef, instantiateProfile, type ProfileRegistry } from "../profiles/index.ts";
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

/**
 * wire 单串（type:key 全串）→ EntityRef：key 段以三正典前缀（external/|project|user/）锚定，
 * type = 首个锚点之前（票 40 评审 F7：贪婪切分在 native key 含冒号时错位——type 也含冒号，
 * 锚点回填唯一可靠判定；type:key 与 key 内部均可能含 ":"，往返一致性以本函数 + entityRefKeyOf 为界）。
 */
function parseWireEntityRef(wire: string): { type: string; key: string } {
  const m = /^(.+?):(external|project|user)\/(.+)$/.exec(wire);
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

  /**
   * prober 单发结果 → wire ValidateReport（票 40 评审 F6/F12）：syntaxOk 接真实静态语法校验
   * （sh -n 与执行同解释器族 shell:true；base64 管道免引用地狱）——syntax 坏即报告失败不 live-run，
   * 不再无依据宣称 syntaxOk=true。smoke 预检与 validate op 共用同一报告形。
   */
  const validateReport = async (check: string): Promise<ValidateReport> => {
    const b64 = Buffer.from(check, "utf8").toString("base64");
    const syn = await prober.runOnce(`printf %s ${b64} | base64 -d | sh -n`);
    if (syn.verdict !== "passed") {
      return { syntaxOk: false, verdict: "waiting", reason: `syntax error: ${syn.reason}`, evidence: syn.evidence, durationMs: syn.durationMs, warnings: [] };
    }
    const r = await prober.runOnce(check);
    return { syntaxOk: true, verdict: r.verdict, reason: r.reason, evidence: r.evidence, durationMs: r.durationMs, warnings: [] };
  };

  /** kernel SmokeValidate（probeSync 回流形状，无语法信息）→ wire ValidateReport（防御路径：dispatch 自身 smoke 已剥 opts.smoke）。 */
  const toValidateReport = (v: SmokeValidate, syntaxOk: boolean): ValidateReport => ({
    syntaxOk,
    verdict: v.verdict,
    reason: v.reason,
    evidence: v.evidence,
    durationMs: v.durationMs,
    warnings: [],
  });

  const mapQueryEntity = (e: QueryEntityEntry): Record<string, unknown> => ({
    entityRef: entityRefKeyOf(e.entityRef),
    state: e.state,
    payloadSummary: e.payload ?? null,
    eventSeq: e.eventSeq,
    ...(e.lastProbedAt !== null ? { lastProbedAt: new Date(e.lastProbedAt).toISOString() } : {}),
    backlog: e.backlog,
    ...(e.children !== undefined ? { children: e.children.map(mapQueryEntity) } : {}),
  });

  /** 订阅行明细 → wire（票 44）：时间戳 ISO 串与 entities 面同约定。 */
  const mapQuerySubscription = (s: QuerySubscriptionEntry): Record<string, unknown> => ({
    subscriptionId: s.subscriptionId,
    sessionId: s.sessionId,
    entityRef: entityRefKeyOf(s.entityRef),
    state: s.state,
    origin: s.origin,
    ...(s.template !== undefined ? { template: s.template } : {}),
    ...(s.check !== undefined ? { check: s.check } : {}),
    ...(s.on !== undefined ? { on: s.on } : {}),
    ...(s.once !== undefined ? { once: s.once } : {}),
    ...(s.flip !== undefined ? { flip: s.flip } : {}),
    ...(s.readyCheck !== undefined ? { readyCheck: s.readyCheck } : {}),
    ...(s.thresholds !== undefined ? { thresholds: s.thresholds } : {}),
    ...(s.phase !== undefined ? { phase: s.phase } : {}),
    ...(s.schedule !== undefined ? { schedule: s.schedule } : {}),
    ...(s.lastProbedAt !== null ? { lastProbedAt: new Date(s.lastProbedAt).toISOString() } : {}),
    backlog: s.backlog,
    createdAt: new Date(s.createdAt).toISOString(),
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
          let templateName: string;
          if (params.url !== undefined) {
            // url 形态：registry url 路由（票 32）→ instantiate（keyGenerator 造 ref、check 代入）→ register
            const resolved = registry.resolve(String(params.url));
            if (!resolved.ok) throw new Error(`subscribe rejected: ${resolved.reason}`);
            if (opts.template !== undefined && resolved.template !== String(opts.template)) {
              throw new Error(`subscribe rejected: template "${String(opts.template)}" 与 URL 路由命中 "${resolved.template}" 不一致`);
            }
            // 票 49/#114：urlPattern 命名捕获组随命中提取为参数字典，随帧并入 instantiate——
            // 多参数 URL 模板（如 gitlab mr 双参数）的 check 代入与 keyGenerator 消费均经此面
            const inst = instantiateProfile(registry.profiles(), resolved.profileId, resolved.template, {
              url: String(params.url),
              ...resolved.params,
            });
            if (!inst.ok) throw new Error(`subscribe rejected: ${inst.reason}`);
            ref = inst.entityRef;
            check = inst.check;
            schedule = inst.schedule;
            profileId = inst.profileId;
            // 票 40 评审 F4：URL 路由出的模板名回填订阅（槽键/订阅身份含 template——
            // 存 'adhoc' 会让同 URL 的显式同名模板订阅裂到另一槽，I5 分叉）
            templateName = resolved.template;
            await submit({ kind: "register", req: { entityRef: ref, profileId, state: null } });
          } else if (params.entityRef !== undefined) {
            ref = parseWireEntityRef(String(params.entityRef));
            if (params.check === undefined) {
              throw new Error(
                "subscribe rejected: entityRef 形态需显式 check（MVP：模板 check 代入归 extension instantiate 后随帧携带）",
              );
            }
            check = String(params.check);
            templateName = typeof opts.template === "string" ? opts.template : "adhoc";
          } else {
            // ad-hoc ephemeral（#31 L114）：key = profiles.ephemeralRef（sha1(check + canonical schedule + cwd)，
            // 票 40 评审 F11：canonical 序列化同值同键——键序/单位拼写不裂实体；传 wireSchedule 归一后的
            // kernel 形，canonicalSchedule 的 every-串拼写域由此对齐）
            check = String(params.check);
            ref = ephemeralRef(check, schedule ?? null, process.cwd());
            templateName = "adhoc";
            await submit({ kind: "register", req: { entityRef: ref, profileId: "", state: null } });
          }

          // smoke 预检（syntax+live-run 失败 → {subscribed:false, validate} 不建订阅不抛错；通过 → 剥离 smoke 提交）
          let smokeValidate: ValidateReport | undefined;
          if (opts.smoke === true) {
            smokeValidate = await validateReport(check);
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
              template: templateName,
              check,
              now: clock.now(),
              ...(profileId !== undefined ? { profileId } : {}),
              opts: kernelOpts,
            },
          })) as SubscribeResult;
          if (!result.subscribed) return result; // smoke 失败形态透传（kernel 侧 probeSync 未注入，此路防御）
          // 票 40 评审 F13：validate 载荷归一为局部变量（嵌套三元退役）
          let validate: ValidateReport | undefined;
          if (smokeValidate !== undefined) validate = smokeValidate;
          else if (result.validate !== undefined) validate = toValidateReport(result.validate, false);
          return {
            subscribed: true,
            subscriptionId: result.subscriptionId,
            entityRef: entityRefKeyOf(result.entityRef),
            state: result.state,
            ...(validate !== undefined ? { validate } : {}),
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
        const filter: { entityRef?: { type: string; key: string }; scope?: "project" | "user"; sessionId?: string } = {};
        if (params.entityRef !== undefined) filter.entityRef = parseWireEntityRef(String(params.entityRef));
        // 票 40 评审 F5：scope/session 过滤落 kernel（开放订阅-实体 join；非法 scope 明确拒绝不静默忽略）
        if (params.scope !== undefined) {
          if (params.scope !== "project" && params.scope !== "user") {
            throw new Error(`query rejected: scope "${String(params.scope)}" 非法（project | user）`);
          }
          filter.scope = params.scope;
        }
        if (params.session !== undefined) filter.sessionId = String(params.session);
        const r = kernel.query(filter);
        return {
          entities: r.entities.map(mapQueryEntity),
          deadLetters: r.deadLetters.map((d) => ({
            notificationId: d.notificationId,
            sessionId: d.sessionId,
            entityRef: entityRefKeyOf(d.entityRef),
          })),
          subscriptions: r.subscriptions.map(mapQuerySubscription),
        };
      }

      case "evidence":
        return kernel.evidence(String(params.evidenceRef)); // {content, truncated} 与 wire 同形

      case "status":
        return (async () => {
          // 登记处写入（US-13/25）：register 簿记 + 状态变更自动发事件（首态 = from=null 首转换）。
          // 票 40 评审 F2：register+首转换合并单 L0 请求/kernel 同事务——transition 拒绝（非法 state）
          // 整体回滚，不再残留半注册实体。
          if (typeof params.type !== "string" || typeof params.key !== "string") {
            throw new Error("status rejected: type/key 必填（typed 实体签名）");
          }
          const ref = { type: params.type, key: params.key };
          const r = (await submit({
            kind: "register",
            req: {
              entityRef: ref,
              profileId: resolveProfileId(ref.type),
              ...(params.payload !== undefined ? { payload: params.payload } : {}),
              // 封闭集执法在 kernel（transitionTx 同步拒）；MVP 状态集 = 判定三态（内置模板并集）
              ...(params.state !== undefined
                ? { firstTransition: { to: String(params.state), occurredAt: nowIso() } }
                : {}),
            },
          })) as { entityRef: { type: string; key: string }; state: string | null; event?: TransitionResult };
          return {
            entityRef: entityRefKeyOf(ref),
            state: store.getEntity(ref.type, ref.key)?.state ?? null,
            ...(r.event ? { event: r.event } : {}),
          };
        })();

      case "validate":
        return (async () => {
          if (typeof params.check !== "string" || params.check.trim() === "") {
            throw new Error("validate rejected: check 必须为非空命令文本");
          }
          // 票 40 评审 F12：syntaxOk 接真实静态语法校验（sh -n），不再是 runOnce 分类结果的无依据标注
          return validateReport(params.check);
        })();

      case "templates": {
        const profile = params.profile !== undefined ? String(params.profile) : undefined;
        const list = registry.templates(profile).templates; // 未知 profile 抛错（列可用选项；票 42 静态面迁 profiles）
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
