/* ------------------------------------------------------------------ */
/*  Pi Wishlist — remove command tests                                */
/* ------------------------------------------------------------------ */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../state/i18n-bridge.ts", () => ({
  t: (_key: string, fallback: string) => fallback,
}));

describe("handleRemove", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("removes a package by key", async () => {
    let removedKey = "";

    vi.doMock("../data/wishlist.ts", () => ({
      listPackages: () => [{ key: "npm:lodash", entry: {} }],
      getPackage: () => ({ addedAt: "2025-01-01T00:00:00Z" }),
      removePackage: (key: string) => {
        removedKey = key;
        return true;
      },
    }));

    const { handleRemove } = await import("./remove.ts");
    const result = await handleRemove(["npm:lodash"]);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.removedKey).toBe("npm:lodash");
    }
    expect(removedKey).toBe("npm:lodash");
  });

  it("supports removal by index number", async () => {
    let removedKey = "";

    vi.doMock("../data/wishlist.ts", () => ({
      listPackages: () => [{ key: "npm:lodash", entry: {} }, { key: "npm:react", entry: {} }],
      getPackage: (key: string) => key === "npm:lodash" ? { addedAt: "2025-01-01T00:00:00Z" } as any : undefined,
      removePackage: (key: string) => {
        removedKey = key;
        return true;
      },
    }));

    const { handleRemove } = await import("./remove.ts");
    const result = await handleRemove(["1"]);

    expect(result.success).toBe(true);
    expect(removedKey).toBe("npm:lodash");
  });

  it("returns error when package not found", async () => {
    vi.doMock("../data/wishlist.ts", () => ({
      listPackages: () => [],
      getPackage: () => undefined,
      removePackage: () => false,
    }));

    const { handleRemove } = await import("./remove.ts");
    const result = await handleRemove(["npm:nonexistent"]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not in the wishlist");
    }
  });

  it("returns error for missing target argument", async () => {
    const { handleRemove } = await import("./remove.ts");
    const result = await handleRemove([]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("usage");
    }
  });
});