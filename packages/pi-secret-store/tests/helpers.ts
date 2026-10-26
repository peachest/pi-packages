/**
 * 测试 harness：fake pi（捕获 registerTool/registerCommand/事件 handler）+
 * PI_CODING_AGENT_DIR 指向 tmp 沙箱（store 路径在工厂调用时读取 env，见 index.ts）。
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Store } from "../index.ts";

export type AnyHandler = (event: any, ctx: any) => any;

export interface Harness {
	agentDir: string;
	storePath: string;
	handlers: Record<string, AnyHandler[]>;
	tools: Map<string, any>;
	commands: Map<string, any>;
	notifyLog: string[];
}

/** harness 自建的 mkdtemp 目录清单（cleanupEnv 统一递归删除）+ 最近一次 setup 前的 PI_CODING_AGENT_DIR 原值。 */
const createdDirs: string[] = [];
let savedAgentDir: string | undefined;

/** 创建沙箱 agentDir，可选预置 secret-store.json（0600 语义由实现保证，fixture 只灌数据；agentDir 可覆盖（[11] 特殊字符目录））。
 *  fixture 类型 = lib/store.ts 导出的 Store（经入口 re-export，rolling-review-r2 #3 消除手写漂移面）。 */
export async function setupHarness(store?: Store, agentDirOverride?: string): Promise<Harness> {
	const agentDir = agentDirOverride ?? (await mkdtemp(join(tmpdir(), "pi-secret-store-test-")));
	if (!agentDirOverride) createdDirs.push(agentDir);
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	await mkdir(agentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	if (store) {
		await writeFile(
			join(agentDir, "secret-store.json"),
			JSON.stringify({ secrets: store }, null, 2) + "\n",
			{ mode: 0o600 },
		);
	}
	const handlers: Record<string, AnyHandler[]> = {};
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const notifyLog: string[] = [];
	const pi = {
		on: (event: string, handler: AnyHandler) => {
			(handlers[event] ??= []).push(handler);
			return () => {};
		},
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
		registerCommand: (name: string, options: any) => commands.set(name, options),
		registerShortcut: () => {},
		registerFlag: () => {},
	} as unknown as Parameters<typeof import("../index.ts").default>[0];
	const factory = (await import("../index.ts")).default;
	factory(pi);
	return {
		agentDir,
		storePath: join(agentDir, "secret-store.json"),
		handlers,
		tools,
		commands,
		notifyLog,
	};
}

/** 直接调用已注册工具的 execute（id/signal/onUpdate 测试不需要）。 */
export async function runExact(h: Harness, toolName: string, params: Record<string, unknown>, ctx: any = { mode: "tui", hasUI: true }) {
	const tool = h.tools.get(toolName);
	if (!tool) throw new Error(`tool ${toolName} not registered`);
	return tool.execute("test-call-id", params, undefined, undefined, ctx);
}

/** 逐个跑完 tool_call 监听器（P1 检测 → guard/注入），返回最后一个非 undefined 结果。
 *  commandOrInput 传对象可构造非 bash 工具输入（read 的 path 等，[7]）；ctx 可带 cwd。 */
export async function runToolCall(
	h: Harness,
	commandOrInput: string | Record<string, unknown>,
	toolName = "bash",
	ctx: Record<string, unknown> = {},
) {
	const input = typeof commandOrInput === "string" ? { command: commandOrInput } : commandOrInput;
	const event: any = { toolName, input };
	let last: any;
	for (const handler of h.handlers.tool_call ?? []) {
		const result = await handler(event, ctx);
		if (result !== undefined) last = result;
	}
	return { event, result: last };
}

/** tool_result / context 事件构造（details 可选，对应 BashToolResultEvent.details 等）。 */
export function toolResultEvent(text: string, details?: unknown) {
	const event: any = { toolCallId: "t1", input: {}, content: [{ type: "text", text }], isError: false };
	if (details !== undefined) event.details = details;
	return event;
}
export function contextEvent(texts: string[]) {
	return { type: "context", messages: texts.map((text) => ({ role: "user", content: text })) };
}

export function toolCtx(h: Harness, mode = "tui") {
	return { mode, hasUI: true, ui: { notify: (msg: string) => h.notifyLog.push(msg) } };
}

/** vitest afterEach 统一清理：恢复 PI_CODING_AGENT_DIR 原值（原无则删除），递归删除 harness 自建 mkdtemp 目录（#126）。 */
export async function cleanupEnv() {
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	await Promise.all(createdDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}
