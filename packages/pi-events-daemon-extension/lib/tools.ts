/**
 * tools — 9 op 模型可见工具面（票 34；#31 操作面表 A1 终裁）。
 *
 * 同源纪律（R3）：工具参数 schema = op.schema.json 的 request 节点原样（flat：不另包一层，
 * 显式 enums 直接来自契约）；工具描述 = op 节点 description。零手写 schema。
 * D1a 执行点：execute 先完整校验（lib/schema），命中即本地拒绝——extension 拒的帧到不了 daemon。
 */
import { OP_NAMES, type OpName, type RpcError } from "pi-events-daemon/protocol.ts";
import { validateFull, type Issue, type JsonSchema } from "./schema.ts";

export type TextBlock = { type: "text"; text: string };
export type ToolResult = { content: TextBlock[]; details?: unknown };

/** op 发送面（index.ts 注入真实 client；测试注入 fake）。 */
export type OpSender = (op: OpName, params: Record<string, unknown>) => Promise<unknown>;

/** pi ToolDefinition 的结构子集（注册边界由 index.ts cast 到 pi 类型）。 */
export interface OpToolDef {
  name: OpName;
  label: string;
  description: string;
  parameters: JsonSchema;
  promptSnippet: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<ToolResult>;
}

const text = (s: string): TextBlock => ({ type: "text", text: s });

const LABELS: Record<OpName, string> = {
  subscribe: "Subscribe",
  cancel: "Cancel",
  query: "Query",
  publish: "Publish",
  drain: "Drain",
  evidence: "Evidence",
  status: "Status",
  validate: "Validate",
  templates: "Templates",
};

/** 采纳率正典（#29）：一句定位，知识细节在 schema description（同源）。 */
const SNIPPETS: Record<OpName, string> = {
  subscribe: "Watch an entity/URL/check for state changes via pi-events-daemon",
  cancel: "Stop watching a subscription",
  query: "Look up entity states, backlogs and dead-letters",
  publish: "Assert an entity state transition to the registry",
  drain: "Deliver parked notifications for a session now",
  evidence: "Dereference an evidence pointer to full content",
  status: "Register an entity state (auto-emits events on change)",
  validate: "Dry-run a check command and get its verdict report",
  templates: "List available probe templates",
};

export function buildToolDefs(opts: { opSchema: JsonSchema; sender: OpSender }): OpToolDef[] {
  return OP_NAMES.map((op) => buildTool(op, opts.opSchema, opts.sender));
}

function buildTool(op: OpName, opSchema: JsonSchema, sender: OpSender): OpToolDef {
  const props = (opSchema.properties ?? {}) as Record<string, { properties?: { request?: JsonSchema }; description?: string }>;
  const node = props[op];
  const request = node?.properties?.request;
  if (!request) throw new Error(`op.schema.json 缺少 ${op}.request（同源契约损坏）`);

  // 评审 H：request 内 $ref 指向根文档 definitions（entityRef/adhocSchedule）——host 校验只见
  // 工具级 schema，definitions 必须随抽取内联；D1a validateFull 仍以 opSchema 为解析基准，不变。
  const parameters: JsonSchema = opSchema.definitions
    ? { ...request, definitions: opSchema.definitions }
    : request;

  return {
    name: op,
    label: LABELS[op],
    description: node.description ?? "",
    parameters,
    promptSnippet: SNIPPETS[op],
    async execute(_toolCallId, params) {
      const issues = validateFull(request, params, opSchema);
      if (issues.length > 0) return validationFailure(issues);
      try {
        const result = await sender(op, params);
        return { content: [text(present(op, result))], details: result };
      } catch (err) {
        return { content: [text(errorMessage(err))], details: { error: rpcShape(err) ?? String(err) } };
      }
    },
  };
}

/** D1a 本地拒绝：错误文案明示"帧未发送到 daemon"，issue 列表带路径（列可用选项形态）。 */
function validationFailure(issues: Issue[]): ToolResult {
  const lines = issues.map((i) => `- ${i.path || "<根>"}: ${i.message}`).join("\n");
  return {
    content: [text(`参数校验失败（帧未发送到 daemon）：\n${lines}`)],
    details: { validationIssues: issues },
  };
}

function rpcShape(err: unknown): RpcError | undefined {
  const e = err as Partial<RpcError> | null | undefined;
  if (e !== null && e !== undefined && typeof e.code === "number" && typeof e.message === "string") {
    return { code: e.code, message: e.message };
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  const rpc = rpcShape(err);
  if (rpc) return `daemon 错误 ${rpc.code}: ${rpc.message}`;
  return `daemon 调用失败: ${err instanceof Error ? err.message : String(err)}`;
}

/** 结果呈现：一句 headline（billboard 语义）+ 完整 JSON（模型可结构化消费）。 */
function present(op: OpName, result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  const body = JSON.stringify(result, null, 2) ?? "null";
  switch (op) {
    case "subscribe":
      return r.subscribed === false
        ? `订阅未建立（smoke 失败）：\n${body}`
        : `已订阅 ${r.subscriptionId} → ${r.entityRef}（state=${r.state ?? "null"}）\n${body}`;
    case "cancel":
      return r.cancelled === true ? `已取消 ${JSON.stringify(r)}` : `未取消（幂等）：\n${body}`;
    case "query": {
      const entities = Array.isArray(r.entities) ? r.entities.length : 0;
      const dead = Array.isArray(r.deadLetters) ? r.deadLetters.length : 0;
      return `实体 ${entities} 个，dead-letter ${dead} 条：\n${body}`;
    }
    case "publish":
      return `已发布 → ${r.to}（eventSeq=${r.eventSeq}，from=${r.from ?? "null"}）\n${body}`;
    case "drain": {
      const summary = r.deadLetterSummary as { count?: number } | undefined;
      return `已兑现 ${r.drained ?? 0} 条；dead-letter ${summary?.count ?? 0} 条\n${body}`;
    }
    case "evidence":
      return typeof r.content === "string" ? r.content : body;
    case "status":
      return `已登记 ${r.entityRef}（state=${r.state ?? "null"}）\n${body}`;
    case "validate":
      return `verdict=${r.verdict}${r.syntaxOk === false ? "（syntax 错误）" : ""}\n${body}`;
    case "templates": {
      const list = Array.isArray(r.templates) ? (r.templates as Array<{ name: string; usage: string }>) : [];
      const head = list.map((t) => `- ${t.name}: ${t.usage}`).join("\n");
      return `模板 ${list.length} 个\n${head}\n${body}`;
    }
  }
}
