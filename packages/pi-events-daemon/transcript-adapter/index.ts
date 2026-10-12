/**
 * transcript-adapter — public surface. See packages/README.md (deep-module layout).
 *
 * 票 19：I9 唯一权威点——daemon 内一切 transcript 读取收敛于此，verdict 推导不出本模块。
 * 零依赖只读叶（eda-adapter-fx-only：只可用 fx 端口；fx Fs 接口无写方法，机器强制只读）。
 *
 * ## 字段路径表（票 19 固化；形态来源见 index.test.ts 头注）
 *
 * 通知条目载体 = customType 为 NOTIFICATION_CUSTOM_TYPE 的 custom message；
 * 机器校验三元组住 details（pi API 语义：extension 专有元数据，不进 LLM 上下文）。
 *
 * | 形态                    | 载体条目                                                                                            | notificationId 路径            | verdict 路径            | evidenceRef 路径            | lane 信封（单列）                          |
 * |------------------------|-----------------------------------------------------------------------------------------------------|-------------------------------|------------------------|----------------------------|-------------------------------------------|
 * | v3 custom_message      | {type:"custom_message",customType,content,display?,details?,id,parentId,timestamp}                  | details.notificationId        | details.verdict        | details.evidenceRef        | 无（v3 无 lane 字段）                     |
 * | v4 custom agent message| {kind:"entry",lane?,type:"message",message:{role:"custom",customType,content,display?,details?}}    | message.details.notificationId| message.details.verdict| message.details.evidenceRef| 行级 "lane" 信封字段透传 → form.lane（verdict 路径与无信封形态相同，单列说明见此） |
 *
 * - lane 信封（herdr/multi-agent 派发场景）：v4 行级 `lane` 属 envelope 元数据（harness-v2：
 *   decode 即弃），adapter 只透传（form.lane），不参与 notificationId↔turn 映射——映射 =
 *   notificationId 相等，本模块内裁决。
 * - verdict 语义 = 通知条目自带的判定（billboard 的实体判定 / 派发回执的 turn 判定），
 *   取值域与 domain Verdict 同串（"passed"|"failed"|"waiting"，#31 判定三态）；adapter 不
 *   import domain（fx-only），结构同形即合约（store 先例 D3）。
 * - 保守降级（C1）：无法唯一确定 → "unknown" + reason；不抛异常。条目未出现 → "waiting"
 *   + "not-found"（撕裂尾行期间不产生假阴性：未落盘 ≠ 不存在）。
 */
import type { Fs } from "../fx/index.ts";

/** 通知条目 customType 标记——写入方（pi-events extension 包）与读取方共用此唯一拼写。 */
export const NOTIFICATION_CUSTOM_TYPE = "pi-events.notification";

/**
 * 会话引用——transcript 权威路径源。#31：路径来自 PI_SESSION_FILE / getSessionFile()
 * 的上游透传（extension 注册时上报），不从 cwd+uuid 反推。seam 为第二后端
 * （harness-v2 SQLite 点查，#31 MVP 内裁定）保留同一接口挂接点。
 */
export interface SessionRef {
  sessionFile: string;
}

/**
 * 判定四态：domain Verdict 三态 + unknown（C1 保守降级，非 domain 值——降级是本模块的
 * 正常返回值，不带 verdict 语义）。与 domain/types.ts 的 Verdict 结构同形（fx-only 不 import）。
 */
export type AdapterVerdict = "passed" | "failed" | "waiting" | "unknown";

/** transcript 形态代（文件头采样 / 命中路径判别）。 */
export type TranscriptFormat = "v3" | "v4";

/** 形态标记：命中条目所处形态代 + lane 信封透传（单列，见字段路径表）。 */
export interface EvidenceForm {
  format: TranscriptFormat;
  /** v4 行级 lane 信封原样透传（herdr/multi-agent 派发场景）；无信封时缺省。 */
  lane?: string;
}

/** locate 结果：路径 + 文件头采样形态判别（#31 逐 session 后端探测的最小面）。 */
export interface LocateResult {
  path: string;
  /** 头行缺失/无法判别 → "unknown"（按 JSONL 扫描最保守路径处理，#31；调用方记 warning）。 */
  format: TranscriptFormat | "unknown";
}

/** unknown/waiting 的原因码（C1：降级带原因，调用方可分类处理）。 */
export type VerifyReason =
  | "not-found"
  | "unreadable"
  | "corrupt-line"
  | "verdict-missing"
  | "conflicting-verdicts";

/** verify 结果——verdict + 通知条目携带的 evidence 指针 + 形态标记。 */
export interface VerifyResult {
  verdict: AdapterVerdict;
  /** 通知条目 details.evidenceRef 透传；条目未携带时缺省。 */
  evidenceRef?: string;
  /** 命中条目的形态标记；未命中/无法定位条目时缺省。 */
  form?: EvidenceForm;
  /** verdict 为 waiting/unknown 时的原因码。 */
  reason?: VerifyReason;
}

export interface TranscriptAdapter {
  /** 会话定位：读 transcript 并采样文件头判形态。文件不可读（未创建/已删）→ null。 */
  locate(sessionRef: SessionRef): Promise<LocateResult | null>;
  /** I9 点查：notificationId 在目标 transcript 的判定。永远正常返回，不抛异常（C1）。 */
  verify(sessionRef: SessionRef, notificationId: string): Promise<VerifyResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const VERDICTS: readonly string[] = ["passed", "failed", "waiting"];

function firstMeaningfulLine(content: string): string | undefined {
  return content.split("\n").find((line) => line.trim() !== "");
}

function createTranscriptAdapter(fs: Fs): TranscriptAdapter {
  return {
    async locate(sessionRef: SessionRef): Promise<LocateResult | null> {
      let content: string;
      try {
        content = await fs.readFile(sessionRef.sessionFile);
      } catch {
        return null; // ENOENT 等：locate 失败路径（会话未创建/已删）
      }
      const first = firstMeaningfulLine(content);
      if (first !== undefined) {
        try {
          const header: unknown = JSON.parse(first);
          if (isRecord(header)) {
            if (header.kind === "header" && header.version === 4) return { path: sessionRef.sessionFile, format: "v4" };
            if (header.type === "session" && header.version === 3) return { path: sessionRef.sessionFile, format: "v3" };
          }
        } catch {
          // 头行本身撕裂/非 JSON → unknown（最保守路径）
        }
      }
      return { path: sessionRef.sessionFile, format: "unknown" };
    },

    async verify(_sessionRef: SessionRef, _notificationId: string): Promise<VerifyResult> {
      throw new Error("票 19 组 2 未实现");
    },
  };
}

export { createTranscriptAdapter };
