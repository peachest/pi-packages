/* ------------------------------------------------------------------ */
/*  Pi Wishlist — add command tests                                   */
/* ------------------------------------------------------------------ */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../state/i18n-bridge.ts", () => ({
  t: (_key: string, fallback: string) => fallback,
}));

describe("handleAdd", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("adds a package and returns its key", async () => {
    let addedKey = "";
    let addedSource = "";

    vi.doMock("../data/wishlist.ts", () => ({
      getPackage: () => undefined,
      addPackage: (key: string, source: string) => {
        addedKey = key;
        addedSource = source;
      },
      updatePackage: () => {},
    }));

    vi.doMock("../data/tracker.ts", () => ({
      trackPackage: async () => ({ npm: undefined, github: undefined, errors: [] }),
    }));

    const { handleAdd } = await import("./add.ts");
    const result = await handleAdd(["npm:lodash"]);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.addedKey).toBe("npm:lodash");
    }
    expect(addedKey).toBe("npm:lodash");
  });

  it("returns error for duplicate package", async () => {
    vi.doMock("../data/wishlist.ts", () => ({
      getPackage: () => ({ addedAt: "2025-01-01T00:00:00Z" }),
    }));

    const { handleAdd } = await import("./add.ts");
    const result = await handleAdd(["npm:lodash"]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("is already in the wishlist");
    }
  });

  it("normalizes bare package name with npm: prefix", async () => {
    let addedKey = "";

    vi.doMock("../data/wishlist.ts", () => ({
      getPackage: () => undefined,
      addPackage: (key: string) => { addedKey = key; },
      updatePackage: () => {},
    }));

    vi.doMock("../data/tracker.ts", () => ({
      trackPackage: async () => ({ npm: undefined, github: undefined, errors: [] }),
    }));

    const { handleAdd } = await import("./add.ts");
    const result = await handleAdd(["lodash"]);

    expect(result.success).toBe(true);
    expect(addedKey).toBe("npm:lodash");
  });

  it("handles git URLs without prefix normalization", async () => {
    let addedKey = "";

    vi.doMock("../data/wishlist.ts", () => ({
      getPackage: () => undefined,
      addPackage: (key: string) => { addedKey = key; },
      updatePackage: () => {},
    }));

    vi.doMock("../data/tracker.ts", () => ({
      trackPackage: async () => ({ npm: undefined, github: undefined, errors: [] }),
    }));

    const { handleAdd } = await import("./add.ts");
    const result = await handleAdd(["git:github.com/owner/repo"]);

    expect(result.success).toBe(true);
    expect(addedKey).toBe("git:github.com/owner/repo");
  });
});