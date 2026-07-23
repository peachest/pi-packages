/* ------------------------------------------------------------------ */
/*  Format utilities tests                                            */
/* ------------------------------------------------------------------ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../state/i18n-bridge.ts", () => ({
  t: (_key: string, fallback: string) => fallback,
  i18nAvailable: false,
  i18nInitDone: false,
  I18N_NAMESPACE: "pi-wishlist",
}));

import { highlightMatch, getStatusIcon, formatDetail } from "./format.ts";

describe("getStatusIcon", () => {
  const baseEntry = () => ({
    addedAt: "2026-01-01T00:00:00.000Z",
    source: "npm:test" as const,
    sources: {
      npm: { latestVersion: "1.0.0", weeklyDownloads: 5000 },
      github: { owner: "test" as const, repo: "test" as const, stars: 100, forks: 10, openIssues: 2, pushedAt: new Date().toISOString() },
    },
    lastChecked: "2026-06-01T00:00:00.000Z",
    githubFailCount: 0,
    githubCooldownUntil: "",
    notificationEvents: [] as Array<{ type: string; from?: string; to: string; at: string }>,
  });

  it("returns ✅ for stable entry with no events and recent push", () => {
    expect(getStatusIcon(baseEntry() as any)).toBe("✅");
  });

  it("returns 🆕 when latest event is new_version within 7 days", () => {
    const entry = baseEntry();
    entry.notificationEvents.push({
      type: "new_version", from: "1.0.0", to: "2.0.0",
      at: new Date(Date.now() - 86400_000).toISOString(), // 1 day ago
    });
    expect(getStatusIcon(entry as any)).toBe("🆕");
  });

  it("returns ✅ when latest event is older than 30 days", () => {
    const entry = baseEntry();
    entry.notificationEvents.push({
      type: "new_version", from: "1.0.0", to: "2.0.0",
      at: "2025-01-01T00:00:00.000Z", // over a year ago
    });
    expect(getStatusIcon(entry as any)).toBe("✅");
  });

  it("returns 💤 when repo pushedAt is > 90 days ago", () => {
    const entry = baseEntry();
    entry.sources.github!.pushedAt = new Date(Date.now() - 100 * 86400_000).toISOString();
    expect(getStatusIcon(entry as any)).toBe("💤");
  });

  it("returns ✅ when no github data available (non-github package)", () => {
    const entry = baseEntry();
    (entry.sources as Record<string, unknown>).github = undefined;
    expect(getStatusIcon(entry as any)).toBe("✅");
  });

  it("returns ⚠️ when githubFailCount >= 3", () => {
    const entry = baseEntry();
    entry.githubFailCount = 3;
    expect(getStatusIcon(entry as any)).toBe("⚠️");
  });

  it("returns 🆕 over ⚠️ when new_version is more recent", () => {
    const entry = baseEntry();
    entry.githubFailCount = 3;
    entry.notificationEvents.push({
      type: "new_version", from: "1.0.0", to: "2.0.0",
      at: new Date(Date.now() - 86400_000).toISOString(), // 1 day ago
    });
    expect(getStatusIcon(entry as any)).toBe("🆕");
  });
});

describe("highlightMatch", () => {
  it("returns same string when query is empty", () => {
    expect(highlightMatch("hello world", "")).toBe("hello world");
  });

  it("wraps match with ** markers", () => {
    expect(highlightMatch("hello world", "world")).toBe("hello **world**");
  });

  it("is case-insensitive", () => {
    expect(highlightMatch(/**/ "Hello World", "hello")).toBe("**Hello** World");
  });

  it("highlights only first occurrence", () => {
    // ponytail: first-match only, full-match if perf matters later
    expect(highlightMatch("foo foo foo", "foo")).toBe("**foo** foo foo");
  });

  it("handles no match", () => {
    expect(highlightMatch("hello world", "xyz")).toBe("hello world");
  });
});

describe("formatDetail — snapshot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-23T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const npmOnly = {
    addedAt: "2026-03-15T10:00:00.000Z",
    notes: "",
    source: "npm:pi-marketplace",
    sources: {
      npm: { latestVersion: "0.8.0", weeklyDownloads: 15000 },
    },
    lastChecked: "2026-06-22T00:00:00.000Z",
    notificationEvents: [],
  };

  const fullEntry = {
    addedAt: "2026-01-01T00:00:00.000Z",
    notes: "需要等待 v2 正式版",
    source: "npm:pi-subagents",
    sources: {
      npm: { latestVersion: "1.2.0", weeklyDownloads: 1234567 },
      github: { owner: "test", repo: "pi-subagents", stars: 250, forks: 45, openIssues: 3, pushedAt: "2026-06-20T00:00:00.000Z" },
    },
    lastChecked: "2026-06-22T00:00:00.000Z",
    notificationEvents: [
      { type: "new_version", from: "1.1.0", to: "1.2.0", at: "2026-06-21T00:00:00.000Z" },
    ],
  };

  const staleGitHubEntry = {
    addedAt: "2025-06-01T00:00:00.000Z",
    notes: "",
    source: "npm:old-repo",
    sources: {
      npm: { latestVersion: "0.1.0", weeklyDownloads: 500 },
      github: { owner: "stale", repo: "old-repo", stars: 10, forks: 2, openIssues: 0, pushedAt: "2025-01-01T00:00:00.000Z" },
    },
    lastChecked: "2026-06-01T00:00:00.000Z",
    githubFailCount: 3,
    githubCooldownUntil: "",
    notificationEvents: [
      { type: "stars_changed", from: "5", to: "10", at: "2025-12-01T00:00:00.000Z" },
    ],
  };

  it("matches snapshot: npm-only entry", () => {
    expect(formatDetail("npm:pi-marketplace", npmOnly as any)).toMatchSnapshot();
  });

  it("matches snapshot: full entry with npm + github + notes + recent event", () => {
    expect(formatDetail("npm:pi-subagents", fullEntry as any)).toMatchSnapshot();
  });

  it("matches snapshot: stale GitHub with old event", () => {
    expect(formatDetail("npm:old-repo", staleGitHubEntry as any)).toMatchSnapshot();
  });
});