#!/usr/bin/env node
/**
 * pi-secret-store 只读 CLI 出口（#191）：`pi-secret-store get NAME`。
 * 消费方：mcp.json stdio env 的 "!command" 挂钩（pi-mcp-adapter resolveCommandSecret 取 stdout.trim()
 * 为凭据值，命令失败 throw → MCP server 启动失败）。协议契约：凭据值走 stdout 单行，一切诊断走
 * stderr + 非零退出（fail-closed：名不存在 / 后端不可用 / 解密失败绝不输出空串）。
 * 只读：复用扩展同一后端解密链（createBackend/load），写面保持 secret_ensure 扩展工具独占。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createBackend } from "./lib/backend.ts";
import type { StoreEntry } from "./lib/store.ts";

// getAgentDir 语义的最小复刻（env 定向 → 缺省 ~/.pi/agent）：编译产物在 pi npm 区被 node 直接拉起，
// 不 import pi-coding-agent peer（bin 的模块解析链上没有它）。
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

const die = (code: number, msg: string): never => {
	process.stderr.write(`pi-secret-store: ${msg}\n`);
	process.exit(code);
};

const [cmd, name] = process.argv.slice(2);
if (cmd !== "get" || !name || process.argv.length > 4)
	die(2, `需要且仅需要一个用法：pi-secret-store get NAME（收到：${JSON.stringify(process.argv.slice(2))}）`);

try {
	// 纯读不取存储锁：与扩展读路径（secret_query/注入）同款——persist 走 tmp+rename 原子替换，读侧只见完整文件
	const store = await (await createBackend(agentDir)).load((w) => process.stderr.write(`${w}\n`));
	const entry: StoreEntry | undefined = store[name];
	if (entry === undefined)
		die(1, `凭证 ${name} 不存在于 agent 目录 ${agentDir} 下的存储（先用扩展工具 secret_ensure 录入）`);
	process.stdout.write(`${entry.value}\n`);
} catch (err) {
	die(1, (err as Error).message);
}
