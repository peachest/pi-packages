/* ------------------------------------------------------------------ */
/*  Pi Wishlist — data model CRUD (read/write JSON file)              */
/* ------------------------------------------------------------------ */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { WishlistFile, WishlistEntry, NotificationEvent } from "./types.ts";

export const EVENTS_MAX = 30;
export const EVENTS_TRIM = 15;

let dataDir = join(
  homedir(),
  ".pi",
  "agent",
  "data",
  "wishlist",
);

/** Override data directory (for testing). */
export function setDataDir(dir: string): void {
  dataDir = dir;
}

export function getDataDir(): string {
  return dataDir;
}

function wishlistPath(): string {
  return join(dataDir, "wishlist.json");
}

function getDefaultWishlist(): WishlistFile {
  return {
    settings: { notifications: true },
    packages: {},
  };
}

export function loadWishlist(): WishlistFile {
  const path = wishlistPath();
  if (!existsSync(path)) return getDefaultWishlist();
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as WishlistFile;
  } catch (err: unknown) {
    // Re-throw non-ENOENT errors so callers know something's wrong
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    return getDefaultWishlist();
  }
}

export function saveWishlist(wl: WishlistFile): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = join(dataDir, `wishlist.tmp.${Date.now()}`);
  try {
    writeFileSync(tmp, JSON.stringify(wl, null, 2), "utf-8");
    renameSync(tmp, wishlistPath());
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function addPackage(key: string, source: string, notes?: string): WishlistEntry {
  const wl = loadWishlist();
  const now = new Date().toISOString();
  const entry: WishlistEntry = {
    addedAt: now,
    notes,
    source,
    sources: {},
    lastChecked: now,
    githubFailCount: 0,
    githubCooldownUntil: "",
    notificationEvents: [],
  };
  wl.packages[key] = entry;
  saveWishlist(wl);
  return entry;
}

export function removePackage(key: string): boolean {
  const wl = loadWishlist();
  if (!wl.packages[key]) return false;
  delete wl.packages[key];
  saveWishlist(wl);
  return true;
}

export function getPackage(key: string): WishlistEntry | undefined {
  const wl = loadWishlist();
  return wl.packages[key];
}

export function listPackages(): Array<{ key: string; entry: WishlistEntry }> {
  const wl = loadWishlist();
  return Object.entries(wl.packages).map(([key, entry]) => ({ key, entry }));
}

export function updatePackage(key: string, updates: Partial<WishlistEntry>): void {
  const wl = loadWishlist();
  if (!wl.packages[key]) return;
  Object.assign(wl.packages[key], updates);
  saveWishlist(wl);
}

