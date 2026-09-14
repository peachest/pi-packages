import { describe, it, expect, vi } from "vitest";

// The module snapshots HERDR_SOCKET_PATH / HERDR_TAB_ID at load time, so set
// them before the dynamic import inside each test (module cache is reset by
// vi.resetModules between cases).
async function loadExtension() {
	vi.resetModules();
	process.env.HERDR_ENV = "1";
	process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
	process.env.HERDR_TAB_ID = "w1:t1";
	const mod = await import("./index.ts");
	return mod;
}

type SessionInfoChangedHandler = (
	event: { type: "session_info_changed"; name: string | undefined },
	ctx: { mode: string } | undefined,
) => void;

function createFakePi() {
	const handlers = new Map<string, SessionInfoChangedHandler>();
	return {
		on: (event: string, handler: SessionInfoChangedHandler) => handlers.set(event, handler),
		emit: (ev: Parameters<SessionInfoChangedHandler>[0], ctx?: Parameters<SessionInfoChangedHandler>[1]) =>
			handlers.get("session_info_changed")?.(ev, ctx),
	};
}

describe("pi-herdr-tab-rename", () => {
	it("forwards a tui session rename to herdr", async () => {
		const { herdrTabRename } = await loadExtension();
		const pi = createFakePi();
		const sent: string[] = [];
		herdrTabRename(pi as any, (label) => (sent.push(label), true));

		pi.emit({ type: "session_info_changed", name: "Fix auth bug" }, { mode: "tui" });
		expect(sent).toEqual(["Fix auth bug"]);
	});

	it("ignores non-tui sessions (bg subagents) and cleared names", async () => {
		const { herdrTabRename } = await loadExtension();
		const pi = createFakePi();
		const sent: string[] = [];
		herdrTabRename(pi as any, (label) => (sent.push(label), true));

		pi.emit({ type: "session_info_changed", name: "subagent work" }, { mode: "json" });
		pi.emit({ type: "session_info_changed", name: undefined }, { mode: "tui" });
		pi.emit({ type: "session_info_changed", name: "  " }, { mode: "tui" });
		expect(sent).toEqual([]);
	});

	it("skips duplicate consecutive names", async () => {
		const { herdrTabRename } = await loadExtension();
		const pi = createFakePi();
		const sent: string[] = [];
		herdrTabRename(pi as any, (label) => (sent.push(label), true));

		pi.emit({ type: "session_info_changed", name: "Same" }, { mode: "tui" });
		pi.emit({ type: "session_info_changed", name: "Same" }, { mode: "tui" });
		pi.emit({ type: "session_info_changed", name: "New" }, { mode: "tui" });
		expect(sent).toEqual(["Same", "New"]);
	});

	it("is a no-op outside herdr", async () => {
		vi.resetModules();
		delete process.env.HERDR_ENV;
		const { herdrTabRename } = await import("./index.ts");
		const pi = createFakePi();
		herdrTabRename(pi as any, (label) => {
			throw new Error(`should not send: ${label}`);
		});
		pi.emit({ type: "session_info_changed", name: "x" }, { mode: "tui" });
	});
});
