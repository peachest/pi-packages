/* ------------------------------------------------------------------ */
/*  Pi Wishlist — stats command tests                                 */
/* ------------------------------------------------------------------ */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../state/i18n-bridge.ts", () => ({
  t: (_key: string, fallback: string) => fallback,
}));

describe("handleStats", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns package stats for existing key", async () => {
    vi.doMock("../data/wishlist.ts", () => ({
      getPackage: () => ({
        addedAt: "2025-01-01T00:00:00Z",
        source: "npm:lodash",
        sources: { npm: { latestVersion: "4.17.21", weeklyDownloads: 1000 } },
        lastChecked: "2025-06-01T00:00:00Z",
        githubFailCount: 0,
        githubCooldownUntil: "",
        notificationEvents: [],
      }),
    }));

    const { handleStats } = await import("./stats.ts");
    const result = await handleStats(["npm:lodash"]);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.key).toBe("npm:lodash");
      expect(result.data.entry).toBeDefined();
    }
  });

  it("returns error for missing key", async () => {
    const { handleStats } = await import("./stats.ts");
    const result = await handleStats([]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("usage");
    }
  });

  it("returns error for non-existent package", async () => {
    vi.doMock("../data/wishlist.ts", () => ({
      getPackage: () => undefined,
    }));

    const { handleStats } = await import("./stats.ts");
    const result = await handleStats(["npm:nonexistent"]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("could not find");
    }
  });
});