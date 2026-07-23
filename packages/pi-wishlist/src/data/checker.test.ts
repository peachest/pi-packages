/* ------------------------------------------------------------------ */
/*  Pi Wishlist — checker tests                                       */
/* ------------------------------------------------------------------ */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// Mock tracker — track calls to verify cooldown behavior
let githubCallCount = 0;

vi.mock("./tracker.ts", () => ({
  fetchNpmData: () => undefined,
  fetchGithubData: () => {
    githubCallCount++;
    return undefined;
  },
  withThrottle: async <T>(fn: () => T) => fn(),
}));

import { vi } from "vitest";

beforeEach(() => {
  githubCallCount = 0;
});

let mockDir: string;

beforeEach(() => {
  mockDir = join(tmpdir(), `pi-wishlist-checker-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(mockDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(mockDir)) rmSync(mockDir, { recursive: true });
  vi.restoreAllMocks();
});

describe("removeInstalledPackages", () => {
  it("removes packages that are in installed packages.json", async () => {
    const { removeInstalledPackages, setCheckerDataDir } = await import("./checker.ts");
    const { addPackage, loadWishlist, setDataDir } = await import("./wishlist.ts");
    setDataDir(mockDir);
    setCheckerDataDir(mockDir);
    addPackage("npm:lodash", "npm:lodash");
    addPackage("npm:react", "npm:react");
    const pkgJsonPath = join(mockDir, "packages.json");
    writeFileSync(pkgJsonPath, JSON.stringify({ lodash: {} }), "utf-8");
    const wl = loadWishlist();
    const removed = removeInstalledPackages(wl, pkgJsonPath);
    expect(removed).toEqual(["npm:lodash"]);
    expect(wl.packages["npm:lodash"]).toBeUndefined();
    expect(wl.packages["npm:react"]).toBeDefined();
  });

  it("returns empty when no packages are installed", async () => {
    const { removeInstalledPackages, setCheckerDataDir } = await import("./checker.ts");
    const { addPackage, loadWishlist, setDataDir } = await import("./wishlist.ts");
    setDataDir(mockDir);
    setCheckerDataDir(mockDir);
    addPackage("npm:lodash", "npm:lodash");
    const pkgJsonPath = join(mockDir, "packages.json");
    writeFileSync(pkgJsonPath, JSON.stringify({}), "utf-8");
    const wl = loadWishlist();
    const removed = removeInstalledPackages(wl, pkgJsonPath);
    expect(removed).toEqual([]);
    expect(wl.packages["npm:lodash"]).toBeDefined();
  });

  it("returns empty when packages.json does not exist", async () => {
    const { removeInstalledPackages, setCheckerDataDir } = await import("./checker.ts");
    const { addPackage, loadWishlist, setDataDir } = await import("./wishlist.ts");
    setDataDir(mockDir);
    setCheckerDataDir(mockDir);
    addPackage("npm:lodash", "npm:lodash");
    const wl = loadWishlist();
    const removed = removeInstalledPackages(wl, join(mockDir, "nonexistent.json"));
    expect(removed).toEqual([]);
  });
});

describe("cooldown", () => {
  it("skips GitHub check when githubCooldownUntil is in the future", async () => {
    const { runDailyCheck, setCheckerDataDir } = await import("./checker.ts");
    const { addPackage, setDataDir, updatePackage } = await import("./wishlist.ts");
    setDataDir(mockDir);
    setCheckerDataDir(mockDir);

    addPackage("npm:lodash", "npm:lodash");
    updatePackage("npm:lodash", {
      githubCooldownUntil: "2099-01-01T00:00:00.000Z",
      sources: { github: { owner: "lodash", repo: "lodash", stars: 100, forks: 10, openIssues: 1, pushedAt: "2025-01-01" } },
    });

    await runDailyCheck();
    // GitHub fetch should NOT have been called due to cooldown
    expect(githubCallCount).toBe(0);
  });

  it("increments githubFailCount on failure and sets cooldown at 3", async () => {
    const { runDailyCheck, setCheckerDataDir } = await import("./checker.ts");
    const { addPackage, setDataDir, getPackage } = await import("./wishlist.ts");
    setDataDir(mockDir);
    setCheckerDataDir(mockDir);

    addPackage("npm:lodash", "npm:lodash");
    const { updatePackage } = await import("./wishlist.ts");
    updatePackage("npm:lodash", {
      sources: { github: { owner: "lodash", repo: "lodash", stars: 100, forks: 10, openIssues: 1, pushedAt: "2025-01-01" } },
    });

    // Run 3 times — mock fetchGithubData returns undefined every time
    for (let i = 0; i < 3; i++) {
      await runDailyCheck();
    }

    const entry = getPackage("npm:lodash")!;
    expect(entry.githubFailCount).toBe(3);
    // Cooldown should be set (a future timestamp)
    expect(entry.githubCooldownUntil).toBeTruthy();
    expect(new Date(entry.githubCooldownUntil).getTime()).toBeGreaterThan(Date.now());
  });

  it("clearAllCooldowns resets all packages", async () => {
    const { clearAllCooldowns, setCheckerDataDir } = await import("./checker.ts");
    const { addPackage, setDataDir, getPackage, updatePackage } = await import("./wishlist.ts");
    setDataDir(mockDir);
    setCheckerDataDir(mockDir);

    addPackage("npm:a", "npm:a");
    updatePackage("npm:a", { githubCooldownUntil: "2099-01-01T00:00:00.000Z", githubFailCount: 3 });
    addPackage("npm:b", "npm:b");
    updatePackage("npm:b", { githubCooldownUntil: "2099-01-01T00:00:00.000Z", githubFailCount: 3 });

    clearAllCooldowns();

    expect(getPackage("npm:a")!.githubFailCount).toBe(0);
    expect(getPackage("npm:a")!.githubCooldownUntil).toBe("");
    expect(getPackage("npm:b")!.githubFailCount).toBe(0);
    expect(getPackage("npm:b")!.githubCooldownUntil).toBe("");
  });

  it("isTodayChecked returns true when check ran today", async () => {
    const { isTodayChecked, saveCheckedDate, setCheckerDataDir } = await import("./checker.ts");
    setCheckerDataDir(mockDir);
    expect(isTodayChecked()).toBe(false);
    saveCheckedDate();
    expect(isTodayChecked()).toBe(true);
  });
});

describe("event dedup + cap", () => {
  it("caps events at 30 and discards oldest 15 on overflow", async () => {
    const trackerModule = await import("./tracker.ts");
    const mockNpm = vi.spyOn(trackerModule, "fetchNpmData");
    mockNpm.mockResolvedValue({ latestVersion: "99.0.0", weeklyDownloads: 1 });

    const { runDailyCheck, setCheckerDataDir } = await import("./checker.ts");
    const { addPackage, setDataDir, updatePackage } = await import("./wishlist.ts");
    setDataDir(mockDir);
    setCheckerDataDir(mockDir);

    addPackage("npm:lodash", "npm:lodash");

    // Pre-fill with 30 events
    const events: any[] = [];
    for (let i = 0; i < 30; i++) {
      events.push({ type: "new_version", from: `${i}.0.0`, to: `${i + 1}.0.0`, at: `2025-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` });
    }
    updatePackage("npm:lodash", { notificationEvents: events } as any);

    // Check once — no change since stored = 99.0.0 and mock returns 99.0.0
    await runDailyCheck();

    // Change mock to produce a new event
    mockNpm.mockResolvedValue({ latestVersion: "100.0.0", weeklyDownloads: 1 });
    await runDailyCheck();

    const { getPackage } = await import("./wishlist.ts");
    const result = getPackage("npm:lodash")!;
    // 31 → cap to 15 (drop 16 oldest)
    expect(result.notificationEvents).toHaveLength(15);
    // Oldest kept should be 16.0.0→17.0.0
    expect(result.notificationEvents[0].from).toBe("16.0.0");
    // Newest should be 99.0.0→100.0.0
    expect(result.notificationEvents[result.notificationEvents.length - 1].to).toBe("100.0.0");

    mockNpm.mockRestore();
  });
});

describe("change detection", () => {
  it("detects new version and produces event", async () => {
    // Override the global mock for this test to return a specific npm version
    const trackerModule = await import("./tracker.ts");
    const mockNpm = vi.spyOn(trackerModule, "fetchNpmData");
    mockNpm.mockResolvedValue({ latestVersion: "2.0.0", weeklyDownloads: 1000 });

    const { runDailyCheck, setCheckerDataDir } = await import("./checker.ts");
    const { addPackage, setDataDir, updatePackage } = await import("./wishlist.ts");
    setDataDir(mockDir);
    setCheckerDataDir(mockDir);

    addPackage("npm:lodash", "npm:lodash");
    updatePackage("npm:lodash", {
      sources: { npm: { latestVersion: "1.0.0", weeklyDownloads: 500 } },
    });

    const results = await runDailyCheck();
    expect(results).toHaveLength(1);
    expect(results[0].newEvents).toHaveLength(1);
    expect(results[0].newEvents[0].type).toBe("new_version");
    expect(results[0].newEvents[0].from).toBe("1.0.0");
    expect(results[0].newEvents[0].to).toBe("2.0.0");

    mockNpm.mockRestore();
  });

  it("produces no events when nothing changed", async () => {
    const trackerModule = await import("./tracker.ts");
    const mockNpm = vi.spyOn(trackerModule, "fetchNpmData");
    mockNpm.mockResolvedValue({ latestVersion: "1.0.0", weeklyDownloads: 500 });

    const { runDailyCheck, setCheckerDataDir } = await import("./checker.ts");
    const { addPackage, setDataDir, updatePackage } = await import("./wishlist.ts");
    setDataDir(mockDir);
    setCheckerDataDir(mockDir);

    addPackage("npm:lodash", "npm:lodash");
    updatePackage("npm:lodash", {
      sources: { npm: { latestVersion: "1.0.0", weeklyDownloads: 500 } },
    });

    const results = await runDailyCheck();
    expect(results).toEqual([]);

    mockNpm.mockRestore();
  });
});