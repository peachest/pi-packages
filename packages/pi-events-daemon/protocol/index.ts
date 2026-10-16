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
 *
 * 本模块同时拥有 D1a 最小校验器（#31 Schema 策略 R2-final：schema 子集
 * required/enum/type/正则——profile 注册表校验所需；完整 JSON Schema 校验归 extension 侧）。
 * 零依赖：本模块不引入任何其他模块或第三方库（测试有源码断言，depcruise eda-leaf-zero-dep-protocol；
 * 故全部代码单文件，不拆子文件）。
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

/** 实体线引用单串（EntityRefId）= `${type}:${nativeKey}`（如 gitlab:mr:project/https://...；domain entityRefKeyOf 同形零映射，agent 不铸造不解析）。status op 保留 {type, key} 拆字段形态——wire 单串 ↔ 拆字段两形态，daemon 内归一。 */
export type EntityRefId = string;

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

/** subscribe opts（#31 R1 A2 补全 + threshold 裁定）。shell 永不含；schedule 仅 ad-hoc 形态（模板形态不含——B1：schedule 归模板资产）。 */
export type SubscribeOpts = {
  /** on 谓词：状态值 / 状态集 / 命名转换（如 digest-changed）。 */
  on?: string | string[];
  once?: boolean;
  flip?: boolean;
  template?: string;
  smoke?: boolean;
  sessionId?: string;
  /** 订阅来源（编址分支输入，票 35 wire 补：缺省 session=agent 交互订阅；auto=events.json 声明链）。 */
  origin?: "session" | "auto";
  /** 两阶段订阅的 flip 判定（缺省沿用 check）。 */
  readyCheck?: string;
  /** 到期自动关闭（I8）。单位毫秒（milliseconds）。 */
  ttl?: number;
  /** ad-hoc 形态探针节奏（缺省 60s interval 由 daemon 内置缺省承载）；every 单位毫秒（60000 = 60s）。 */
  schedule?: { type: "interval"; every: number } | { type: "cron"; expr: string; tz?: string };
  failureThreshold?: number;
  successThreshold?: number;
};

/** subscribe：{entityRef | url | check, opts?} → 订阅成功形态。 */
export type SubscribeRequest = { entityRef?: EntityRefId; url?: string; check?: string; opts?: SubscribeOpts };
/** subscribe 成功：{subscriptionId, entityRef, state, validate?, warnings?[]}（state 为 null 直到首个 verdict）。 */
export type SubscribeOk = {
  subscriptionId: string;
  entityRef: EntityRefId;
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
export type QueryRequest = { entityRef?: EntityRefId; scope?: string; session?: string };
export type QueryEntity = {
  entityRef: EntityRefId;
  state: string | null;
  payloadSummary?: unknown;
  lastProbedAt?: string;
  backlog?: number;
  children?: QueryEntity[];
};
export type QueryResponse = { entities: QueryEntity[]; deadLetters: unknown[] };

/** publish：agent 断言 {entityRef, transition:{to, contentIdentity?, payload?}} → {eventSeq, from, to}（非法 to 同步报错）。 */
export type PublishRequest = {
  entityRef: EntityRefId;
  transition: { to: string; contentIdentity?: string; payload?: unknown };
};
/** from 可空：首转换 from=null（domain Transitioned 正典，#31）。 */
export type PublishResponse = { eventSeq: number; from: string | null; to: string };

/** drain：兑现 parked，{sessionId?} → {drained, deadLetterSummary}（SESSION_START 自动 + 手动幂等）。 */
export type DrainRequest = { sessionId?: string };
export type DrainResponse = { drained: number; deadLetterSummary: { count: number; oldestAge: number } }; // oldestAge 单位 ms

/** evidence：指针解引用 {evidenceRef} → {content, truncated}。 */
export type EvidenceRequest = { evidenceRef: string };
export type EvidenceResponse = { content: string; truncated: boolean };

/** status：登记处写入 {type, key, state?, payload?} → {entityRef, state, event?}（状态变更自动发事件）。{type, key} 为拆字段形态：wire entityRef 单串 ↔ 拆字段两形态并存，daemon 内归一。 */
export type StatusRequest = { type: string; key: string; state?: string; payload?: unknown };
/** event 形状归 domain（Transitioned 事件族），线层透传。 */
export type StatusResponse = { entityRef: EntityRefId; state: string | null; event?: unknown };

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
/** op 请求帧可选携带 daemon epoch（I12：帧级所有权校验，transport 执行点；缺省 = 旧 epoch 残留帧被拒）。 */
export type OpRequestFrame = {
  kind: "op-request";
  id: RequestId;
  op: OpName;
  params: Record<string, unknown>;
  epoch?: number;
};
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

/** 编码 op 请求帧（短连接）：{"jsonrpc":"2.0","id","method":op,"params"[,"epoch"]}。单行输出。 */
export function encodeRequest(id: RequestId, op: OpName, params: Record<string, unknown>, epoch?: number): string {
  return JSON.stringify(
    epoch === undefined
      ? { jsonrpc: "2.0", id, method: op, params }
      : { jsonrpc: "2.0", id, method: op, params, epoch },
  );
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
      return {
        kind: "op-request",
        id: msg.id,
        op: method,
        params: isRecord(msg.params) ? msg.params : {},
        ...(isEpochValue(msg.epoch) ? { epoch: msg.epoch } : {}),
      };
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

function isEpochValue(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isOpName(method: string): method is OpName {
  return (OP_NAMES as readonly string[]).includes(method);
}

// ---------------------------------------------------------------------------
// D1a 最小校验器：schema 子集 required/enum/type/正则（#31 Schema 策略 R2-final）
// ---------------------------------------------------------------------------

/** 校验器认识的 JSON Schema 基本类型名。 */
export type MiniType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

/**
 * 最小校验器 schema 子集：type/enum/pattern/properties/required/items。
 * schema 节点可直接取自 schemas/ 目录的完整 JSON Schema 文档——子集外关键词
 * （minimum、minLength、title…）按子集语义忽略，不报错（完整校验归 extension 侧）。
 */
export type MiniSchema = {
  type?: MiniType | MiniType[];
  /** 标量枚举（=== 相等）。错误信息列可用选项（#31 错误形态）。 */
  enum?: (string | number | boolean | null)[];
  /** 正则（ECMAScript 语法，对 string 值做未锚定 search，同 JSON Schema pattern 语义）。 */
  pattern?: string;
  properties?: Record<string, MiniSchema>;
  required?: string[];
  items?: MiniSchema;
};

/** 单次未命中：属性路径（点号，根为 ""，数组下标 [n]）+ 原因。 */
export type MiniIssue = { path: string; message: string };

/**
 * D1a 最小校验器：按 schema 子集校验 value，命中返回 issue 列表，全部放行返回 []。
 * 绝不抛错（非法正则按 issue 上报）——与帧解码同一“跳过不崩”精神。
 */
export function validateValue(schema: MiniSchema, value: unknown): MiniIssue[] {
  const issues: MiniIssue[] = [];
  checkNode(schema, value, "", issues);
  return issues;
}

function checkNode(schema: unknown, value: unknown, path: string, out: MiniIssue[]): void {
  // 非 object 节点 = 无约束（含垃圾输入，never-throw）
  if (!isRecord(schema)) return;

  const type = schema.type;
  if (type !== undefined) {
    const wanted = Array.isArray(type) ? type : [type];
    if (!wanted.some((t) => typeof t === "string" && typeMatches(t as MiniType, value))) {
      let message: string;
      try {
        const names = wanted.map((t) => (typeof t === "string" ? JSON.stringify(t) : String(t))).join("|");
        message = `期望类型 ${names}，实际 ${jsonTypeName(value)}`;
      } catch {
        // 垃圾 schema（成员 toString 污染）格式化抛错 → 转 issue，never-throw
        message = "期望类型格式化失败（垃圾 schema）";
      }
      out.push({ path, message });
    }
  }

  const en = schema.enum;
  if (Array.isArray(en) && !en.some((e) => e === value)) {
    let message: string;
    try {
      message = `值不在枚举 [${en.map(String).join(", ")}] 内`;
    } catch {
      // 垃圾 schema（成员 toString 污染）格式化抛错 → 转 issue，never-throw
      message = "值不在枚举内（枚举项不可字符串化）";
    }
    out.push({ path, message });
  }

  if (typeof schema.pattern === "string" && typeof value === "string") {
    let re: RegExp | null = null;
    try {
      re = new RegExp(schema.pattern);
    } catch {
      // 非法正则按 issue 上报，不抛
    }
    if (!re) out.push({ path, message: `schema 正则非法：/${schema.pattern}/` });
    else if (!re.test(value)) out.push({ path, message: `不匹配正则 /${schema.pattern}/` });
  }

  if (isRecord(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !Object.prototype.hasOwnProperty.call(value, key)) {
          out.push({ path, message: `缺少必填字段 ${key}` });
        }
      }
    }
    if (isRecord(schema.properties)) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(value, key)) checkNode(sub, value[key], childPath(path, key), out);
      }
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((el, i) => checkNode(schema.items, el, `${path}[${i}]`, out));
  }
}

function typeMatches(t: MiniType, v: unknown): boolean {
  switch (t) {
    case "object":
      return isRecord(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
  }
}

function jsonTypeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function childPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}
