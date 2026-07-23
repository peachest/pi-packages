/**
 * Data Loader — Earth Online Changelog
 *
 * Loads monthly YAML config files from the config/ directory tree.
 * Handles extension directory resolution and file I/O.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { parseEarthYaml } from "./config-parser.ts";
import type { EarthData, EarthEntry } from "./config-parser.ts";
import { chronicleDataSchema, peaceDayConfigSchema } from "./validation.ts";
import type { ValidatedChronicleData, ValidatedChronicleEntry, PeaceDayConfig } from "./validation.ts";
import { loadYamlFile } from "./yaml-loader.ts";

export type ChronicleData = ValidatedChronicleData;
export type ChronicleEntry = ValidatedChronicleEntry;

// ─── Extension Directory Resolution ───────────────────────────────────────────

export function getExtensionDir(): string {
  try {
    const selfPath = fileURLToPath(import.meta.url);
    const selfDir = dirname(selfPath);
    // data-loader.ts is at <extDir>/src/data-loader.ts → parent is <extDir>/src → parent is <extDir>
    const extDir = dirname(selfDir);
    if (existsSync(extDir)) return extDir;
  } catch {
    // fall through
  }

  const candidates = [
    process.env["EARTH_ONLINE_DIR"],
    join(process.cwd(), ".pi", "extensions", "earth-online-changelog"),
    join(
      process.env["HOME"] || homedir(),
      ".pi",
      "agent",
      "extensions",
      "earth-online-changelog",
    ),
  ];

  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }

  return process.cwd();
}

// ─── Data Loading ─────────────────────────────────────────────────────────────

/**
 * Load EarthData for a specific year/month file.
 * If the file doesn't exist, returns empty data.
 */
export function loadEarthData(dir: string, year?: number, month?: number): EarthData {
  const now = new Date();
  const y = year ?? now.getFullYear();
  const m = month ?? now.getMonth() + 1;
  const yamlPath = join(dir, "config", String(y), `${String(m).padStart(2, "0")}.yaml`);

  if (!existsSync(yamlPath)) {
    return { entries: [] };
  }
  try {
    const raw = readFileSync(yamlPath, "utf-8");
    return parseEarthYaml(raw);
  } catch (e) {
    console.error(`[earth-online] Failed to load ${yamlPath}:`, e);
    throw e;
  }
}

/**
 * Load EarthData for a range of months (useful for upcoming events).
 * Returns a map keyed by YYYY-MM-DD for fast lookup.
 */
export function loadEarthDataRange(
  dir: string,
  startYear: number,
  startMonth: number,
  endYear: number,
  endMonth: number,
): Map<string, EarthEntry> {
  const map = new Map<string, EarthEntry>();

  let y = startYear;
  let m = startMonth;
  while (true) {
    const data = loadEarthData(dir, y, m);
    for (const entry of data.entries) {
      map.set(entry.date, entry);
    }
    if (y === endYear && m === endMonth) break;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }

  return map;
}

// ─── Chronicles ──────────────────────────────────────────────────────────────

/** Load chronicle data from config/base/this-day.yaml. */
export function loadChronicles(extDir: string): ChronicleData {
  const raw = loadYamlFile(extDir, "config/base/this-day.yaml");
  if (!raw) return { entries: [] };
  const result = chronicleDataSchema.safeParse(raw);
  return result.success ? result.data : { entries: [] };
}

// ─── Peace Day Config ─────────────────────────────────────────────────────────

/** Load peace day config from config/base/peace-day.yaml. */
export function loadPeaceDayConfig(extDir: string): PeaceDayConfig | null {
  const raw = loadYamlFile(extDir, "config/base/peace-day.yaml");
  if (!raw) return null;
  const result = peaceDayConfigSchema.safeParse(raw);
  return result.success ? result.data : null;
}
