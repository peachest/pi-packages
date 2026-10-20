/**
 * profiles — URL 路由 + ephemeral 键 + 订阅侧拒检 + schedule 换算（票 32）。
 *
 * resolve（#31 L107）：url → (profile, template) 唯一命中绑定；多命中报错列候选要求显式 template；
 * 票 49/#114：urlPattern 命名捕获组随命中提取为参数字典（多参数 URL 模板路由的完整形态）。
 * 零命中报错列可用模板。双 GitLab host：模板 host 字段精确匹配，零 fallback 猜测。
 *
 * ephemeral（I-02 / ADR 0002 例外）：ad-hoc 条件实体 key = sha1(check + schedule + cwd)——
 * 全库唯一 daemon 铸造键；同参复用实体。canonical 序列化覆盖三种 schedule 拼写
 * （资产 every / protocol every / kernel intervalMs），同值同键。
 *
 * token 拒检（订阅侧第一道防线；模板禁硬编码是第二道）：命中拒并列原因，绝不回显命中内容。
 */
import { createHash } from "node:crypto";
import type { EntityRef } from "../kernel/index.ts";
import type { ProfileDefinition, ScheduleData } from "./types.ts";

// ---------------------------------------------------------------------------
// resolve — URL 路由
// ---------------------------------------------------------------------------

export type ResolveResult =
  | { ok: true; profileId: string; template: string; params: Record<string, string> }
  | { ok: false; error: "ambiguous" | "no-match"; reason: string };

export function resolveUrl(defs: readonly ProfileDefinition[], url: string): ResolveResult {
  let host: string | null = null;
  try {
    host = new URL(url).host;
  } catch {
    host = null; // 非 URL 输入：host 未知 → 带 host 约束的模板一律不命中（零猜测）
  }
  // 票 119：pattern 锚定在 authority 之后——剥协议前缀再匹配（host 捕获组吃 authority，
  // 与 new URL().host 同源规范化）；无协议输入原样匹配（锚定语义不变）
  const matchTarget = host !== null ? url.slice(url.indexOf(host)) : url;
  const candidates: { profileId: string; template: string; params: Record<string, string> }[] = [];
  for (const def of defs) {
    for (const tpl of def.templates) {
      if (!tpl.urlPattern) continue;
      let re: RegExp;
      try {
        re = new RegExp(tpl.urlPattern);
      } catch {
        continue; // load 已拒不可编译 pattern；防御双保险
      }
      const m = re.exec(matchTarget);
      if (!m) continue;
      if (tpl.host !== undefined && host !== tpl.host) continue;
      // 命名捕获组 → 参数字典（票 49/#114）；load 已执法组名 ⊆ 模板 params，此处仅收集非 undefined 命中
      const params: Record<string, string> = {};
      for (const [name, value] of Object.entries(m.groups ?? {})) {
        if (value !== undefined) params[name] = value;
      }
      candidates.push({ profileId: def.id, template: tpl.name, params });
    }
  }
  if (candidates.length === 1) return { ok: true, ...candidates[0] };
  if (candidates.length > 1) {
    return {
      ok: false,
      error: "ambiguous",
      reason: `URL 命中多个模板 — 候选: [${candidates.map((c) => `${c.profileId}/${c.template}`).join(", ")}] — 请显式指定 template`,
    };
  }
  const available = defs.flatMap((d) => d.templates.filter((t) => t.urlPattern).map((t) => `${d.id}/${t.name}`));
  return {
    ok: false,
    error: "no-match",
    reason: `URL 未命中任何模板 — 可用: [${available.join(", ")}]`,
  };
}

// ---------------------------------------------------------------------------
// schedule — 模板资产形态 → kernel ProbeSpec 形态（B1：模板形态 agent opts 永不含 schedule）
// ---------------------------------------------------------------------------

/** kernel SubscribeOpts.schedule 形（scheduleToProbeSpec 产物，caller 直传 kernel.subscribe）。 */
export type ProbeSchedule = { type: "interval"; intervalMs: number } | { type: "cron"; cron: string; tz?: string };

const EVERY_RE = /^(\d+)(ms|s|m|h)$/;

export function everyToMs(every: string): number {
  const m = EVERY_RE.exec(every);
  if (!m) throw new Error(`invalid schedule every "${every}" — 期望 <n>ms|s|m|h`);
  const unitMs = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
  const ms = Number(m[1]) * unitMs;
  // 正 safe integer 执法（ocr F6）：0 致 probe 每拍到期，溢出 Infinity 致永不触发——load/subscribe 入口即拒
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(`invalid schedule every "${every}" — 须换算为正 safe integer 毫秒（拒 0 与溢出）`);
  }
  return ms;
}

export function scheduleToProbeSpec(s: ScheduleData): ProbeSchedule {
  return s.type === "interval"
    ? { type: "interval", intervalMs: everyToMs(s.every) }
    : { type: "cron", cron: s.expr, ...(s.tz !== undefined ? { tz: s.tz } : {}) };
}

// ---------------------------------------------------------------------------
// ephemeral — I-02 条件实体键（唯一 daemon 铸造键）
// ---------------------------------------------------------------------------

function canonicalSchedule(schedule: unknown): string {
  const r = (schedule ?? {}) as Record<string, unknown>;
  // 同值同键（ocr F2）：interval 三拼写（资产/协议 every 串 ×单位拼写 + kernel intervalMs）归一为 ms；
  // cron expr/cron 别名归一为单字段。非法 every 抛（fail-loud，同 everyToMs 执法面）
  if (r.type === "interval") {
    const ms = typeof r.intervalMs === "number" ? r.intervalMs : everyToMs(String(r.every));
    return JSON.stringify(["interval", ms]);
  }
  if (r.type === "cron") {
    return JSON.stringify(["cron", r.expr ?? r.cron ?? null, r.tz ?? null]);
  }
  return JSON.stringify([r.type ?? null]);
}

export function ephemeralRef(check: string, schedule: unknown, cwd: string): EntityRef {
  const digest = createHash("sha1")
    .update(check)
    .update("\u0000")
    .update(canonicalSchedule(schedule))
    .update("\u0000")
    .update(cwd)
    .digest("hex");
  return { type: "adhoc", key: `project/${digest}` };
}

// ---------------------------------------------------------------------------
// checkRegister — 订阅侧 token 拒检（第一道防线）
// ---------------------------------------------------------------------------

export type CredentialCheck = { ok: true } | { ok: false; reasons: readonly string[] };

/** 明文 credential 模式（实证泄漏形态：spec31 安全欠账 glpat-*；错误列原因不回显命中值）。 */
const CREDENTIAL_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "gitlab-personal-token", re: /glpat-[0-9A-Za-z_-]{8,}/ },
  { name: "inline-auth-header", re: /\b(?:bearer|basic)\s+[A-Za-z0-9+/_~.-]{8,}/i },
  { name: "credential-kv", re: /(?:password|passwd|secret|api[_-]?key|private[_-]?key)\s*[:=]\s*["']?(?![`$])[^\s"']{4,}/i },
  { name: "token-kv", re: /\btoken\s*[:=]\s*["']?[A-Za-z0-9_./+-]{16,}/i },
  { name: "credential-query-param", re: /[?&](?:key|token|access_token|api_key)=[A-Za-z0-9._-]{8,}/i },
];

/**
 * register/subscribe 请求的 profile 侧校验：check/url/params 字符串值扫明文 credential 模式。
 * 运行时凭据引用不误伤（ocr F5）：env/命令替换取值（$VAR、"$VAR"、$(…)、`…`，kv 位置亦然）
 * 凭据经 checker 运行时自取（如 $(glab config get token --host <host>)）；明文赋值仍拒。
 */
export function checkRegister(req: { check?: string; url?: string; params?: Record<string, unknown> }): CredentialCheck {
  const reasons: string[] = [];
  const scan = (where: string, text: string) => {
    for (const p of CREDENTIAL_PATTERNS) {
      if (p.re.test(text)) {
        reasons.push(
          `${where}: 命中明文 credential 模式 "${p.name}" — 订阅拒绝（凭据经 checker 运行时自取，如 $(glab config get token --host <host>)）`,
        );
      }
    }
  };
  if (req.check !== undefined) scan("check", req.check);
  if (req.url !== undefined) scan("url", req.url);
  for (const [k, v] of Object.entries(req.params ?? {})) {
    if (typeof v === "string") scan(`params.${k}`, v);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
