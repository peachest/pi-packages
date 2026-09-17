import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { DaemonStub, type DrainedEvent } from "./index.ts";

const fakeExec = (script: Array<{ match: RegExp; code: number; out?: string }>) =>
	(check: string) => {
		const rule = script.find((r) => r.match.test(check));
		return Promise.resolve({ code: rule?.code ?? 1, output: rule?.out ?? "" });
	};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("pi-events-daemon API shape", () => {
	it("edge-trigger: a condition that stays true emits exactly one event, not one per tick", async () => {
		const wakes: Array<{ sessionId: string; count: number; items: unknown[] }> = [];
		const transcript = new Set<string>();
		const d = new DaemonStub({
			wake: (b) => wakes.push(b),
			verifyDelivery: (nid) => (transcript.has(nid) ? true : false),
			execCheck: fakeExec([{ match: /health/, code: 0, out: "HTTP 200 OK" }]),
		});
		const sub = d.subscribe("sess-A", { topic: "sglang:instance:h22:ready", check: "curl -sf http://x/health", interval: 0.005 });
		expect(sub.checker).toBe("new");
		await sleep(80); // many ticks while the condition holds

		expect(wakes.length).toBe(1); // edge, not level
		const first = d.drain("sess-A");
		expect(first.events.length).toBe(1);
		const e = first.events[0];
		expect(e.verdict).toBe("passed");
		expect(e.evidence).toBe("HTTP 200 OK");
		expect(Object.keys(e)).not.toContain("exitCode");

		// Stage-1 ack without transcript entry → refused (verified=false).
		const refused = d.ack("sess-A", [e.notificationId]);
		expect(refused).toEqual({ acked: 0, refused: 1 });

		// At-least-once: un-verified event is returned again by drain.
		expect(d.drain("sess-A").events.map((x: DrainedEvent) => x.notificationId)).toEqual([e.notificationId]);

		// Simulate the extension writing the notification into the session file, then ack.
		transcript.add(e.notificationId);
		expect(d.ack("sess-A", [e.notificationId])).toEqual({ acked: 1, refused: 0 });

		// Verified → gone from drain (no duplicate wake of the same fact).
		expect(d.drain("sess-A").events.length).toBe(0);
		d.stop();
	});

	it("checker sharing: reuse, merge, and refuse-to-split", async () => {
		const d = new DaemonStub({ wake: () => {}, verifyDelivery: () => true, execCheck: async () => ({ code: 1, output: "" }) });
		const a = d.subscribe("A", { topic: "gitlab:mr:24248-58:merged", check: "glab api …", interval: 0.005 });
		const b = d.subscribe("B", { topic: "gitlab:mr:24248-58:merged" }); // no check → reuse
		expect(a.checker).toBe("new");
		expect(b.checker).toBe("reused");
		const c = d.subscribe("C", { topic: "gitlab:mr:24248-58:merged", check: "glab api …", interval: 0.005 });
		expect(c.checker).toBe("shared");
		expect(() => d.subscribe("D", { topic: "gitlab:mr:24248-58:merged", check: "different command" }))
			.toThrow(/refusing to split/);
		// Query shows one fact, two open subscribers (A, B, C — same topic counted once per subscriber).
		const q = d.query();
		expect(q.topics[0].subscribers).toBe(3);
		expect(q.topics[0].hasChecker).toBe(true);
		d.stop();
	});

	it("fail-fast: exit-2 check emits a failed event immediately (no timeout wait)", async () => {
		const wakes: Array<{ items: Array<{ verdict: string }> }> = [];
		const d = new DaemonStub({ wake: (b) => wakes.push(b as never), verifyDelivery: () => true, execCheck: fakeExec([{ match: /phase/, code: 2, out: "INSTANCE FAILED: ImagePullBackOff" }]) });
		d.subscribe("A", { topic: "k8s:instance:glm51:ready", check: "kubectl get modelinstance glm51 -o jsonpath='{.status.phase}'", interval: 0.005, wake: "steer" });
		await sleep(60);
		expect(wakes[0].items[0].verdict).toBe("failed");
		const e = d.drain("A").events[0];
		expect(e.verdict).toBe("failed");
		expect(e.reason).toContain("unreachable");
		expect(e.evidence).toContain("ImagePullBackOff");
		d.stop();
	});

	it("waiting: exit-1 polls keep polling and produce no event", async () => {
		const wakes: unknown[] = [];
		const d = new DaemonStub({ wake: () => wakes.push(0), verifyDelivery: () => true, execCheck: fakeExec([{ match: /health/, code: 1 }]) });
		d.subscribe("A", { topic: "x:ready", check: "curl -sf …/health", interval: 0.005 });
		await sleep(80);
		expect(wakes.length).toBe(0);
		const q = d.query("A");
		expect(q.topics[0].verdict).toBe("waiting");
		expect(q.topics[0].state).toBe("watching");
		d.stop();
	});

	it("publish feeds a topic; check-less subscribe waits on publish; once closes after delivery", async () => {
		const d = new DaemonStub({ wake: () => {}, verifyDelivery: () => true, execCheck: async () => ({ code: 1, output: "" }) });
		// Pure publish-fed topic: check-less subscribe is valid and just waits for publishes.
		const s = d.subscribe("B", { topic: "custom:corpus:job-42:done", once: true });
		expect(s.checker).toBe("none");
		expect(d.query("B").topics[0].verdict).toBe("never-checked");
		d.publish("C", "custom:corpus:job-42:done", { done: true, rows: 128000 });
		const drained = d.drain("B").events;
		expect(drained.length).toBe(1);
		expect(drained[0].verdict).toBe("passed");
		expect(drained[0].evidence).toContain("128000");
		d.ack("B", [drained[0].notificationId]);
		await sleep(10);
		expect(d.closedSubscriptions()).toEqual([{ id: s.subscriptionId, reason: "once-delivered" }]);
		d.stop();
	});

	it("batch window: passed events coalesce into one billboard; failed bypasses immediately", async () => {
		const wakes: Array<{ sessionId: string; count: number; items: Array<{ topic: string; verdict: string }> }> = [];
		const d = new DaemonStub({
			wake: (b) => wakes.push(b),
			verifyDelivery: () => true,
			batchMs: 80,
			execCheck: fakeExec([{ match: /health/, code: 0, out: "ok" }]),
		});
		// Two publish-fed subscriptions for session A, both events land inside the window.
		d.subscribe("A", { topic: "custom:job1:done" });
		d.subscribe("A", { topic: "custom:job2:done" });
		d.publish("C", "custom:job1:done", { ok: 1 });
		d.publish("C", "custom:job2:done", { ok: 2 });
		expect(wakes.length).toBe(0); // holding…
		await sleep(120);
		expect(wakes.length).toBe(1); // coalesced into one billboard
		expect(wakes[0].count).toBe(2);

		// Failed event bypasses the window: immediate wake carrying coalesced items along.
		const d2 = new DaemonStub({
			wake: (b) => wakes.push(b),
			verifyDelivery: () => true,
			batchMs: 10_000,
			execCheck: fakeExec([{ match: /modelinstance/, code: 2, out: "INSTANCE FAILED" }]),
		});
		d2.subscribe("A", { topic: "sglang:i:slow:ready", check: "echo phase-check" });
		d2.subscribe("A", { topic: "custom:other:done" }); // publish-fed, sits in the 10s window
		d2.publish("C", "custom:other:done", { n: 1 });
		await sleep(20);
		d2.subscribe("A", { topic: "k8s:i:dead:ready", check: "kubectl get modelinstance -o jsonpath='{.status.phase}'", interval: 0.005, wake: "steer" });
		await sleep(60);
		const last = wakes[wakes.length - 1];
		expect(last.count).toBe(2); // failed + the coalesced publish, flushed together now
		expect(last.items.some((i) => i.verdict === "failed")).toBe(true);
		d.stop(); d2.stop();
	});

	it("evidence over 2KB is truncated to a pointer; full text fetchable on demand", async () => {
		const big = "x".repeat(3000) + " INNER-DETAIL-MARKER";
		const d = new DaemonStub({ wake: () => {}, verifyDelivery: () => true, execCheck: fakeExec([{ match: /build/, code: 0, out: big }]) });
		d.subscribe("A", { topic: "custom:build:job:done", check: "run build", interval: 0.005 });
		await sleep(60);
		const e = d.drain("A").events[0];
		expect(e.evidence.length).toBe(2000);
		expect(e.evidenceTruncated).toBe(true);
		expect(e.evidenceRef).toBe(e.notificationId);
		expect(d.evidence(e.notificationId)!.evidence).toContain("INNER-DETAIL-MARKER");
		// small evidence: inline as-is, no pointer noise
		const d2 = new DaemonStub({ wake: () => {}, verifyDelivery: () => true, execCheck: fakeExec([{ match: /ok/, code: 0, out: "fine" }]) });
		d2.subscribe("A", { topic: "custom:t:done", check: "check ok", interval: 0.005 });
		await sleep(40);
		const e2 = d2.drain("A").events[0];
		expect(e2.evidence).toBe("fine");
		expect(e2.evidenceTruncated).toBeUndefined();
		d.stop(); d2.stop();
	});

	it("real shell check runs (end-to-end smoke with actual exec)", async () => {
		const execCheck = (check: string) => new Promise<{ code: number; output: string }>((resolve) => {
			execFile("/bin/sh", ["-c", check], { timeout: 5000 }, (err, stdout, stderr) => {
				const code = err && typeof (err as NodeJS.ErrnoException).code === "number" ? (err as unknown as { code: number }).code : err ? 1 : 0;
				resolve({ code, output: `${stdout}${stderr}`.slice(0, 2000) });
			});
		});
		const d = new DaemonStub({ wake: () => {}, verifyDelivery: () => true, execCheck });
		d.subscribe("A", { topic: "file:marker:appeared", check: "test -f /tmp/pi-events-proto-marker", interval: 0.01 });
		await sleep(30);
		expect(d.query("A").topics[0].verdict).toBe("waiting");
		const { execFileSync } = await import("node:child_process");
		execFileSync("/bin/touch", ["/tmp/pi-events-proto-marker"]);
		await sleep(60);
		const e = d.drain("A").events[0];
		expect(e.verdict).toBe("passed");
		d.ack("A", [e.notificationId]);
		execFileSync("rm", ["-f", "/tmp/pi-events-proto-marker"]);
		d.stop();
	});
});
