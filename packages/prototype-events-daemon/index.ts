/**
 * pi-events-daemon — API-shape prototype (wayfinder #19)
 *
 * Validates the decided shapes in one runnable stub, in-process (no socket/SQLite yet):
 *   subscribe / cancel / query / publish / drain / ack  (map #16, #18 resolutions)
 *
 * Decisions encoded here:
 * - Checker contract: shell command, exit 0=pass / 2=fail / other=waiting (creation
 *   convention). Agent-facing surfaces carry ONLY semantic names: verdict "passed" |
 *   "failed" | "waiting" + reason + evidence stdout. No exit codes leak.
 * - Topic = shared fact channel. Checker is ONE feeder among others (publish is another).
 *   Checker sharing per topic: omitted check → reuse; identical check → merge;
 *   different check → rejected (a fact must not be split across two judges).
 * - Delivery: event → per-subscriber inbox rows (write-ahead truth) → wake billboard
 *   (coalesced, count+topic+verdict only, wake mode "followUp"|"steer") → drain (single
 *   fetch path, at-least-once) → ack. Two-stage ack: `accepted` stops hot retries
 *   (prototype: n/a), `verified` = transcript entry confirmed via injected verifier.
 * - Subscriptions are persistent by default; `once` closes after first delivered event;
 *   `ttl` closes at expiry. Fork does not inherit (identity is session-scoped by design).
 */

export type Verdict = "passed" | "failed" | "waiting";

export interface SubscribeParams {
	topic: string;                       // "<domain>:<resource>:<id>:<event>"
	check?: string;                      // shell command; omitted → reuse topic's checker
	interval?: number;                   // seconds between checks, default 5
	ttl?: number;                        // seconds until subscription auto-expires
	once?: boolean;                      // close after first delivered event (wait-once)
	wake?: "followUp" | "steer";         // default "followUp"
	label?: string;                      // human-readable alias for cross-session reference
}

export interface SubscribeResult {
	subscriptionId: string;
	topic: string;
	checker: "new" | "shared" | "reused";
	state: "watching";
	wake: "followUp" | "steer";
}

export interface QueryTopicState {
	topic: string;
	state: "watching" | "closed";
	verdict: Verdict | "never-checked";
	lastCheckedAt: string | null;
	subscribers: number;
	hasChecker: boolean;
	lastEvent?: { eventId: string; verdict: Verdict; occurredAt: string };
}

export interface DrainedEvent {
	notificationId: string;              // deterministic hash(eventId, sessionId) — redelivery dedupe key
	eventId: string;
	topic: string;
	verdict: Verdict;
	reason: string;                      // one-line human explanation
	evidence: string;                    // checker stdout/stderr (agent-facing, no exit codes)
	occurredAt: string;
}

export interface DaemonOptions {
	wake: (billboard: { sessionId: string; count: number; items: Array<{ topic: string; verdict: Verdict }> }) => void;
	/** Two-stage ack stage 2: has the notification entry landed in the session transcript? */
	verifyDelivery: (notificationId: string, sessionId: string) => boolean;
	/** Billboard coalescing window (ms). "passed" wakes hold for the window; "failed" bypass it. Default 0 = immediate. */
	batchMs?: number;
	now?: () => number;
	execCheck?: (check: string) => Promise<{ code: number; output: string }>;
}

interface Subscription {
	id: string;
	sessionId: string;
	topic: string;
	check?: string;
	intervalMs: number;
	ttl?: number;
	once: boolean;
	wake: "followUp" | "steer";
	createdAt: number;
	closed: boolean;
	closedReason?: "once-delivered" | "ttl-expired" | "cancelled";
}

interface Delivery { notificationId: string; sessionId: string; verified: boolean }

interface Event {
	eventId: string;
	topic: string;
	verdict: Verdict;
	reason: string;
	evidence: string;
	occurredAt: number;
	deliveries: Delivery[];
}

function verdictFromCode(code: number): { verdict: Verdict; reason: string } {
	// Creation convention: 0=pass, 2=fail(asserted unreachable), others=waiting.
	if (code === 0) return { verdict: "passed", reason: "checker reported condition met" };
	if (code === 2) return { verdict: "failed", reason: "checker asserted the condition is unreachable" };
	return { verdict: "waiting", reason: `checker not satisfied yet` };
}

export class DaemonStub {
	private subs = new Map<string, Subscription>();
	private checkers = new Map<string, { check: string; lastVerdict: Verdict | "never-checked"; lastOutput: string; lastCheckedAt: number | null }>();
	private events: Event[] = [];
	private seq = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private closedSubs: Subscription[] = [];
	private pendingWakes = new Map<string, { timer: ReturnType<typeof setTimeout>; items: Array<{ topic: string; verdict: Verdict }> }>();

	constructor(private opts: DaemonOptions) {}

	/** Backdoor for tests: seed a topic with a pre-existing checker (simulates daemon restart reload). */
	_seedChecker(topic: string, entry: { check: string; lastVerdict: Verdict | "never-checked"; lastOutput: string; lastCheckedAt: number | null }) {
		this.checkers.set(topic, entry);
	}

	subscribe(sessionId: string, p: SubscribeParams): SubscribeResult {
		const existing = this.checkers.get(p.topic);
		let checker: "new" | "shared" | "reused" | "none";
		if (!p.check && existing) {
			checker = "reused";
		} else if (!p.check) {
			// Pure publish-fed topic: valid subscription, wakes on publish only.
			checker = "none";
		} else if (!existing) {
			this.checkers.set(p.topic, { check: p.check, lastVerdict: "never-checked", lastOutput: "", lastCheckedAt: null });
			checker = "new";
		} else if (existing.check === p.check) {
			checker = "shared";
		} else {
			throw new Error(`topic '${p.topic}' is already judged by a different check — refusing to split one fact across two judges`);
		}
		const id = `sub-${(++this.seq).toString(36).padStart(4, "0")}`;
		this.subs.set(id, {
			id, sessionId, topic: p.topic, check: p.check,
			intervalMs: (p.interval ?? 5) * 1000,
			ttl: p.ttl, once: p.once ?? false, wake: p.wake ?? "followUp",
			createdAt: this.opts.now?.() ?? Date.now(), closed: false,
		});
		this.ensureTicker();
		return { subscriptionId: id, topic: p.topic, checker, state: "watching", wake: p.wake ?? "followUp" };
	}

	cancel(sessionId: string, ids: string[]): { cancelled: number } {
		let n = 0;
		for (const id of ids) {
			const s = this.subs.get(id);
			if (s && s.sessionId === sessionId && !s.closed) { s.closed = true; s.closedReason = "cancelled"; n++; }
		}
		return { cancelled: n };
	}

	query(sessionId?: string): { topics: QueryTopicState[] } {
		const byTopic = new Map<string, Subscription[]>();
		for (const s of this.subs.values()) {
			if (sessionId && s.sessionId !== sessionId) continue;
			const list = byTopic.get(s.topic) ?? [];
			list.push(s); byTopic.set(s.topic, list);
		}
		const topics: QueryTopicState[] = [];
		for (const [topic, subs] of byTopic) {
			const c = this.checkers.get(topic);
			const last = [...this.events].reverse().find((e) => e.topic === topic);
			const open = subs.filter((s) => !s.closed);
			const state = open.length > 0 ? "watching" : "closed";
			topics.push({
				topic, state: state as QueryTopicState["state"],
				verdict: c?.lastVerdict ?? "never-checked",
				lastCheckedAt: c?.lastCheckedAt ? new Date(c.lastCheckedAt).toISOString() : null,
				subscribers: open.length,
				hasChecker: !!c,
				...(last ? { lastEvent: { eventId: last.eventId, verdict: last.verdict, occurredAt: new Date(last.occurredAt).toISOString() } } : {}),
			});
		}
		return { topics };
	}

	publish(sessionId: string, topic: string, payload: unknown): { eventId: string } {
		const eventId = `evt-${(++this.seq).toString(36).padStart(6, "0")}`;
		this.emitEvent({
			eventId, topic, verdict: "passed",
			reason: `published by session ${sessionId}`,
			evidence: JSON.stringify(payload ?? null), occurredAt: this.opts.now?.() ?? Date.now(),
		});
		return { eventId };
	}

	/** Single fetch path. Returns un-verified (pending) events for the session, at-least-once. */
	drain(sessionId: string): { events: DrainedEvent[]; hasMore: boolean } {
		const out: DrainedEvent[] = [];
		for (const e of this.events) {
			for (const d of e.deliveries) {
				if (d.sessionId === sessionId && !d.verified) {
					out.push({
						notificationId: d.notificationId, eventId: e.eventId, topic: e.topic,
						verdict: e.verdict, reason: e.reason, evidence: e.evidence,
						occurredAt: new Date(e.occurredAt).toISOString(),
					});
				}
			}
		}
		return { events: out, hasMore: false };
	}

	/** Ack = stage-2 verification passed (transcript entry present). Un-verified acks are refused. */
	ack(sessionId: string, notificationIds: string[]): { acked: number; refused: number } {
		let acked = 0, refused = 0;
		for (const e of this.events) {
			for (const d of e.deliveries) {
				if (d.sessionId !== sessionId || !notificationIds.includes(d.notificationId)) continue;
				if (this.opts.verifyDelivery(d.notificationId, sessionId)) { d.verified = true; acked++; }
				else refused++;
			}
		}
		return { acked, refused };
	}

	stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

	closedSubscriptions(): Array<{ id: string; reason: string }> {
		return this.closedSubs.map((s) => ({ id: s.id, reason: s.closedReason ?? "unknown" }));
	}

	private ensureTicker() {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), 5);
	}

	private async tick() {
		const now = this.opts.now?.() ?? Date.now();
		for (const s of this.subs.values()) {
			if (s.closed || !s.check) continue;
			if (s.ttl && now - s.createdAt > s.ttl * 1000) { s.closed = true; s.closedReason = "ttl-expired"; this.closedSubs.push(s); continue; }
			if (this.checkers.get(s.topic)?.lastCheckedAt && now - (this.checkers.get(s.topic)!.lastCheckedAt ?? 0) < s.intervalMs) continue;
			const res = await this.opts.execCheck(s.check);
			const { verdict, reason } = verdictFromCode(res.code);
			const c = this.checkers.get(s.topic)!;
			const previous = c.lastVerdict;
			c.lastVerdict = verdict; c.lastOutput = res.output; c.lastCheckedAt = now;
			// Level-trigger evaluation, edge-trigger notification: emit only on verdict
			// transition. A condition that stays true does not re-wake anyone.
			if (verdict === "waiting" || verdict === previous) continue;
			this.emitEvent({
				eventId: `evt-${(++this.seq).toString(36).padStart(6, "0")}`,
				topic: s.topic, verdict, reason, evidence: res.output, occurredAt: now,
			});
		}
	}

	private emitEvent(e: Omit<Event, "deliveries">) {
		const deliveries: Delivery[] = [];
		let wakeBySession = new Map<string, Array<{ topic: string; verdict: Verdict }>>();
		for (const s of this.subs.values()) {
			if (s.closed || s.topic !== e.topic) continue;
			const notificationId = `${e.eventId}/${s.sessionId}`; // deterministic: redelivery dedupe key
			deliveries.push({ notificationId, sessionId: s.sessionId, verified: false });
			const items = wakeBySession.get(s.sessionId) ?? [];
			items.push({ topic: e.topic, verdict: e.verdict });
			wakeBySession.set(s.sessionId, items);
			if (s.once) { s.closed = true; s.closedReason = "once-delivered"; this.closedSubs.push(s); }
		}
		this.events.push({ ...e, deliveries });
		// Billboard: write-ahead is done (delivery rows exist); wake is best-effort.
		// Coalescing window per session — "passed" events hold for batchMs and merge into
		// one billboard; "failed" bypasses the window and wakes immediately (pi-subagents
		// precedent: failures must not wait behind a batching window).
		const batchMs = this.opts.batchMs ?? 0;
		for (const [sessionId, items] of wakeBySession) {
			if (batchMs <= 0 || items.some((i) => i.verdict === "failed")) {
				// Immediate flush; merge any coalescing items so a failed wake carries them along.
				const pending = this.pendingWakes.get(sessionId)?.items ?? [];
				this.flushWake(sessionId, [...pending, ...items]);
				continue;
			}
			const pending = this.pendingWakes.get(sessionId);
			if (pending) { pending.items.push(...items); continue; }
			const entry = { timer: setTimeout(() => this.flushWake(sessionId, entry.items), batchMs), items };
			this.pendingWakes.set(sessionId, entry);
		}
	}

	private flushWake(sessionId: string, items: Array<{ topic: string; verdict: Verdict }>) {
		const pending = this.pendingWakes.get(sessionId);
		if (pending) { clearTimeout(pending.timer); this.pendingWakes.delete(sessionId); }
		if (items.length === 0) return;
		this.opts.wake({ sessionId, count: items.length, items });
	}
}
