/**
 * YAML Loader — thin I/O layer for YAML file discovery and parsing
 *
 * Does NOT validate — only reads, parses, and returns `unknown | null`.
 * Orchestration layer (data-loader, season-tips) handles Zod validation.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

/**
 * Load and parse a YAML file.
 *
 * @param extDir  Extension root directory
 * @param subpath Relative path within extDir (e.g. "config/base/something.yaml")
 * @returns Parsed YAML content as unknown, or null if file doesn't exist or parse fails
 */
export function loadYamlFile(extDir: string, subpath: string): unknown | null {
  const fullPath = join(extDir, subpath);
  if (!existsSync(fullPath)) return null;
  try {
    return load(readFileSync(fullPath, "utf-8"));
  } catch (e) {
    console.error(`[earth-online] Failed to load ${fullPath}:`, e);
    return null;
  }
}
