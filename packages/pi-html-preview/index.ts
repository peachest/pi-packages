/**
 * vscode_preview — pi extension
 *
 * Opens a file in VS Code Live Preview by talking to the preview-bridge
 * vscode extension (see vscode-bridge/ in this package): a tiny TCP server
 * inside the vscode extension host that executes commands on request.
 *
 * One tool call replaces the manual flow: ctrl+click the file path in the
 * response, then click Live Preview's preview button. Live Preview keeps
 * managing the HTTP server + auto-refresh as before.
 *
 * Install (this repo): pi install ./packages/pi-html-preview
 * Bridge install (once, after cloning/pulling): vscode-bridge/install.sh + reload window
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// keep in sync with vscode-bridge/hyx-preview-bridge-*/extension.js
const BASE_PORT = 39271;
const REGISTRY = join(homedir(), ".vscode-server", "preview-bridge-registry.json");

export type PreviewTarget = "internal" | "external";

/** Pure mapping of (path, target) → vscode command + args. */
export function buildCommand(
	path: string,
	target: PreviewTarget
): { command: string; args: string[] } {
	return target === "external"
		? { command: "livePreview.start.externalPreview.atFile", args: [`file://${path}`] }
		: { command: "livePreview.start.preview.atFileString", args: [path] };
}

interface BridgeEntry {
	pid: number;
	port: number;
	folders?: string[];
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException)?.code === "EPERM"; // exists, just not ours
	}
}

/** Pick the bridge whose workspace contains the file (multi-window); fallback first alive. */
export function chooseBridge(entries: BridgeEntry[], filePath: string, cwd: string): BridgeEntry | null {
	const aliveEntries = (entries || []).filter((e) => alive(e.pid));
	if (aliveEntries.length === 0) return null;
	const inWindow = (e: BridgeEntry) =>
		(e.folders ?? []).some((f) => filePath.startsWith(`${f  }/`) || cwd.startsWith(`${f  }/`));
	return aliveEntries.find(inWindow) ?? aliveEntries[0];
}

function sendToBridge(
	port: number,
	payload: { command: string; args: string[] },
	timeoutMs = 5000
): Promise<{ ok: boolean; error?: string }> {
	return new Promise((resolvePromise, reject) => {
		const socket = connect(port, "127.0.0.1");
		let buf = "";
		const fail = (err: Error) => {
			socket.destroy();
			reject(err);
		};
		socket.setTimeout(timeoutMs, () => fail(new Error(`bridge timeout after ${timeoutMs}ms`)));
		socket.on("error", fail);
		socket.on("data", (d) => (buf += d));
		socket.on("connect", () => socket.end(JSON.stringify(payload)));
		socket.on("close", () => {
			try {
				resolvePromise(JSON.parse(buf));
			} catch {
				reject(new Error(`bad bridge reply: ${buf.slice(0, 200)}`));
			}
		});
	});
}

const BRIDGE_NOT_RUNNING = [
	"preview-bridge vscode extension is not reachable.",
	"Fix (user, one-time):",
	"  bash <pi-mypackage>/packages/pi-html-preview/vscode-bridge/install.sh",
	"then run 'Developer: Reload Window' in VS Code.",
	"Multi-window: each window's bridge picks a free port and registers in",
	"~/.vscode-server/preview-bridge-registry.json; routing is by workspace folder.",
].join("\n");

export default function vscodePreviewExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "vscode_preview",
		label: "VS Code Preview",
		description:
			"Open a file in VS Code Live Preview via the preview-bridge extension. Use after generating or updating an HTML artifact so the user can view it in their browser immediately.",
		promptSnippet: "Open a file in VS Code Live Preview",
		promptGuidelines: [
			"After writing or regenerating an HTML file the user wants to see, call vscode_preview with its absolute path instead of asking the user to click Live Preview manually.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Absolute path of the file to preview (html/markdown/…)." }),
			target: Type.Optional(
				Type.Union([Type.Literal("internal"), Type.Literal("external")], {
					description:
						"internal: webview panel inside VS Code. external: open in the user's local browser (default, right for Remote SSH).",
				})
			),
		}),

		async execute(_toolCallId, params) {
			const path = resolve(params.path);
			const target: PreviewTarget = params.target ?? "external";
			const st = await stat(path).catch(() => null);
			if (!st?.isFile()) {
				return {
					content: [{ type: "text", text: `File not found: ${path}` }],
					details: { ok: false, path, target },
				};
			}

			const { command, args } = buildCommand(path, target);

			// registry may be absent (old bridge) → fall back to the fixed base port
			let bridge: BridgeEntry | null = null;
			let registryParsed = false;
			try {
				const reg = JSON.parse(readFileSync(REGISTRY, "utf8"));
				registryParsed = true;
				bridge = chooseBridge(reg.bridges ?? [], path, process.cwd());
			} catch {
				// no registry → legacy single-window bridge on BASE_PORT
			}
			if (registryParsed && !bridge) {
				// a readable registry means new-version bridges; no alive entry means
				// none is running — falling back to BASE_PORT would only misdiagnose
				return {
					content: [{ type: "text", text: BRIDGE_NOT_RUNNING }],
					details: { ok: false, path, target },
				};
			}
			const port = bridge?.port ?? BASE_PORT;

			try {
				const reply = await sendToBridge(port, { command, args });
				if (!reply.ok) {
					return {
						content: [{ type: "text", text: `VS Code command failed: ${reply.error}` }],
						details: { ok: false, path, target },
					};
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const isRefused = /ECONNREFUSED|ECONNRESET|timeout/i.test(msg);
				return {
					content: [
						{
							type: "text",
							text: isRefused ? BRIDGE_NOT_RUNNING : `Bridge call failed: ${msg}`,
						},
					],
					details: { ok: false, path, target },
				};
			}

			const where =
				target === "external"
					? "已在你的本地浏览器打开（Remote SSH 端口自动转发），改动文件会自动刷新"
					: "已在 VS Code 内以 webview 面板打开，改动文件会自动刷新";
			return {
				content: [{ type: "text", text: `Live Preview 已打开 ${path} — ${where}。` }],
				details: { ok: true, path, target },
			};
		},
	});
}
