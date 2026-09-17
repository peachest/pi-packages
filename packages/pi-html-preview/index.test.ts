import { describe, it, expect } from "vitest";
import { buildCommand, chooseBridge } from "./index.js";

const DEAD_PID = 2147483000; // above any pid_max; guaranteed ESRCH

function entry(pid: number, port: number, folders: string[] = []) {
	return { pid, port, folders };
}

describe("buildCommand", () => {
	it("external → externalPreview command with file:// Uri arg", () => {
		const r = buildCommand("/a/b/page.html", "external");
		expect(r.command).toBe("livePreview.start.externalPreview.atFile");
		expect(r.args).toEqual(["file:///a/b/page.html"]);
	});

	it("internal → atFileString with plain path", () => {
		const r = buildCommand("/a/b/page.html", "internal");
		expect(r.command).toBe("livePreview.start.preview.atFileString");
		expect(r.args).toEqual(["/a/b/page.html"]);
	});

	describe("chooseBridge", () => {
		const A = "/home/u/proj-a";
		const B = "/home/u/proj-b";

		it("routes file to the window whose workspace contains it", () => {
			const entries = [entry(process.pid, 39271, [A]), entry(process.pid, 39272, [B])];
			expect(chooseBridge(entries, `${B}/page.html`, A)?.port).toBe(39272);
		});

		it("matches by cwd when the file is a loose file outside any workspace", () => {
			const entries = [entry(process.pid, 39271, [A]), entry(process.pid, 39272, [B])];
			expect(chooseBridge(entries, "/tmp/loose.html", `${B}/sub`)?.port).toBe(39272);
		});

		it("falls back to first alive entry when nothing matches", () => {
			const entries = [entry(process.pid, 39271, [A]), entry(process.pid, 39272, [B])];
			expect(chooseBridge(entries, "/elsewhere/x.html", "/elsewhere")?.port).toBe(39271);
		});

		it("skips dead-pid entries", () => {
			const entries = [entry(DEAD_PID, 39271, [A]), entry(process.pid, 39272, [B])];
			expect(chooseBridge(entries, `${A}/page.html`, A)?.port).toBe(39272);
		});

		it("returns null when no alive entry exists", () => {
			expect(chooseBridge([entry(DEAD_PID, 39271)], "/x.html", "/")).toBeNull();
		});
	});
});
