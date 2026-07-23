/* ------------------------------------------------------------------ */
/*  Pi Wishlist — type definitions                                    */
/* ------------------------------------------------------------------ */

export interface NpmSource {
  latestVersion: string;
  weeklyDownloads: number;
  /** Raw repository URL from npm registry metadata (e.g. "git+https://..."). */
  repositoryUrl?: string;
}

export interface GithubSource {
  owner: string;
  repo: string;
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt: string;
}

export interface NotificationEvent {
  type: "new_version" | "stars_changed";
  from?: string;
  to: string;
  at: string; // ISO-8601
}

export interface WishlistEntry {
  addedAt: string;
  notes?: string;
  source: string; // "npm:<name>" or "git:github.com/..."
  sources: Partial<{
    npm: NpmSource;
    github: GithubSource;
  }>;
  lastChecked: string;
  /** Consecutive GitHub fetch failures since last success */
  githubFailCount: number;
  /** Timestamp when the 24h GitHub cooldown ends (ISO-8601), or empty */
  githubCooldownUntil: string;
  notificationEvents: NotificationEvent[];
}

export interface WishlistSettings {
  notifications: boolean;
}

export interface WishlistFile {
  settings: WishlistSettings;
  packages: Record<string, WishlistEntry>;
}

export interface TrackerResult {
  npm?: NpmSource;
  github?: GithubSource;
  errors: string[];
}

export interface CheckResult {
  packageKey: string;
  entry: WishlistEntry;
  newEvents: NotificationEvent[];
  trackerResult: TrackerResult;
}

