/**
 * protocol — pi-events-daemon 的零依赖叶模块，线协议唯一来源（#31 操作面表 + JSON-RPC 单行帧）。
 *
 * 同一 socket 两种帧型，编解码按帧型分流：
 *   - 短连接帧：op 请求/响应，带请求 id（JSON-RPC request/response）。
 *   - 长连接帧：daemon 推送 notification 行（无 id）、extension 的传输确认行 ack、
 *     连接声明行 session_start（长连接建立 = SESSION_START 信号）。ack 是内部传输
 *     确认行，不是 op（#31 两段式 ack：Ok = accepted）。
 *
 * 畸形帧（空行/坏 JSON/未知 op/超长行）一律跳过返回 null，绝不抛错。
 * 零依赖：本模块不引入任何其他模块或第三方库（测试有源码断言，depcruise eda-leaf-zero-dep-protocol）。
 */

// ---------------------------------------------------------------------------
// 9 op 契约类型（逐字取 #31 操作面表）
// ---------------------------------------------------------------------------

/** 9 op 名，正典 = #31 操作面表。 */
export const OP_NAMES = [
  "subscribe",
  "cancel",
  "query",
  "publish",
  "drain",
  "evidence",
  "status",
  "validate",
  "templates",
] as const;
export type OpName = (typeof OP_NAMES)[number];

/** JSON-RPC 请求 id。 */
export type RequestId = string | number;

/** 实体标识：source-system native identifier 字符串（CONTEXT.md EntityRef，agent 不铸造不解析）。 */
export type EntityRef = string;

/** schedule spec（#31 正典）：type 枚举即扩展接口。 */
export type ScheduleSpec = { type: "interval"; every: string } | { type: "cron"; expr: string; tz?: string };

/** 判定器 agent 可见面（#31）：verdict 一律语义名，退出码不外泄。 */
export type ValidateReport = {
  syntaxOk: boolean;
  verdict: "passed" | "failed" | "waiting";
  reason: string;
  evidence: string;
  durationMs: number;
  warnings: string[];
};

/** subscribe opts（#31 R1 A2 补全 + threshold 裁定）。opts 永不含 shell/schedule（模板形态）。 */
export type SubscribeOpts = {
  /** on 谓词：状态值 / 状态集 / 命名转换（如 digest-changed）。 */
  on?: string | string[];
  once?: boolean;
  flip?: boolean;
  template?: string;
  smoke?: boolean;
  sessionId?: string;
  /** 两阶段订阅的 flip 判定（缺省沿用 check）。 */
  readyCheck?: string;
  /** 到期自动关闭（I8）。 */
  ttl?: string;
  failureThreshold?: number;
  successThreshold?: number;
};

/** subscribe：{entityRef | url | check, opts?} → 订阅成功形态。 */
export type SubscribeRequest = { entityRef?: EntityRef; url?: string; check?: string; opts?: SubscribeOpts };
/** subscribe 成功：{subscriptionId, entityRef, state, validate?, warnings?[]}（state 为 null 直到首个 verdict）。 */
export type SubscribeOk = {
  subscriptionId: string;
  entityRef: EntityRef;
  state: string | null;
  validate?: ValidateReport;
  warnings?: string[];
};
/** subscribe smoke 失败：{subscribed: false, validate} 不抛错（#31 操作面表）。 */
export type SubscribeSmokeFailed = { subscribed: false; validate: ValidateReport };
export type SubscribeResponse = SubscribeOk | SubscribeSmokeFailed;

/** cancel：{subscriptionId} → {cancelled: true}（幂等）。 */
export type CancelRequest = { subscriptionId: string };
export type CancelResponse = { cancelled: true };

/** query 读侧归一（吸收 states 查询 / listChildren / backlog / dead-letter 清单）。 */
export type QueryRequest = { entityRef?: EntityRef; scope?: string; session?: string };
export type QueryEntity = {
  entityRef: EntityRef;
  state: string | null;
  payloadSummary?: unknown;
  lastProbedAt?: string;
  backlog?: number;
  children?: QueryEntity[];
};
export type QueryResponse = { entities: QueryEntity[]; deadLetters: unknown[] };

/** publish：agent 断言 {entityRef, transition:{to, contentIdentity?, payload?}} → {eventSeq, from, to}（非法 to 同步报错）。 */
export type PublishRequest = {
  entityRef: EntityRef;
  transition: { to: string; contentIdentity?: string; payload?: unknown };
};
export type PublishResponse = { eventSeq: number; from: string; to: string };

/** drain：兑现 parked，{sessionId?} → {drained, deadLetterSummary}（SESSION_START 自动 + 手动幂等）。 */
export type DrainRequest = { sessionId?: string };
export type DrainResponse = { drained: number; deadLetterSummary: { count: number; oldestAge: number } }; // oldestAge 单位 ms

/** evidence：指针解引用 {evidenceRef} → {content, truncated}。 */
export type EvidenceRequest = { evidenceRef: string };
export type EvidenceResponse = { content: string; truncated: boolean };

/** status：登记处写入 {type, key, state?, payload?} → {entityRef, state, event?}（状态变更自动发事件）。 */
export type StatusRequest = { type: string; key: string; state?: string; payload?: unknown };
/** event 形状归 domain（Transitioned 事件族），线层透传。 */
export type StatusResponse = { entityRef: EntityRef; state: string | null; event?: unknown };

/** validate：check 体检 {check} → 判定器报告。 */
export type ValidateRequest = { check: string };
export type ValidateResponse = ValidateReport;

/** templates：渐进式披露 {profile?} → 模板清单。 */
export type TemplatesRequest = { profile?: string };
export type TemplateInfo = {
  name: string;
  entityType: string;
  states: string[];
  schedule: ScheduleSpec;
  /** 模板参数名 → 说明。 */
  params: Record<string, string>;
  usage: string;
};
export type TemplatesResponse = { templates: TemplateInfo[] };

/** 9 op 请求/响应契约总表：op handler 以 OpRequest<N>/OpResponse<N> 在编译期对齐契约。 */
export interface OpContract {
  subscribe: { req: SubscribeRequest; res: SubscribeResponse };
  cancel: { req: CancelRequest; res: CancelResponse };
  query: { req: QueryRequest; res: QueryResponse };
  publish: { req: PublishRequest; res: PublishResponse };
  drain: { req: DrainRequest; res: DrainResponse };
  evidence: { req: EvidenceRequest; res: EvidenceResponse };
  status: { req: StatusRequest; res: StatusResponse };
  validate: { req: ValidateRequest; res: ValidateResponse };
  templates: { req: TemplatesRequest; res: TemplatesResponse };
}
export type OpRequest<N extends OpName = OpName> = OpContract[N]["req"];
export type OpResponse<N extends OpName = OpName> = OpContract[N]["res"];

// ---------------------------------------------------------------------------
// JSON-RPC 单行帧编解码
// ---------------------------------------------------------------------------

/** JSON-RPC error object。错误信息一律列可用选项（#31）。 */
export type RpcError = { code: number; message: string; data?: unknown };

/** op 请求帧（短连接，带请求 id）。 */
export type OpRequestFrame = { kind: "op-request"; id: RequestId; op: OpName; params: Record<string, unknown> };
/** op 响应帧：result 与 error 二选一（JSON-RPC）。 */
export type OpResponseFrame =
  | { kind: "op-response"; id: RequestId; result: unknown; error?: undefined }
  | { kind: "op-response"; id: RequestId; result?: undefined; error: RpcError };
/** daemon 推送 notification 行（长连接，无 id；method+params 透传）。 */
export type NotificationFrame = { kind: "notification"; method: string; params: unknown };
/** 传输确认行（extension → daemon，两段式 ack 的 accepted 段）。 */
export type AckFrame = { kind: "ack"; notificationId: string };
/** 长连接建立声明行（SESSION_START 信号，daemon 触发该 session 的 drain）。 */
export type SessionStartFrame = { kind: "session-start"; sessionId: string };
export type Frame = OpRequestFrame | OpResponseFrame | NotificationFrame | AckFrame | SessionStartFrame;

/** 非 op 保留方法（长连接内部帧，带 id 也不算 op 请求）。 */
const ACK_METHOD = "ack";
const SESSION_START_METHOD = "session_start";

/** 单行帧长度上限（超长行跳过）。通知内联 >2KB 走 evidenceRef（#31），64KiB 留足余量。 */
// shortcut: 按字符数近似字节数，多字节字符下偏宽松；出现滥用再换 Buffer.byteLength
export const MAX_LINE_LENGTH = 64 * 1024;

/** 编码 op 请求帧（短连接）：{"jsonrpc":"2.0","id","method":op,"params"}。单行输出。 */
export function encodeRequest(id: RequestId, op: OpName, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: op, params });
}

/** 编码成功响应帧：{"jsonrpc":"2.0","id","result"}。 */
export function encodeResult(id: RequestId, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

/** 编码错误响应帧：{"jsonrpc":"2.0","id","error"}。 */
export function encodeError(id: RequestId, error: RpcError): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error });
}

/** 编码 daemon 推送 notification 行（长连接，无 id）。 */
export function encodeNotification(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

/** 编码传输确认行（extension → daemon）。 */
export function encodeAck(notificationId: string): string {
  return JSON.stringify({ jsonrpc: "2.0", method: ACK_METHOD, params: { notificationId } });
}

/** 编码长连接声明行（SESSION_START 信号）。 */
export function encodeSessionStart(sessionId: string): string {
  return JSON.stringify({ jsonrpc: "2.0", method: SESSION_START_METHOD, params: { sessionId } });
}

/** 解码单行帧；畸形帧（空行/坏 JSON/未知 op/超长行/形状不符）返回 null，绝不抛错。 */
export function decodeLine(line: string): Frame | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LINE_LENGTH) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(msg) || msg.jsonrpc !== "2.0") return null;

  if ("method" in msg) {
    if (typeof msg.method !== "string") return null;
    const method = msg.method;
    if ("id" in msg) {
      // 短连接帧：method 必须是 9 op 之一；未知 op / ack / session_start 带 id 都不是合法 op 请求。
      // id 成员存在但非法（如 true/null）→ 畸形帧，不得降级当 notification。
      if (!isRequestId(msg.id)) return null;
      if (!isOpName(method)) return null;
      if (msg.params !== undefined && !isRecord(msg.params)) return null;
      return { kind: "op-request", id: msg.id, op: method, params: isRecord(msg.params) ? msg.params : {} };
    }
    // 长连接帧（无 id）
    if (method === ACK_METHOD) {
      return isRecord(msg.params) && typeof msg.params.notificationId === "string"
        ? { kind: "ack", notificationId: msg.params.notificationId }
        : null;
    }
    if (method === SESSION_START_METHOD) {
      return isRecord(msg.params) && typeof msg.params.sessionId === "string"
        ? { kind: "session-start", sessionId: msg.params.sessionId }
        : null;
    }
    return { kind: "notification", method, params: msg.params };
  }

  // 无 method → JSON-RPC 响应
  if (!isRequestId(msg.id)) return null;
  if ("result" in msg) {
    return { kind: "op-response", id: msg.id, result: msg.result, error: undefined };
  }
  if (
    isRecord(msg.error) &&
    typeof msg.error.code === "number" &&
    typeof msg.error.message === "string"
  ) {
    const error: RpcError = { code: msg.error.code, message: msg.error.message };
    if (msg.error.data !== undefined) error.data = msg.error.data;
    return { kind: "op-response", id: msg.id, result: undefined, error };
  }
  return null;
}

/** 批量解码：按行分流，畸形帧跳过，返回合法帧序列。 */
export function decodeLines(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of text.split("\n")) {
    const frame = decodeLine(line);
    if (frame) frames.push(frame);
  }
  return frames;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isRequestId(v: unknown): v is RequestId {
  return typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
}

function isOpName(method: string): method is OpName {
  return (OP_NAMES as readonly string[]).includes(method);
}

// ---------------------------------------------------------------------------
// D1a 校验分层：手写最小校验器（required/enum/type/正则 子集）。
// schemas/ 三契约文件的 daemon 侧消费口（I-01 profile 注册表校验）；
// 完整 JSON Schema 校验归 extension/CLI 侧。
// ---------------------------------------------------------------------------
export * from "./validate.ts";
