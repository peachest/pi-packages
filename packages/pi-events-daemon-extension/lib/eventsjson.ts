/**
 * eventsjson — .pi/events.json auto 订阅声明链 + project key 推导（票 35；#31 US-29/30）。
 *
 * 正典边界：
 *  - events.json = auto 订阅声明文件（资产路径+模板引用；origin=auto、scope=project 隐式——
 *    声明里没有也不该有 session/origin/scope 字段）。
 *  - daemon 发现不走此文件——socket 路径约定 + PI_EVENTS_SOCK（transport resolveSocketPath 正典）。
 *  - project key 推导（ADR 0002 执行点）：extension 从 cwd 推导 `project/<realpath>`；
 *    agent 不铸造不解析 key，本函数是唯一铸造点。
 *  - 模板实例化同源：profile 定义从 pi-events-daemon 包内 templates/ 加载（随包发版），
 *    经 ProfileRegistry（票 31 load 纪律）+ instantiateProfile（票 33 正典）——零第二定义。
 */
import { createRequire } from "node:module";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { instantiateProfile, ProfileRegistry } from "pi-events-daemon/profiles.ts";
import type { ProfileRegistryEntry } from "pi-events-daemon/kernel.ts";
import type { OpName } from "pi-events-daemon/protocol.ts";
import { entityRefKeyOf } from "pi-events-daemon/domain.ts";
import { loadEventsSchema, loadProfileSchema, validateFull, type JsonSchema } from "./schema.ts";
import type { OpSender } from "./tools.ts";

/** events.json 声明条目（events.schema.json subscriptions[] 子集，无 session/origin/scope 字段）。 */
export interface EventsJsonEntry {
  template: string;
  params?: Record<string, unknown>;
  on?: string | string[];
  once?: boolean;
  flip?: boolean;
  ttl?: number;
  failureThreshold?: number;
  successThreshold?: number;
}

// --- project key（ADR 0002） ---

/** cwd → `project/<realpath>`：symlink 归一保证同一项目唯一 key（不因挂载路径漂移）。 */
export function deriveProjectKey(cwd: string): string {
  return `project/${realpathSync(cwd)}`;
}

// --- 文件发现与读取 ---

/** 从 startDir 逐级上溯找 .pi/events.json（项目 = 最近含 .pi/ 的祖先目录）；无则 null。 */
export function findEventsJson(startDir: string): { path: string; root: string } | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, ".pi", "events.json");
    try {
      if (statSync(candidate).isFile()) return { path: candidate, root: dir };
    } catch {
      /* 本级无 .pi/events.json：继续上溯 */
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export type EventsJsonDoc =
  | { ok: true; subscriptions: EventsJsonEntry[]; path: string }
  | { ok: false; error: string };

/** 读取 + 同源完整校验（events.schema.json）；解析/校验失败归一为 {ok:false, error 列 issue}。 */
export function readEventsJson(path: string, schema: JsonSchema = loadEventsSchema() as JsonSchema): EventsJsonDoc {
  let doc: unknown;
  try {
    doc = JSON.parse(readText(path));
  } catch (err) {
    return { ok: false, error: `events.json 解析失败: ${err instanceof Error ? err.message : String(err)}` };
  }
  const issues = validateFull(schema, doc);
  if (issues.length > 0) {
    return {
      ok: false,
      error: `events.json 不合 events.schema.json:\n${issues.map((i) => `- ${i.path || "<根>"}: ${i.message}`).join("\n")}`,
    };
  }
  return { ok: true, subscriptions: (doc as { subscriptions: EventsJsonEntry[] }).subscriptions, path };
}

// --- 模板资产（同源加载） ---

let cachedTemplatesDir: string | null = null;

/** pi-events-daemon 包内 templates/ 目录（profile 静态资产，随包发版）。 */
export function daemonTemplatesDir(): string {
  if (cachedTemplatesDir) return cachedTemplatesDir;
  const require = createRequire(import.meta.url);
  cachedTemplatesDir = join(dirname(require.resolve("pi-events-daemon/package.json")), "templates");
  return cachedTemplatesDir;
}

/** 加载 profile 定义资产 → ProfileRegistry（票 31 load 纪律：schema 校验 + 冲突拒绝，拒绝即 throw 列 issue）。 */
export function loadTemplates(dir: string = daemonTemplatesDir()): ProfileRegistry {
  const registry = new ProfileRegistry({
    validate: (schema: object, value: unknown) => validateFull(schema as JsonSchema, value),
    schema: loadProfileSchema() as JsonSchema,
  });
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    let def: unknown;
    try {
      def = JSON.parse(readText(join(dir, name)));
    } catch (err) {
      throw new Error(`profile 资产解析失败 ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    registry.load(def);
  }
  return registry;
}

// --- 声明链（events.json 条目 → daemon subscribe op，origin:auto） ---

export interface DeclareReport {
  declared: Array<{ template: string; result: unknown }>;
  failed: Array<{ template: string; error: string }>;
}

/**
 * 逐条声明（US-29/30）：模板名解析 → instantiateProfile（票 33：entityRef 铸造 + check 代入 +
 * 模板 schedule 归资产）→ subscribe op {entityRef wire 单串, check, opts{意图子集 + origin:"auto"}}。
 * 单条失败不中断后续（containment）；错误一律列可用选项（模板清单/候选/缺参）。
 */
export async function declareAutoSubscriptions(
  subscriptions: readonly EventsJsonEntry[],
  sender: OpSender,
  registry: ProfileRegistry,
): Promise<DeclareReport> {
  const report: DeclareReport = { declared: [], failed: [] };
  for (const entry of subscriptions) {
    try {
      const r = await declareOne(entry, sender, registry);
      report.declared.push({ template: entry.template, result: r });
    } catch (err) {
      report.failed.push({ template: entry.template, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

async function declareOne(entry: EventsJsonEntry, sender: OpSender, registry: ProfileRegistry): Promise<unknown> {
  const match = resolveTemplateByName(registry, entry.template);
  const instantiated = instantiateProfile(registry.profiles(), match.profileId, entry.template, entry.params ?? {});
  if (!instantiated.ok) return Promise.reject(new Error(instantiated.reason));

  const opts: Record<string, unknown> = { template: entry.template, origin: "auto" };
  if (entry.on !== undefined) opts.on = entry.on;
  if (entry.once !== undefined) opts.once = entry.once;
  if (entry.flip !== undefined) opts.flip = entry.flip;
  if (entry.ttl !== undefined) opts.ttl = entry.ttl;
  if (entry.failureThreshold !== undefined) opts.failureThreshold = entry.failureThreshold;
  if (entry.successThreshold !== undefined) opts.successThreshold = entry.successThreshold;

  return sender("subscribe" as OpName, {
    entityRef: entityRefKeyOf(instantiated.entityRef),
    check: instantiated.check,
    opts,
  });
}

/** 模板名 → profile：零命中列全部可用模板；多命中列 profile/template 候选（列可用选项正典）。 */
function resolveTemplateByName(
  registry: ProfileRegistry,
  templateName: string,
): { profileId: string } {
  const entries = registry.entries() as ProfileRegistryEntry[];
  const hits = entries.flatMap((e) =>
    e.templates
      .filter((t: { name: string }) => t.name === templateName)
      .map((t: { name: string }) => ({ profileId: e.profileId, template: t.name })),
  );
  if (hits.length === 1) return { profileId: hits[0].profileId };
  if (hits.length === 0) {
    const available = [...new Set(entries.flatMap((e) => e.templates.map((t) => t.name)))].sort();
    throw new Error(`template "${templateName}" 未找到 — 可用: [${available.join(", ")}]`);
  }
  throw new Error(
    `template "${templateName}" 命中多个 profile — 候选: [${hits.map((h) => `${h.profileId}/${h.template}`).join(", ")}] — events.json 暂不支持 profile 限定，请改用唯一模板名`,
  );
}

// --- 内部 ---

function readText(path: string): string {
  return readFileSync(path, "utf8");
}
