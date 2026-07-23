/* ------------------------------------------------------------------ */
/*  Pi Wishlist — commands tests                                      */
/* ------------------------------------------------------------------ */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WishlistEntry } from "../data/types.ts";

// ── list command ───────────────────────────────────────────────

describe("handleList", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns package list from wishlist data", async () => {
    const mockPackages = [
      { key: "npm:lodash", entry: { addedAt: "2025-01-01T00:00:00Z", source: "npm:lodash", sources: { npm: { latestVersion: "4.17.21", weeklyDownloads: 1000 } }, lastChecked: "2025-06-01T00:00:00Z", githubFailCount: 0, githubCooldownUntil: "", notificationEvents: [] } },
    ] as Array<{ key: string; entry: WishlistEntry }>;

    vi.doMock("../data/wishlist.ts", () => ({
      listPackages: () => mockPackages,
    }));

    const { handleList } = await import("./list.ts");
    const result = await handleList([]);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].key).toBe("npm:lodash");
    }
  });

  it("returns empty array when wishlist is empty", async () => {
    vi.doMock("../data/wishlist.ts", () => ({
      listPackages: () => [],
    }));

    const { handleList } = await import("./list.ts");
    const result = await handleList([]);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(0);
    }
  });
});