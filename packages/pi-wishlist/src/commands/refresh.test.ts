/* ------------------------------------------------------------------ */
/*  Pi Wishlist — refresh command tests                               */
/* ------------------------------------------------------------------ */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../state/i18n-bridge.ts", () => ({
  t: (_key: string, fallback: string) => fallback,
}));

describe("handleRefresh", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns check results after refresh", async () => {
    const mockResults = [
      { packageKey: "npm:lodash", newEvents: [{ type: "new_version", from: "4.0.0", to: "4.17.21", at: "2025-06-01T00:00:00Z" }] },
    ];

    vi.doMock("../data/checker.ts", () => ({
      clearAllCooldowns: () => {},
      runDailyCheck: async () => mockResults,
    }));

    const { handleRefresh } = await import("./refresh.ts");
    const result = await handleRefresh();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results).toHaveLength(1);
      expect(result.data.results[0].packageKey).toBe("npm:lodash");
    }
  });

  it("returns empty array when no changes", async () => {
    vi.doMock("../data/checker.ts", () => ({
      clearAllCooldowns: () => {},
      runDailyCheck: async () => [],
    }));

    const { handleRefresh } = await import("./refresh.ts");
    const result = await handleRefresh();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results).toHaveLength(0);
    }
  });

  it("handles checker errors gracefully", async () => {
    vi.doMock("../data/checker.ts", () => ({
      clearAllCooldowns: () => {},
      runDailyCheck: async () => { throw new Error("check failed"); },
    }));

    const { handleRefresh } = await import("./refresh.ts");
    const result = await handleRefresh();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });
});