/**
 * transcript-adapter — public surface. See packages/README.md (deep-module layout).
 *
 * 票 19：I9 唯一权威点——daemon 内一切 transcript 读取收敛于此，verdict 推导不出本模块。
 * 零依赖只读叶（eda-adapter-fx-only：只可用 fx 端口；fx Fs 接口无写方法，机器强制只读）。
 *
 * ## 字段路径表（票 19 固化，#31 授权；代表性样本形态来源见 adapter.test.ts 头注）
 *
 * 通知条目载体 = customType 为 NOTIFICATION_CUSTOM_TYPE 的 custom message；
 * 机器校验三元组（notificationId/verdict/evidenceRef）住 details（pi API 语义：
 * extension 专有元数据，不进 LLM 上下文）。
 *
 * | 形态                     | 载体条目                                                                                         | notificationId 路径             | verdict 路径             | evidenceRef 路径             | lane 信封（单列）                                         |
 * |-------------------------|--------------------------------------------------------------------------------------------------|--------------------------------|-------------------------|-----------------------------|----------------------------------------------------------|
 * | v3 custom_message       | {type:"custom_message",customType,content,display?,details?,id,parentId,timestamp}               | details.notificationId         | details.verdict         | details.evidenceRef         | 无（v3 无信封形态）                                       |
 * | v4 custom agent message | {kind:"entry",type:"message",message:{role:"custom",customType,content,display?,details?}}       | message.details.notificationId | message.details.verdict | message.details.evidenceRef | message.content 数组内带 sessionId 字段的条目 → result.lane |
 *
 * - lane 信封（herdr/multi-agent 派发场景）：sessionId 条目单列透传（result.lane），不参与
 *   notificationId↔turn 映射——映射 = notificationId 相等，在本模块内裁决（I9）。
 * - verdict 语义 = 通知条目自带的判定（billboard 的实体判定 / 派发回执的 turn 判定），
 *   取值域与 domain Verdict 同串（"passed"|"failed"|"waiting"，#31 判定三态）；adapter 不
 *   import domain（fx-only），结构同形即合约（store 先例 D3）。
 * - 形态标记（verify）：按命中条目的字段路径归类（v3 路径命中=v3、v4 路径命中=v4），
 *   header 仅 locate 面提示——不依赖文件头单点（ocr 评审 medium：无 header 的 v4 文件不误报 v3）。
 * - 保守降级（C1）：无法唯一确定 → "unknown" + reason；不抛异常。条目未出现 → "waiting"
 *   + "not-found"（撕裂尾行期间不产生假阴性：未落盘 ≠ 不存在）。
 * - 撕裂尾行（harness-v2：JSONL 无 fsync，尾行 = 未确认写入可截断）：仅最后一个非空行
 *   JSON.parse 失败视为撕裂、跳过；中段坏行是 corruption → unknown + corrupt-line。
 *
 * ## 双后端分流（票 20，#31 双后端 MVP 裁定 2026-10-10：v3 JSONL 与 harness-v2 SQLite 并存）
 *
 * - 逐 session 后端判别 = pi settings 会话存储信号 + transcript 文件头采样；判别时点 =
 *   daemon 启动 / 新 session 注册（registerSession，结果按 (sessionFile, sessionId) 联合键缓存，
 *   重复注册重判；sessionFile 单键不够——同库多 session 与有无 sessionId 的 ref 各自独立判别，
 *   评审 Finding 2/3）；未注册 ref 的 verify 惰性判别一次并缓存，语义与注册路径一致，
 *   判别歧义 warning 透传到该次 verify 结果（评审 Finding 4；注册路径由返回值承载）。
 * - 判别三路：①无 sqlite 信号 → JSONL 扫描（含文件未建的新会话常态，不算歧义）；
 *   ②settings 会话存储 = sqlite 且 ref 带 sessionId 且头采样非 JSONL → SQLite 点查
 *   （node:sqlite 只读，票 22 同款零依赖，sqlite-backend.ts；A 层 IO 禁令按名单生效，
 *   sqlite 不在其列——票 20 在册裁定）；③settings=sqlite 但头采样命中 v3/v4 JSONL（信号矛盾）、
 *   或 sqlite 信号不完整（ref 缺 sessionId，库内无法定域）→ 判别歧义 → 按 JSONL 扫描
 *   （最保守路径）+ warning "ambiguous-backend"。
 * - SQLite 形态 = harness-v2 代表性样本（entries/branch_entries，见 sqlite-backend.ts 与测试
 *   fixture，待对齐 packages/session-backends/sqlite-node 定稿）。SQL 点查与 JSONL 扫描共享
 *   同一抽取/聚合面（decide），保证两后端 verify 等价；lane 信封不透传（herdr 派发信封为
 *   JSONL content 形态，SQLite lane 列语义待对齐）。
 *
 * ## C1 启动自检 + 双层降级（票 21，#31 C1 正典语义）
 *
 * - 全局降级（模式级）：selfCheck() 对全部已注册 session 的 transcript 后端做可读性自测
 *   （JSONL：可读+可扫描；SQLite：库可开+点查可执行；ENOENT = 未落盘不算故障——JSONL 文件与
 *   SQLite 库同语义，新会话常态，评审 Finding 1；库存在但非库/锁死 = 真故障）。
 *   失败 → 全局降级标志置位：推送即视为 accepted、不再 verify——verify 拒推 verdict
 *   （unknown + "degraded"），重复投递由 billboard notificationId 去重；降级原因经
 *   degradeReason() 携带 warning（doctor/reckon 暴露降级态的数据源）。恢复路径 = 再次
 *   selfCheck() 成功即清除降级、verify 回正常。
 * - 单条兜底（条目级）：单条 transcript 无法唯一确定 verdict → unknown + 原因码正常返回
 *   （票 19 语义），与全局降级相区分：一个是全局模式，一个是单条兜底。
 */
import type { Fs } from "../fx/index.ts";
import { queryNotificationEntries, type SqliteEntryRow } from "./sqlite-backend.ts";

/** 通知条目 customType 标记——写入方（pi-events extension 包）与读取方共用此唯一拼写。 */
export const NOTIFICATION_CUSTOM_TYPE = "pi-events.notification";

/**
 * 会话引用——transcript 权威路径源。#31：路径来自 PI_SESSION_FILE / getSessionFile()
 * 的上游透传（extension 注册时上报），不从 cwd+uuid 反推。seam 为第二后端
 * （harness-v2 SQLite 点查，#31 MVP 内裁定）保留同一接口挂接点。
 */
export interface SessionRef {
  sessionFile: string;
  /** harness-v2 SQLite 库内 session 标识（SQL 点查按 session 分域；JSONL 后端忽略）。待对齐：harness-v2 session id 形态。 */
  sessionId?: string;
}

/**
 * 判定四态：domain Verdict 三态 + unknown（C1 保守降级，非 domain 值——降级是本模块的
 * 正常返回值，不带 verdict 语义）。与 domain/types.ts 的 Verdict 结构同形（fx-only 不 import）。
 */
export type AdapterVerdict = "passed" | "failed" | "waiting" | "unknown";

/** transcript 形态代（文件头采样 / 命中条目判别）。 */
export type TranscriptFormat = "v3" | "v4";

/** 逐 session 后端（#31 双后端 MVP：v3/v4 JSONL 与 harness-v2 SQLite 并存分流）。 */
export type SessionBackend = "jsonl" | "sqlite";

/** registerSession 判别结果。判别歧义 → backend 恒 "jsonl"（最保守路径）+ warning（#31）。 */
export interface BackendDetection {
  backend: SessionBackend;
  /** 判别歧义标记：settings↔文件头信号矛盾，或 sqlite 信号不完整（ref 缺 sessionId）。 */
  warning?: "ambiguous-backend";
}

/** locate 结果：路径 + 文件头采样形态判别。仅 JSONL 形态采样提示（SQLite 库文件 → unknown）；后端判别归 registerSession。 */
export interface LocateResult {
  path: string;
  /** 头行缺失/无法判别 → "unknown"（按 JSONL 扫描最保守路径处理，#31；调用方记 warning）。 */
  format: TranscriptFormat | "unknown";
}

/** unknown/waiting 的原因码（C1：降级带原因，调用方可分类处理；degraded = 票 21 全局降级模式级）。 */
export type VerifyReason =
  | "not-found"
  | "unreadable"
  | "corrupt-line"
  | "verdict-missing"
  | "conflicting-verdicts"
  | "degraded";

/** verify 结果——verdict + 通知条目携带的 evidence 指针 + 形态标记（票 19 验收形状）。 */
export interface VerifyResult {
  verdict: AdapterVerdict;
  /** 通知条目 details.evidenceRef 透传；条目未携带时缺省。 */
  evidenceRef?: string;
  /** 形态标记：命中条目所处形态代；未命中/无法定位条目时缺省。 */
  format?: TranscriptFormat;
  /** lane 信封单列：content 数组内 sessionId 条目的透传；无信封时缺省。 */
  lane?: string;
  /** verdict 为 waiting/unknown 时的原因码。 */
  reason?: VerifyReason;
  /** 未注册 ref 惰性判别的判别歧义 warning（评审 Finding 4：不静默吞；注册路径由 registerSession 返回值承载）。 */
  warning?: "ambiguous-backend";
}

/** selfCheck 结果：ok=false 的 reason 为降级 warning 事件载荷。 */
export interface SelfCheckResult {
  ok: boolean;
  /** 自检失败原因（`<sessionFile>: <failure>` 形态；doctor/reckon 暴露降级态的数据源）。 */
  reason?: string;
}

export interface TranscriptAdapterOptions {
  /** pi settings 路径（会话存储配置读取源，经同一 fx Fs 读取）。缺省 = 无 settings 信号，仅文件头采样判别；组合根接线时传入真实路径（待接线票）。 */
  settingsPath?: string;
}

export interface TranscriptAdapter {
  /** 会话定位：读 transcript 并采样文件头判形态。文件不可读（未创建/已删）→ null。 */
  locate(sessionRef: SessionRef): Promise<LocateResult | null>;
  /** I9 点查：notificationId 在目标 transcript 的判定。永远正常返回，不抛异常（C1）。 */
  verify(sessionRef: SessionRef, notificationId: string): Promise<VerifyResult>;
  /** 票 20：逐 session 后端判别 + 注册（daemon 启动 / 新 session 注册时各调一次，#31）。重复注册重判。 */
  registerSession(sessionRef: SessionRef): Promise<BackendDetection>;
  /** 票 21 C1：启动自检——对全部已注册 session 的 transcript 后端做可读性自测；失败置全局降级，成功清除（恢复路径）。 */
  selfCheck(): Promise<SelfCheckResult>;
  /** C1 全局降级标志：true = 推送即视为 accepted、不再 verify（调用方直通；verify 亦拒推 verdict）。 */
  isDegraded(): boolean;
  /** 降级原因（warning 事件载荷；未降级 undefined）。 */
  degradeReason(): string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const VERDICTS: readonly string[] = ["passed", "failed", "waiting"];

function isHeaderV3(record: Record<string, unknown>): boolean {
  return record.type === "session" && record.version === 3;
}

function isHeaderV4(record: Record<string, unknown>): boolean {
  return record.kind === "header" && record.version === 4;
}

function isNotificationV3(record: Record<string, unknown>): boolean {
  return record.type === "custom_message" && record.customType === NOTIFICATION_CUSTOM_TYPE;
}

function isNotificationV4(record: Record<string, unknown>): boolean {
  if (record.kind !== "entry" || record.type !== "message") return false;
  const message = record.message;
  return isRecord(message) && message.role === "custom" && message.customType === NOTIFICATION_CUSTOM_TYPE;
}

/** 命中通知条目的抽取面（字段路径表逐条落地；lane 信封单列；format 按命中路径归类）。 */
interface NotificationHit {
  notificationId: unknown;
  verdict: unknown;
  evidenceRef: unknown;
  /** 命中条目所处形态代 = 命中字段路径（v3 载体/v4 载体），不依赖文件头单点。 */
  format: TranscriptFormat;
  lane?: string;
}

function hitOfV3(record: Record<string, unknown>): NotificationHit {
  const details = record.details;
  return {
    notificationId: isRecord(details) ? details.notificationId : undefined,
    verdict: isRecord(details) ? details.verdict : undefined,
    evidenceRef: isRecord(details) ? details.evidenceRef : undefined,
    format: "v3",
  };
}

function hitOfV4Message(message: Record<string, unknown>): NotificationHit {
  const details = message.details;
  const lane = Array.isArray(message.content)
    ? message.content.find((item): item is { sessionId: string } => isRecord(item) && typeof item.sessionId === "string")
        ?.sessionId
    : undefined;
  return {
    notificationId: isRecord(details) ? details.notificationId : undefined,
    verdict: isRecord(details) ? details.verdict : undefined,
    evidenceRef: isRecord(details) ? details.evidenceRef : undefined,
    format: "v4",
    ...(lane !== undefined ? { lane } : {}),
  };
}

function hitOfV4(record: Record<string, unknown>): NotificationHit {
  return hitOfV4Message(record.message as Record<string, unknown>);
}

function firstMeaningfulLine(content: string): string | undefined {
  return content.split("\n").find((line) => line.trim() !== "");
}

/** 文件头采样形态判别（locate 与后端判别共用；content 已读到，不碰 fs）。 */
function sampleHead(content: string): TranscriptFormat | "unknown" {
  const first = firstMeaningfulLine(content);
  if (first === undefined) return "unknown";
  try {
    const header: unknown = JSON.parse(first);
    if (isRecord(header)) {
      if (isHeaderV4(header)) return "v4";
      if (isHeaderV3(header)) return "v3";
    }
  } catch {
    // 头行本身撕裂/非 JSON → unknown（最保守路径）
  }
  return "unknown";
}

/** JSONL 扫描（撕裂尾行容错）→ 命中条目集；中段坏行 → corrupt。 */
function scanJsonl(content: string): { hits: NotificationHit[] } | { corrupt: true } {
  const lines = content.split("\n");
  let lastMeaningful = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") lastMeaningful = i;
  }

  const hits: NotificationHit[] = [];

  for (let i = 0; i <= lastMeaningful; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // 撕裂容错：仅最后一个非空行解析失败 = 未确认写入，跳过只影响该行；
      // 中段坏行是 corruption（harness-v2 原义）→ 保守降级。
      if (i === lastMeaningful) break;
      return { corrupt: true };
    }
    if (!isRecord(entry)) continue;
    if (isNotificationV3(entry)) hits.push(hitOfV3(entry));
    else if (isNotificationV4(entry)) hits.push(hitOfV4(entry));
  }
  return { hits };
}

/** 命中条目 → verdict 裁决（两后端共享的聚合面——等价面保证，票 20）。 */
function decide(hits: NotificationHit[], notificationId: string): VerifyResult {
  const matched = hits.filter((h) => h.notificationId === notificationId);
  if (matched.length === 0) return { verdict: "waiting", reason: "not-found" };

  if (matched.some((h) => typeof h.verdict !== "string" || !VERDICTS.includes(h.verdict))) {
    return { verdict: "unknown", reason: "verdict-missing" };
  }
  const distinct = [...new Set(matched.map((h) => h.verdict as string))];
  if (distinct.length > 1) return { verdict: "unknown", reason: "conflicting-verdicts" };

  const winner = matched[matched.length - 1]; // 多条同 verdict：取最新（文件序 / seq 序）
  return {
    verdict: winner.verdict as Exclude<AdapterVerdict, "unknown">,
    ...(typeof winner.evidenceRef === "string" ? { evidenceRef: winner.evidenceRef } : {}),
    format: winner.format, // 形态标记按命中路径归类（header 仅 locate 提示，不参与 verify 归类）
    ...(winner.lane !== undefined ? { lane: winner.lane } : {}),
  };
}

/** SQLite 点查行 → 命中条目（payload = v4 custom agent message；与 JSONL 共用字段路径抽取）。 */
function scanSqlite(rows: SqliteEntryRow[]): { hits: NotificationHit[] } | { corrupt: true } {
  const hits: NotificationHit[] = [];
  const seenSeqs = new Set<number>();
  for (const row of rows) {
    if (seenSeqs.has(row.seq)) continue; // 同条目多 branch 复制行去重（harness-v2 branch 复制语义）
    seenSeqs.add(row.seq);
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      return { corrupt: true }; // 库内坏 payload = corruption（SQL 后端无撕裂尾行形态）
    }
    if (
      isRecord(payload) &&
      payload.role === "custom" &&
      payload.customType === NOTIFICATION_CUSTOM_TYPE
    ) {
      hits.push(hitOfV4Message(payload));
    }
  }
  return { hits };
}

function isEnoent(err: unknown): boolean {
  return isRecord(err) && err.code === "ENOENT";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** pi settings 会话存储信号（key 待对齐：harness-v2 settings 未定稿，代表形态）；settings 不可读/坏 JSON = 无信号。 */
function settingsSignalsSqlite(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && isRecord(parsed.sessionStorage) && parsed.sessionStorage.backend === "sqlite";
  } catch {
    return false;
  }
}

function createTranscriptAdapter(fs: Fs, opts?: TranscriptAdapterOptions): TranscriptAdapter {
  const settingsPath = opts?.settingsPath;

  /** 后端判别（#31）：pi settings 会话存储信号 + transcript 文件头采样 → 三路分流。 */
  async function detectBackend(sessionRef: SessionRef): Promise<BackendDetection> {
    let settingsSqlite = false;
    if (settingsPath !== undefined) {
      try {
        settingsSqlite = settingsSignalsSqlite(await fs.readFile(settingsPath));
      } catch {
        // settings 不可读 = 无信号 → 走文件头采样/默认 JSONL（最保守）
      }
    }
    let head: TranscriptFormat | "unknown";
    try {
      head = sampleHead(await fs.readFile(sessionRef.sessionFile));
    } catch {
      head = "unknown"; // 文件未建/不可读：无头信号
    }
    if (settingsSqlite) {
      if (head !== "unknown") return { backend: "jsonl", warning: "ambiguous-backend" }; // settings↔JSONL 头矛盾
      if (sessionRef.sessionId === undefined) return { backend: "jsonl", warning: "ambiguous-backend" }; // sqlite 信号不完整：库内无法定域
      return { backend: "sqlite" };
    }
    return { backend: "jsonl" }; // 无 sqlite 信号：JSONL 扫描最保守（头 unknown 含新会话未落盘常态，不算歧义）
  }

  // 判别缓存与注册表按 (sessionFile, sessionId) 联合键（评审 Finding 2/3）：sessionFile 单键会把
  // 无 ID ref 的歧义判别泼给带 ID ref，也会让同库第二 session 覆盖第一 ref（自检漏探）。
  const backendByKey = new Map<string, BackendDetection>();
  const refByKey = new Map<string, SessionRef>(); // 已注册 ref（selfCheck 自检面，同库多 session 全保留）

  function refKey(ref: SessionRef): string {
    return `${ref.sessionFile}\u0000${ref.sessionId ?? ""}`;
  }

  async function backendFor(sessionRef: SessionRef): Promise<{ detection: BackendDetection; lazy: boolean }> {
    const key = refKey(sessionRef);
    const cached = backendByKey.get(key);
    if (cached !== undefined) return { detection: cached, lazy: false };
    const detection = await detectBackend(sessionRef); // 未注册 ref：惰性判别一次并缓存
    backendByKey.set(key, detection);
    return { detection, lazy: true };
  }

  async function verifyInternal(sessionRef: SessionRef, notificationId: string): Promise<VerifyResult> {
    const { detection, lazy } = await backendFor(sessionRef);
    const withLazyWarning = (result: VerifyResult): VerifyResult =>
      lazy && detection.warning !== undefined ? { ...result, warning: detection.warning } : result;
    if (detection.backend === "sqlite") {
      if (sessionRef.sessionId === undefined) return withLazyWarning({ verdict: "unknown", reason: "unreadable" }); // 注册判别已保证；防御不一致 ref
      let rows: SqliteEntryRow[];
      try {
        rows = queryNotificationEntries(sessionRef.sessionFile, sessionRef.sessionId, NOTIFICATION_CUSTOM_TYPE);
      } catch {
        return withLazyWarning({ verdict: "unknown", reason: "unreadable" }); // 缺库/权限/锁 → unreadable（C1 正常返回值）
      }
      const outcome = scanSqlite(rows);
      return withLazyWarning(
        "corrupt" in outcome ? { verdict: "unknown", reason: "corrupt-line" } : decide(outcome.hits, notificationId),
      );
    }

    let content: string;
    try {
      content = await fs.readFile(sessionRef.sessionFile);
    } catch {
      return withLazyWarning({ verdict: "unknown", reason: "unreadable" });
    }
    const outcome = scanJsonl(content);
    return withLazyWarning(
      "corrupt" in outcome ? { verdict: "unknown", reason: "corrupt-line" } : decide(outcome.hits, notificationId),
    );
  }

  let degraded = false;
  let degradeReasonValue: string | undefined;

  /** 自检探针：单 session 后端可读性自测 → "ok" 或失败原因。ENOENT = 未落盘（JSONL 文件与 SQLite 库同语义），非后端故障。 */
  async function probe(sessionRef: SessionRef): Promise<"ok" | string> {
    const { detection } = await backendFor(sessionRef);
    if (detection.backend === "sqlite") {
      if (sessionRef.sessionId === undefined) return "session-unscoped";
      let rows: SqliteEntryRow[];
      try {
        rows = queryNotificationEntries(sessionRef.sessionFile, sessionRef.sessionId, NOTIFICATION_CUSTOM_TYPE);
      } catch (err) {
        // SQLite 打开错误不分缺文件与坏库/无权限（同码 CANTOPEN）——fs 层 ENOENT 复判缺库：
        // 缺库 = 未落盘（评审 Finding 1，非故障）；文件存在但坏库/锁死 = 真故障。
        try {
          await fs.readFile(sessionRef.sessionFile);
        } catch (fsErr) {
          if (isEnoent(fsErr)) return "ok";
          return `unreadable(${errText(fsErr)})`;
        }
        return `unreadable(${errText(err)})`;
      }
      const outcome = scanSqlite(rows);
      return "corrupt" in outcome ? "corrupt-line" : "ok";
    }
    let content: string;
    try {
      content = await fs.readFile(sessionRef.sessionFile);
    } catch (err) {
      return isEnoent(err) ? "ok" : `unreadable(${errText(err)})`;
    }
    const outcome = scanJsonl(content);
    return "corrupt" in outcome ? "corrupt-line" : "ok";
  }

  return {
    async locate(sessionRef: SessionRef): Promise<LocateResult | null> {
      let content: string;
      try {
        content = await fs.readFile(sessionRef.sessionFile);
      } catch {
        return null; // ENOENT 等：locate 失败路径（会话未创建/已删）
      }
      return { path: sessionRef.sessionFile, format: sampleHead(content) };
    },

    async verify(sessionRef: SessionRef, notificationId: string): Promise<VerifyResult> {
      if (degraded) return { verdict: "unknown", reason: "degraded" }; // C1 全局降级：不再推导 verdict（推送即视为 accepted，权威基面）
      return verifyInternal(sessionRef, notificationId);
    },

    async registerSession(sessionRef: SessionRef): Promise<BackendDetection> {
      const detection = await detectBackend(sessionRef); // 注册时点重判（重复注册重判，票 20）
      backendByKey.set(refKey(sessionRef), detection);
      refByKey.set(refKey(sessionRef), sessionRef);
      return detection;
    },

    async selfCheck(): Promise<SelfCheckResult> {
      for (const sessionRef of refByKey.values()) {
        const failure = await probe(sessionRef);
        if (failure !== "ok") {
          degraded = true;
          degradeReasonValue = `${sessionRef.sessionFile}: ${failure}`;
          return { ok: false, reason: degradeReasonValue };
        }
      }
      degraded = false; // 恢复路径：再次自检成功即清除降级（票 21）
      degradeReasonValue = undefined;
      return { ok: true };
    },

    isDegraded(): boolean {
      return degraded;
    },

    degradeReason(): string | undefined {
      return degradeReasonValue;
    },
  };
}

export { createTranscriptAdapter };
