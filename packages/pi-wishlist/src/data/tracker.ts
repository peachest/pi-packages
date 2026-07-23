/* ------------------------------------------------------------------ */
/*  Pi Wishlist — npm & GitHub data fetcher                           */
/* ------------------------------------------------------------------ */

import type { NpmSource, GithubSource, TrackerResult } from "./types.ts";
import { debugLog } from "./debug.ts";

const REGISTRY_BASE = "https://registry.npmjs.org";
const DOWNLOADS_API = "https://api.npmjs.org/downloads/point/last-week";

// ponytail: package name validation
const SAFE_NAME_RE = /^(@?[a-zA-Z0-9][a-zA-Z0-9._/-]*)$/;

function safePackageName(name: string): string | undefined {
  const m = name.match(SAFE_NAME_RE);
  return m ? m[1] : undefined;
}

/**
 * Wraps an async function with at least 200ms delay between calls.
 */
let lastCallTime = 0;

export async function withThrottle<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < 200) {
    await new Promise((r) => setTimeout(r, 200 - elapsed));
  }
  lastCallTime = Date.now();
  return fn();
}

/**
 * Fetch npm package metadata via registry API.
 * Returns version + weekly downloads + optional repo URL.
 */
export async function fetchNpmData(packageName: string): Promise<NpmSource | undefined> {
  const name = safePackageName(packageName);
  if (!name) return undefined;

  try {
    const [registryRes, downloadsRes] = await Promise.all([
      fetch(`${REGISTRY_BASE}/${encodeURIComponent(name)}/latest`, { signal: AbortSignal.timeout(10_000) }),
      fetch(`${DOWNLOADS_API}/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(10_000) }),
    ]);

    if (!registryRes.ok || !downloadsRes.ok) {
      debugLog("tracker", "fetchNpmData non-ok", registryRes.status, downloadsRes.status);
      return undefined;
    }

    const [registryData, downloadsData] = await Promise.all([
      registryRes.json() as Promise<{ version: string; repository?: { url: string } }>,
      downloadsRes.json() as Promise<{ downloads: number }>,
    ]);

    return {
      latestVersion: registryData.version,
      weeklyDownloads: downloadsData.downloads,
      repositoryUrl: registryData.repository?.url,
    };
  } catch (err) {
    debugLog("tracker", "fetchNpmData failed", packageName, err);
    return undefined;
  }
}

/**
 * Fetch GitHub repo metadata via unauthenticated API.
 */
export async function fetchGithubData(
  owner: string,
  repo: string,
  token?: string,
): Promise<GithubSource | undefined> {
  const effectiveToken = token || process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = { Accept: "application/vnd.github.v3+json" };
  if (effectiveToken && effectiveToken.length > 0) headers.Authorization = `Bearer ${effectiveToken}`;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      debugLog("tracker", "GitHub API non-ok", owner, repo, res.status);
      return undefined;
    }
    const data = (await res.json()) as {
      stargazers_count: number;
      forks_count: number;
      open_issues_count: number;
      pushed_at: string;
    };
    return {
      owner,
      repo,
      stars: data.stargazers_count,
      forks: data.forks_count,
      openIssues: data.open_issues_count,
      pushedAt: data.pushed_at,
    };
  } catch (err) {
    debugLog("tracker", "GitHub fetch error", owner, repo, err);
    return undefined;
  }
}

/**
 * Attempt to resolve NPM → GitHub, then fetch both.
 */
export async function trackPackage(
  packageName: string,
): Promise<TrackerResult> {
  const errors: string[] = [];
  let github: GithubSource | undefined;

  const npm = await withThrottle(() => fetchNpmData(packageName));
  if (npm?.repositoryUrl) {
    const m = String(npm.repositoryUrl).match(/github\.com(?:\/|:)([^/]+)\/([^/.]+)/);
    if (m) {
      const [, owner, repo] = m;
      // ponytail: single throttle-wrapped call, not separate throttle+call
      github = await withThrottle(() => fetchGithubData(owner, repo));
      if (!github) errors.push("GitHub fetch failed");
    }
  }

  return { npm, github, errors };
}