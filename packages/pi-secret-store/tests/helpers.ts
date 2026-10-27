/**
 * 测试 harness：fake pi（捕获 registerTool/registerCommand/事件 handler）+
 * PI_CODING_AGENT_DIR 指向 tmp 沙箱（store 路径在工厂调用时读取 env，见 index.ts）。
 */
import { accessSync, constants } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Store } from "../index.ts";

export type AnyHandler = (event: any, ctx: any) => any;

/** 终审 P2 #3：本机真实 age 可执行性探测（~/.local/bin/age）。依赖真实 age 的 describe（直调或 shim 包装真实二进制）
 *  统一用 describe.skipIf(!hasRealAge) 守卫；skip 原因：requires local age binary at ~/.local/bin; install per README。 */
export const hasRealAge = (() => {
	try {
		accessSync(join(process.env.HOME ?? "/nonexistent", ".local/bin/age"), constants.X_OK);
		return true;
	} catch {
		return false;
	}
})();

export interface Harness {
	agentDir: string;
	storePath: string;
	/** setupHarness 的 backend 实参（r7 #7）：便于用例直接断言声明的后端 */
	backend: "plain" | "age";
	handlers: Record<string, AnyHandler[]>;
	tools: Map<string, any>;
	commands: Map<string, any>;
	notifyLog: string[];
}

/** harness 自建的 mkdtemp 目录清单（cleanupEnv 统一递归删除）+ 最近一次 setup 前的 PI_CODING_AGENT_DIR 原值。 */
const createdDirs: string[] = [];
let savedAgentDir: string | undefined;

/** 创建沙箱 agentDir，可选预置 secret-store.json（0600 语义由实现保证，fixture 只灌数据；agentDir 可覆盖（[11] 特殊字符目录））。
 *  fixture 类型 = lib/store.ts 导出的 Store（经入口 re-export，rolling-review-r2 #3 消除手写漂移面）。
 *  backend：写入 secret-store.conf 定向存储后端（#173）。缺省 "plain" = 现行为回归锁（现有测试语义不变）；
 *  age 语义测试显式传 "age"（缺省 age 是生产行为，测试沙箱内不隐式）。
 *  r6 #6 再强调：生产缺省 age、测试缺省 plain 是有意偏离——新增涉及后端/落盘行为的测试必须显式声明 backend，不得依赖缺省值。 */
export async function setupHarness(store?: Store, agentDirOverride?: string, backend: "plain" | "age" = "plain"): Promise<Harness> {
	const agentDir = agentDirOverride ?? (await mkdtemp(join(tmpdir(), "pi-secret-store-test-")));
	if (!agentDirOverride) createdDirs.push(agentDir);
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	await mkdir(agentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await writeFile(join(agentDir, "secret-store.conf"), `backend = ${backend}\n`, { mode: 0o600 });
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
		backend,
		handlers,
		tools,
		commands,
		notifyLog,
	};
}

/** r7 #7 防呆：age 行为测试的前置断言——沙箱 conf 确实定向 age 后端。setupHarness 缺省 plain（有意偏离
 *  生产缺省，见上），新增后端相关测试若遗漏显式传参会静默走 plain 使 age 覆盖失真；用例开头调用本辅助立即红。 */
export async function assertAgeBackend(h: Harness): Promise<void> {
	const conf = await readFile(join(h.agentDir, "secret-store.conf"), "utf8");
	if (!/^backend = age(\n|$)/.test(conf))
		throw new Error(`assertAgeBackend: 沙箱 backend 非 age（conf=${JSON.stringify(conf)}）——测试须 setupHarness(..., "age") 显式声明`);
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
