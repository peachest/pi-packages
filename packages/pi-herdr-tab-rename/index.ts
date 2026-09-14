/**
 * Herdr Tab-Rename — pi extension
 *
 * Problem: qol's rename commands (`/rename`, `/qol:rename`, `/qol:rename:full`,
 * auto-rename) call `pi.setSessionName(name)`, which renames the session in
 * pi. When pi runs inside a Herdr tab, the tab label stays stale — the user
 * must rename twice to keep the tab list readable.
 *
 * Root cause: pi emits `session_info_changed` (name) on every setSessionName
 * (agent-session.js), and Herdr's socket API accepts `tab.rename`
 * ({tab_id, label}). Nothing bridges the two.
 *
 * This extension is that bridge. It listens to `session_info_changed` in TUI
 * sessions running under Herdr (HERDR_ENV=1) and forwards the new name to the
 * Herdr daemon via its unix socket (same JSON-RPC channel as
 * herdr-agent-state.ts: {id, method, params}\n).
 *
 * Gated on ctx.mode === "tui" so a bg subagent renaming its own session never
 * renames the user's tab. No-op outside Herdr.
 *
 * Install: pi install ./packages/pi-herdr-tab-rename  (from ~/projects/pi-mypackage)
 */

import net from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const socketPath = process.env.HERDR_SOCKET_PATH;
const socketEndpoint =
	process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const tabId = process.env.HERDR_TAB_ID;

function enabled(): boolean {
	return process.env.HERDR_ENV === "1" && !!socketEndpoint && !!tabId;
}

/** One best-effort `tab.rename` attempt over the Herdr socket. Resolves false on any failure. */
function renameAttempt(label: string, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let done = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const finish = (delivered: boolean) => {
			if (done) return;
			done = true;
			if (timeout) clearTimeout(timeout);
			socket.destroy();
			resolve(delivered);
		};

		const socket = net.createConnection(socketEndpoint!);
		socket.on("error", () => finish(false));
		socket.on("connect", () =>
			socket.write(
				`${JSON.stringify({
					id: `pi-herdr-tab-rename:${Date.now()}:${Math.random().toString(36).slice(2)}`,
					method: "tab.rename",
					params: { tab_id: tabId, label },
				})}\n`,
			),
		);
		socket.on("data", () => finish(true));
		socket.on("end", () => finish(false));
		timeout = setTimeout(() => finish(false), timeoutMs);
		timeout.unref?.();
	});
}

async function renameTab(label: string): Promise<boolean> {
	// Same retry shape as herdr-agent-state.ts: one short attempt, one longer.
	if (await renameAttempt(label, 500)) return true;
	return renameAttempt(label, 1500);
}

type SendFn = (label: string) => Promise<boolean> | boolean;

/** Installable core with an injectable sender (for tests). */
export function herdrTabRename(pi: ExtensionAPI, send: SendFn = (label) => renameTab(label)): void {
	if (!enabled()) return;

	let lastLabel: string | undefined;

	pi.on("session_info_changed", (event, ctx) => {
		// TUI only: bg subagent / JSON-mode sessions manage their own names,
		// never the user's Herdr tab.
		if (ctx?.mode !== "tui") return;
		const label = event.name?.trim();
		if (!label || label === lastLabel) return;
		lastLabel = label;
		void send(label);
	});
}

export default function (pi: ExtensionAPI): void {
	herdrTabRename(pi);
}
