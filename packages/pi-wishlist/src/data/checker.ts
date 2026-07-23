/* ------------------------------------------------------------------ */
/*  Pi Wishlist — daily update checker                                */
/* ------------------------------------------------------------------ */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { WishlistFile, CheckResult, NotificationEvent, WishlistEntry } from "./types.ts";
import { loadWishlist, saveWishlist, getDataDir, setDataDir as setWishlistDataDir, EVENTS_MAX, EVENTS_TRIM } from "./wishlist.ts";
import { fetchNpmData, fetchGithubData, withThrottle } from "./tracker.ts";
import { debugLog } from "./debug.ts";

function statePath(): string {
  return join(getDataDir(), "check-state.json");
}

/** Override data directory (for testing). */
export function setCheckerDataDir(dir: string): void {
  setWishlistDataDir(dir);
}

function getToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function saveCheckedDate(): void {
  mkdirSync(getDataDir(), { recursive: true });
  writeFileSync(statePath(), JSON.stringify({ lastCheckedDate: getToday() }));
}

export function isTodayChecked(): boolean {
  if (!existsSync(statePath())) return false;
  try {
    const data = JSON.parse(readFileSync(statePath(), "utf-8"));
    return data.lastCheckedDate === getToday();
  } catch {
    return false;
  }
}

function makeEvent(type: NotificationEvent["type"], to: string, from?: string): NotificationEvent {
  return { type, from, to, at: new Date().toISOString() };
}

/**
 * Check a single package for updates, recording new events.
 */
async function checkPackage(
  key: string,
  entry: import("./types.ts").WishlistEntry,
): Promise<CheckResult> {
  const newEvents: NotificationEvent[] = [];
  const errors: string[] = [];

  const packageName = key.replace(/^npm:/, "");

  // Check npm version
  const npm = await withThrottle(() => fetchNpmData(packageName));
  if (npm) {
    const prev = entry.sources.npm?.latestVersion;
    if (prev && prev !== npm.latestVersion) {
      newEvents.push(makeEvent("new_version", npm.latestVersion, prev));
    }
    entry.sources.npm = npm;
  }

  // Resolve GitHub owner/repo from npm repositoryUrl if not yet fetched
  // ponytail: single owner/repo extraction, no proper URL parser
  let githubOwner = entry.sources.github?.owner;
  let githubRepo = entry.sources.github?.repo;
  if (!githubOwner && entry.sources.npm?.repositoryUrl) {
    const m = String(entry.sources.npm.repositoryUrl).match(/github\.com(?:\/|:)([^/]+)\/([^/.]+)/);
    if (m) {
      githubOwner = m[1];
      githubRepo = m[2];
    }
  }

  const inCooldown = entry.githubCooldownUntil && new Date(entry.githubCooldownUntil) > new Date();
  if (githubOwner && githubRepo && !inCooldown) {
    const github = await fetchGithubData(githubOwner, githubRepo);
    if (github) {
      // Detect stars change
      const prevStars = entry.sources.github?.stars;
      if (prevStars !== undefined && github.stars !== prevStars) {
        newEvents.push(makeEvent("stars_changed", String(github.stars), String(prevStars)));
      }
      entry.sources.github = { ...entry.sources.github, ...github, owner: githubOwner, repo: githubRepo };
      entry.githubFailCount = 0;
      entry.githubCooldownUntil = "";
    } else {
      entry.githubFailCount += 1;
      if (entry.githubFailCount >= 3) {
        const cooldown = new Date(Date.now() + 86_400_000).toISOString(); // +24h
        entry.githubCooldownUntil = cooldown;
      }
      errors.push("GitHub fetch returned no data");
    }
  }

  entry.lastChecked = new Date().toISOString();

  // Append events with dedup + cap
  for (const ev of newEvents) {
    const dup = entry.notificationEvents.some(
      (e) => e.type === ev.type && e.from === ev.from && e.to === ev.to,
    );
    if (!dup) entry.notificationEvents.push(ev);
  }
  if (entry.notificationEvents.length > EVENTS_MAX) {
    entry.notificationEvents = entry.notificationEvents.slice(-EVENTS_TRIM);
  }

  return { packageKey: key, entry, newEvents, trackerResult: { npm, github: entry.sources.github, errors } };
}

/**
 * Run daily check for all packages.
 * Returns packages that have new events.
 */
export async function runDailyCheck(): Promise<CheckResult[]> {
  const wl = loadWishlist();
  const promises = Object.entries(wl.packages).map(([key, entry]) =>
    checkPackage(key, entry),
  );
  const results = await Promise.allSettled(promises);

  const fulfilled: CheckResult[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      fulfilled.push(r.value);
    } else {
      debugLog("checker", "checkPackage rejected", r.reason);
    }
  }

  saveWishlist(wl);
  saveCheckedDate();

  return fulfilled.filter((r) => r.newEvents.length > 0);
}

/** Clear all cooldowns (for refresh all). */
export function clearAllCooldowns(): void {
  const wl = loadWishlist();
  for (const entry of Object.values(wl.packages)) {
    entry.githubFailCount = 0;
    entry.githubCooldownUntil = "";
  }
  saveWishlist(wl);
}

/**
 * Check for installed packages and auto-remove them from wishlist.
 */
export function removeInstalledPackages(wl: WishlistFile, packagesJsonPath?: string): string[] {
  const pkgJsonPath = packagesJsonPath || join(homedir(), ".pi", "agent", "packages.json");
  if (!existsSync(pkgJsonPath)) return [];

  let installed: Record<string, unknown>;
  try {
    installed = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const key of Object.keys(wl.packages)) {
    const name = key.replace(/^npm:/, "");
    if (installed[name]) {
      delete wl.packages[key];
      removed.push(key);
    }
  }
  return removed;
}