/**
 * Config Parser — Earth Online Changelog
 *
 * Parses monthly YAML config files into typed EarthData.
 * Contains all domain type definitions.
 */

import { load } from "js-yaml";

import { validateEvent } from "./validation.ts";
import type { ValidatedEarthEvent } from "./validation.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type EarthEvent = ValidatedEarthEvent;

export interface EarthEntry {
  date: string; // YYYY-MM-DD
  tag?: string;
  highlight?: string; // optional version highlight
  events: EarthEvent[];
}

export interface EarthData {
  entries: EarthEntry[];
}

export interface UpcomingEvent {
  date: string; // MM-DD
  icon: string;
  name: string;
}

/**
 * Response shape from the VVhan lunar calendar API (api.vvhan.com).
 */
export interface VvhanResponse {
  success?: boolean;
  data?: {
    festival?: string;
    solarTerm?: string;
    jieqi?: string;
    [key: string]: unknown;
  };
}

// ─── YAML Parser ──────────────────────────────────────────────────────────────

interface RawYamlEvent {
  name?: string;
  type?: string;
  icon?: string;
  section?: string;
  names?: Record<string, string>;
  description?: string;
  descriptions?: Record<string, string>;
  startDate?: string;
  endDate?: string;
  reward?: string;
  warmupDays?: number;
}

interface RawYamlEntry {
  date?: string;
  tag?: string;
  highlight?: string;
  events?: RawYamlEvent[];
}

interface RawYamlData {
  entries?: RawYamlEntry[];
}

/**
 * Parse a month YAML file content into EarthData.
 * Uses js-yaml for parsing, then validates each event individually.
 * Invalid events are silently dropped; entries with zero valid events are dropped.
 */
export function parseEarthYaml(raw: string): EarthData {
  const parsed = load(raw) as RawYamlData;
  const entries: EarthEntry[] = [];

  if (!parsed?.entries || !Array.isArray(parsed.entries)) {
    return { entries: [] };
  }

  for (const rawEntry of parsed.entries) {
    if (!rawEntry?.date) continue;

    const validEvents: ValidatedEarthEvent[] = [];
    if (rawEntry.events && Array.isArray(rawEntry.events)) {
      for (const rawEvent of rawEntry.events) {
        const validated = validateEvent(rawEvent);
        if (validated) validEvents.push(validated);
      }
    }

    if (validEvents.length > 0) {
      entries.push({
        date: rawEntry.date,
        tag: rawEntry.tag,
        highlight: rawEntry.highlight,
        events: validEvents,
      });
    }
  }

  return { entries };
}

// ─── Event Name/Description Accessors ─────────────────────────────────────────

/**
 * Get the localized display name for an event.
 */
export function getEventName(event: EarthEvent, lang: string): string {
  return event.names?.[lang] || event.name;
}

/**
 * Get the localized description for an event.
 */
export function getEventDescription(event: EarthEvent, lang: string): string {
  return event.descriptions?.[lang] || event.description || "";
}