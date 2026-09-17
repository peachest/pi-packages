const vscode = require("vscode");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

// keep in sync with pi-html-preview/index.ts (BASE_PORT + REGISTRY path)
const BASE_PORT = 39271;
const PORT_TRIES = 10;
const REGISTRY = path.join(os.homedir(), ".vscode-server", "preview-bridge-registry.json");

function loadRegistry() {
	try {
		return JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
	} catch {
		return { bridges: [] };
	}
}

function saveRegistry(reg) {
	fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
	fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// drop entries whose exthost process is gone (crash, no clean dispose)
function pruneDead(reg) {
	reg.bridges = (reg.bridges || []).filter((b) => alive(b.pid));
}

function handleSocket(socket) {
	let buf = "";
	socket.on("data", (d) => (buf += d));
	socket.on("error", () => {});
	socket.on("end", () => {
		let msg;
		try {
			msg = JSON.parse(buf);
		} catch (e) {
			socket.end(JSON.stringify({ ok: false, error: `bad json: ${e.message}` }));
			return;
		}
		if (!msg || typeof msg.command !== "string") {
			socket.end(JSON.stringify({ ok: false, error: "missing command" }));
			return;
		}
		// "file:///abs/path" string args are promoted to vscode.Uri (external preview wants a Uri)
		const args = (msg.args || []).map((a) =>
			typeof a === "string" && a.startsWith("file://") ? vscode.Uri.parse(a) : a
		);
		vscode.commands
			.executeCommand(msg.command, ...args)
			.then(
				() => socket.end(JSON.stringify({ ok: true })),
				(err) => socket.end(JSON.stringify({ ok: false, error: String(err) }))
			);
	});
}

async function activate(context) {
	// probe BASE_PORT..BASE_PORT+PORT_TRIES-1 so multiple windows coexist
	let server = null;
	let port = 0;
	for (let p = BASE_PORT; p < BASE_PORT + PORT_TRIES && !server; p++) {
		server = await new Promise((resolve) => {
			const srv = net.createServer({ allowHalfOpen: true }, handleSocket);
			srv.once("error", () => resolve(null));
			srv.listen(p, "127.0.0.1", () => resolve(srv));
		});
		if (server) port = p;
	}
	if (!server) {
		console.error(`preview-bridge: no free port in ${BASE_PORT}..${BASE_PORT + PORT_TRIES - 1}`);
		return;
	}

	// register this window's bridge for tool-side routing
	const reg = loadRegistry();
	pruneDead(reg);
	reg.bridges = (reg.bridges || []).filter((b) => b.pid !== process.pid);
	reg.bridges.push({
		pid: process.pid,
		port,
		folders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
	});
	saveRegistry(reg);
	console.log(`preview-bridge listening on 127.0.0.1:${port}`);

	// net.Server has no dispose(); wrapping keeps reload working — an unclosed
	// listener would keep the exthost event loop alive and leave a zombie process
	context.subscriptions.push({
		dispose: () => {
			server.close();
			try {
				const reg = loadRegistry();
				reg.bridges = (reg.bridges || []).filter((b) => b.pid !== process.pid);
				saveRegistry(reg);
			} catch {
				// registry cleanup is best-effort; stale pids get pruned on next read
			}
		},
	});
}

function deactivate() {}

module.exports = { activate, deactivate };
