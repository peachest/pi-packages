/* ------------------------------------------------------------------ */
/*  Pi Wishlist — npm registry search tests                           */
/* ------------------------------------------------------------------ */

import { describe, it, expect, vi, beforeEach } from "vitest";

describe("searchPiPackages", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns results from npm registry", async () => {
    const mockJson = {
      objects: [
        {
          package: {
            name: "pi-subagents",
            version: "1.0.0",
            description: "Subagent management for pi",
          },
        },
        {
          package: {
            name: "pi-marketplace",
            version: "0.2.0",
            description: "",
          },
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockJson),
    });

    const { searchPiPackages } = await import("./search.ts");
    const results = await searchPiPackages("subagents");

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe("pi-subagents");
    expect(results[0].version).toBe("1.0.0");
    expect(results[0].description).toBe("Subagent management for pi");
    expect(results[1].name).toBe("pi-marketplace");
    // empty description stays empty string
    expect(results[1].description).toBe("");
  });

  it("returns empty array on HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const { searchPiPackages } = await import("./search.ts");
    const results = await searchPiPackages("anything");
    expect(results).toEqual([]);
  });

  it("returns empty array on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const { searchPiPackages } = await import("./search.ts");
    const results = await searchPiPackages("anything");
    expect(results).toEqual([]);
  });

  it("returns empty array on empty response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ objects: [] }),
    });

    const { searchPiPackages } = await import("./search.ts");
    const results = await searchPiPackages("nonexistent");
    expect(results).toEqual([]);
  });

  it("includes keywords:pi-package filter in URL", async () => {
    let capturedUrl = "";
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ objects: [] }),
      });
    });

    const { searchPiPackages } = await import("./search.ts");
    await searchPiPackages("test-query");
    expect(capturedUrl).toContain("keywords:pi-package");
    expect(capturedUrl).toContain("test-query");
    expect(capturedUrl).toContain("size=20");
  });

  it("encodes special characters in query", async () => {
    let capturedUrl = "";
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ objects: [] }),
      });
    });

    const { searchPiPackages } = await import("./search.ts");
    await searchPiPackages("@scope/pkg");
    expect(capturedUrl).toContain(encodeURIComponent("@scope/pkg"));
  });
});