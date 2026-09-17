// Socket-level protocol tests for the preview-bridge vscode extension.
//
// The extension can't be required inside vscode from a test runner, but its
// whole interface is a plain TCP protocol — so we load extension.js with a
// stubbed `vscode` module and drive the real server over loopback. This is
// the in-repo version of the ad-hoc harness that diagnosed the
// write-after-end reply loss and the zombie-exthost registry bug.
//
// Run: node --test vscode-bridge/protocol.test.mjs (wired into npm test)
import Module from "node:module";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const registryFile = path.join(os.tmpdir(), `preview-bridge-test-${process.pid}.json`);

// stub the vscode API before loading the extension
const executed = [];
const vscodeStub = {
	commands: {
		executeCommand: async (cmd, ...args) => {
			executed.push([cmd, ...args]);
		},
	},
	workspace: { workspaceFolders: [{ uri: { fsPath: "/tmp/sim-ws" } }] },
	window: { showErrorMessage: () => {} },
	// mimic vscode.Uri.parse enough for the promotion path to be observable
	Uri: { parse: (s) => ({ fsPath: new URL(s).pathname }) },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === "vscode") return vscodeStub;
	return origLoad.call(this, request, parent, isMain);
};
process.env.PREVIEW_BRIDGE_TEST_REGISTRY = registryFile;

const requireBridge = Module.createRequire(path.join(here, "hyx-preview-bridge-0.0.1", "package.json"));
const ext = requireBridge("./extension.js");

const context = { subscriptions: [] };
let port;

before(async () => {
	await ext.activate(context);
	assert.ok(fs.existsSync(registryFile), "activate did not write registry — likely no free port in probe range");
	const reg = JSON.parse(fs.readFileSync(registryFile, "utf8"));
	const me = reg.bridges.find((b) => b.pid === process.pid);
	assert.ok(me, "own bridge entry present");
	port = me.port;
});

after(() => {
	try {
		context.subscriptions.forEach((d) => d.dispose());
		if (fs.existsSync(registryFile)) {
			const remaining = JSON.parse(fs.readFileSync(registryFile, "utf8"));
			assert.ok(
				!remaining.bridges.some((b) => b.pid === process.pid),
				"registry entry removed after dispose"
			);
		}
	} finally {
		fs.rmSync(registryFile, { force: true });
		Module._load = origLoad;
	}
});

// one request per connection; half-close (end) then await the reply —
// this exact flow is the write-after-end regression guard
function send(payload) {
	return new Promise((resolve) => {
		const s = net.connect(port, "127.0.0.1");
		let raw = "";
		s.on("error", (e) => resolve({ error: e.code || String(e), raw }));
		s.on("data", (d) => (raw += d));
		s.on("connect", () => s.end(typeof payload === "string" ? payload : JSON.stringify(payload)));
		s.on("close", () => resolve({ raw }));
	});
}

test("loads the shared protocol contract verbatim (no hand-copied constants)", () => {
	const file = JSON.parse(fs.readFileSync(path.join(here, "hyx-preview-bridge-0.0.1", "protocol.json"), "utf8"));
	assert.deepEqual(ext.protocol, file);
});

test("registers itself in the registry with workspace folders and a probed port", () => {
	const reg = JSON.parse(fs.readFileSync(registryFile, "utf8"));
	const me = reg.bridges.find((b) => b.pid === process.pid);
	assert.ok(me, "own entry present");
	assert.ok(me.port >= 39271 && me.port < 39281, `port ${me.port} inside probe range`);
	assert.deepEqual(me.folders, ["/tmp/sim-ws"]);
});

test("executes whitelisted command and replies ok over half-close", async () => {
	const before = executed.length;
	const res = await send({ command: "livePreview.end", args: [] });
	assert.equal(res.raw, JSON.stringify({ ok: true }));
	assert.equal(executed.length, before + 1);
	assert.equal(executed.at(-1)[0], "livePreview.end");
});

test("rejects non-whitelisted and lookalike commands without executing", async () => {
	const before = executed.length;
	for (const cmd of ["workbench.action.terminal.new", "livePreviewX.evil"]) {
		const res = await send({ command: cmd, args: [] });
		const reply = JSON.parse(res.raw);
		assert.equal(reply.ok, false);
		assert.match(reply.error, /not allowed/);
	}
	assert.equal(executed.length, before, "nothing executed");
});

test("promotes file:// string args to vscode.Uri for external preview", async () => {
	await send({ command: "livePreview.start.externalPreview.atFile", args: ["file:///tmp/x.html"] });
	assert.equal(executed.at(-1)[0], "livePreview.start.externalPreview.atFile");
	assert.equal(executed.at(-1)[1].fsPath, "/tmp/x.html");
});

test("destroys oversized requests without an ok reply", async () => {
	const big = JSON.stringify({ command: "livePreview.end", args: ["x".repeat(1.2e6)] });
	const res = await send(big);
	const reply = res.raw ? (() => { try { return JSON.parse(res.raw); } catch { return null; } })() : null;
	assert.ok(!reply?.ok, "no ok reply for oversized request");
});
