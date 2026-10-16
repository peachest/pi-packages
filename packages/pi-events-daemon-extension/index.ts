/**
 * pi-events-daemon-extension — agent 入口（#31 extension 模块，票 34-37）。
 *
 * 独立 pi 包（仓规 `pi install ./packages/pi-events-daemon-extension`，docs/agents/install-packages.md）。
 * 入口 index.ts 唯一公共面：默认导出 = pi extension 工具工厂；命名导出 = 票 34-37 的
 * 可单测面（schema 校验 / 工具面 / op 客户端 / events.json 声明链 / wake / batch 呈现）。
 * 实现藏 lib/（包内私有）；协议与契约 schema 经 pi-events-daemon 包根入口同源消费，零复制。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadOpSchema, type JsonSchema } from "./lib/schema.ts";
import { buildToolDefs, type OpSender, type OpToolDef } from "./lib/tools.ts";
import { createOpClient } from "./lib/client.ts";

/** 工厂注入面（测试替身 / 环境覆盖；缺省全走默认实现）。 */
export interface ExtensionDeps {
  opSchema?: JsonSchema;
  /** 覆盖 op 发送面（不建真实 client）。 */
  sender?: OpSender;
  socketPath?: string;
  epoch?: number;
  timeoutMs?: number;
}

export default function eventsDaemonExtension(pi: ExtensionAPI, deps: ExtensionDeps = {}): void {
  const opSchema = deps.opSchema ?? loadOpSchema();
  const client = deps.sender ? null : createOpClient({ socketPath: deps.socketPath, epoch: deps.epoch, timeoutMs: deps.timeoutMs });
  const sender: OpSender = deps.sender ?? ((op, params) => {
    if (!client) throw new Error("op client 未初始化");
    return client.request(op, params);
  });

  for (const tool of buildToolDefs({ opSchema, sender })) {
    // 同源 JSON Schema（无 TypeBox Kind 符号）→ pi 以 JSON Schema 路径校验（coerceWithJsonSchema + Compile）；
    // D1a 权威门在 lib/tools execute 内（完整校验客户端先行），此处 cast 仅为注册边界。
    pi.registerTool(tool as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
  }
}

// --- 可单测公共面（tests/ 经包根入口消费；deep-module 布局 packages/README.md） ---
export { validateFull, loadOpSchema, loadProfileSchema, loadEventsSchema, daemonSchemasDir } from "./lib/schema.ts";
export type { JsonSchema, Issue } from "./lib/schema.ts";
export { buildToolDefs } from "./lib/tools.ts";
export type { OpToolDef, OpSender, ToolResult } from "./lib/tools.ts";
export { createOpClient, readDaemonEpoch } from "./lib/client.ts";
export type { OpClient, OpClientConfig } from "./lib/client.ts";
