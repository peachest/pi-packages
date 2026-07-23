/* ------------------------------------------------------------------ */
/*  Pi Wishlist — wishlist CRUD tests                                 */
/* ------------------------------------------------------------------ */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

let mockDir: string;

beforeEach(() => {
  mockDir = join(tmpdir(), `pi-wishlist-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(mockDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(mockDir)) rmSync(mockDir, { recursive: true });
});

describe("loadWishlist", () => {
  it("returns default wishlist when file does not exist", async () => {
    const { loadWishlist, setDataDir } = await import("./wishlist.ts");
    setDataDir(mockDir);
    const wl = loadWishlist();
    expect(wl.settings).toEqual({ notifications: true });
    expect(wl.packages).toEqual({});
  });

  it("loads existing wishlist from file", async () => {
    const { loadWishlist, setDataDir, saveWishlist } = await import("./wishlist.ts");
    setDataDir(mockDir);
    const data = { version: 1 as const, settings: { notifications: true }, packages: {} };
    saveWishlist(data);
    const wl = loadWishlist();
    expect(wl).toEqual(data);
  });

  it("returns default on corrupt file", async () => {
    const { loadWishlist, setDataDir } = await import("./wishlist.ts");
    setDataDir(mockDir);
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    writeFileSync(join(mockDir, "wishlist.json"), "not-json", "utf-8");
    const wl = loadWishlist();
    expect(wl.settings).toEqual({ notifications: true });
  });
});

describe("saveWishlist", () => {
  it("writes valid JSON that can be loaded back", async () => {
    const { saveWishlist, loadWishlist, setDataDir } = await import("./wishlist.ts");
    setDataDir(mockDir);
    const data = {
      version: 1 as const,
      settings: { notifications: true } as const,
      packages: {
        "npm:lodash": {
          addedAt: "2025-01-01",
          source: "npm:lodash",
          sources: {},
          lastChecked: "2025-01-01",
          githubFailCount: 0,
          githubCooldownUntil: "",
          notificationEvents: [],
        },
      },
    };
    saveWishlist(data);
    const loaded = loadWishlist();
    expect(loaded).toEqual(data);
  });

  it("uses atomic write (tmp file then rename)", async () => {
    const { saveWishlist, loadWishlist, setDataDir } = await import("./wishlist.ts");
    const { readdirSync } = await import("node:fs");
    setDataDir(mockDir);
    saveWishlist({ version: 1 as const, settings: { notifications: true }, packages: {} });
    // No .tmp files should remain
    const files = readdirSync(mockDir).filter((f) => f.endsWith(".tmp"));
    expect(files).toEqual([]);
    // Final file should be wishlist.json
    expect(readdirSync(mockDir)).toContain("wishlist.json");
  });
});

describe("addPackage", () => {
  it("adds a package and persists it", async () => {
    const { addPackage, getPackage, setDataDir } = await import("./wishlist.ts");
    setDataDir(mockDir);
    addPackage("npm:lodash", "npm:lodash", "useful");
    const entry = getPackage("npm:lodash");
    expect(entry).toBeDefined();
    expect(entry!.notes).toBe("useful");
    expect(entry!.source).toBe("npm:lodash");
    expect(entry!.notificationEvents).toEqual([]);
  });
});

describe("removePackage", () => {
  it("removes an existing package and returns true", async () => {
    const { addPackage, removePackage, getPackage, setDataDir } = await import("./wishlist.ts");
    setDataDir(mockDir);
    addPackage("npm:lodash", "npm:lodash");
    const removed = removePackage("npm:lodash");
    expect(removed).toBe(true);
    expect(getPackage("npm:lodash")).toBeUndefined();
  });

  it("returns false for non-existent package", async () => {
    const { removePackage, setDataDir } = await import("./wishlist.ts");
    setDataDir(mockDir);
    expect(removePackage("npm:nonexistent")).toBe(false);
  });
});

describe("listPackages", () => {
  it("returns all packages", async () => {
    const { addPackage, listPackages, setDataDir } = await import("./wishlist.ts");
    setDataDir(mockDir);
    addPackage("npm:a", "npm:a");
    addPackage("npm:b", "npm:b");
    const list = listPackages();
    expect(list).toHaveLength(2);
    expect(list.map((x) => x.key)).toEqual(["npm:a", "npm:b"]);
  });

  it("returns empty array when no packages", async () => {
    const { listPackages, setDataDir } = await import("./wishlist.ts");
    setDataDir(mockDir);
    expect(listPackages()).toEqual([]);
  });
});

describe("updatePackage", () => {
  it("updates existing package fields", async () => {
    const { addPackage, getPackage, updatePackage, setDataDir } = await import("./wishlist.ts");
    setDataDir(mockDir);
    addPackage("npm:lodash", "npm:lodash");
    updatePackage("npm:lodash", { notes: "updated" });
    expect(getPackage("npm:lodash")!.notes).toBe("updated");
  });

  it("replaces sources entirely (Object.assign, not deep-merge)", async () => {
    const { addPackage, getPackage, updatePackage, setDataDir } = await import("./wishlist.ts");
    setDataDir(mockDir);
    addPackage("npm:lodash", "npm:lodash");

    // Set sources — Object.assign replaces at top level
    updatePackage("npm:lodash", {
      sources: {
        npm: { latestVersion: "1.0.0", weeklyDownloads: 100 },
      },
    } as any);

    // Partial sources update overwrites the entire sources key
    updatePackage("npm:lodash", {
      sources: {
        github: { owner: "lodash", repo: "lodash", stars: 10, forks: 1, openIssues: 0, pushedAt: "2025-01-01" },
      },
    } as any);

    const entry = getPackage("npm:lodash")!;
    // npm source is gone (replaced by the second update)
    expect((entry.sources as any).npm).toBeUndefined();
    expect((entry.sources as any).github?.owner).toBe("lodash");
  });

  it("does nothing for non-existent package", async () => {
    const { updatePackage, loadWishlist, setDataDir } = await import("./wishlist.ts");
    setDataDir(mockDir);
    expect(() => updatePackage("npm:none", { notes: "x" })).not.toThrow();
  });
});

