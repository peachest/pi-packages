/* ------------------------------------------------------------------ */
/*  Pi Wishlist — search command tests                                */
/* ------------------------------------------------------------------ */

import { describe, it, expect, vi, beforeEach } from "vitest";

describe("handleSearch", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns search results from pi package registry", async () => {
    const mockResults = [
      { name: "lodash", version: "4.17.21", description: "Lodash modular utilities." },
    ];

    vi.doMock("../data/search.ts", () => ({
      searchPiPackages: async () => mockResults,
    }));

    const { handleSearch } = await import("./search.ts");
    const result = await handleSearch("lodash");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe("lodash");
    }
  });

  it("returns empty array when no results", async () => {
    vi.doMock("../data/search.ts", () => ({
      searchPiPackages: async () => [],
    }));

    const { handleSearch } = await import("./search.ts");
    const result = await handleSearch("nonexistent");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(0);
    }
  });
});