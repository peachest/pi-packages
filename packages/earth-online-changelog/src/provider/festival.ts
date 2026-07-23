/**
 * Festival Provider — Earth Online Changelog
 *
 * Computes festivals and solar terms locally using lunar-typescript.
 * No external API calls — all data is derived from the lunar calendar library.
 */

import { Solar } from "lunar-typescript";
import { earthEventSchema } from "../validation.ts";
import type { EarthEvent } from "../config-parser.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Festival {
  name: string;
  date: string;
  type: string;
  icon?: string;
}

// ─── Local Computation ────────────────────────────────────────────────────────

const SOLAR_TERM_ICON = "🌿";
const FESTIVAL_ICON = "🎊";

/**
 * Compute festivals and solar terms for a given date using lunar-typescript.
 * Returns an array of Festival objects (may be empty for dates with no events).
 */
function computeFestivals(dateStr: string): Festival[] {
  const festivals: Festival[] = [];

  const [year, month, day] = dateStr.split("-").map(Number);
  if (!year || !month || !day) return festivals;

  const solar = Solar.fromYmd(year, month, day);
  const lunar = solar.getLunar();

  // 1. Solar festivals (e.g. 儿童节, 元旦, 国庆节)
  for (const f of solar.getFestivals()) {
    if (f?.trim()) {
      festivals.push({ name: f.trim(), date: dateStr, type: "seasonal", icon: FESTIVAL_ICON });
    }
  }

  // 2. Lunar festivals (e.g. 春节, 中秋节 via Lunar.getFestivals)
  for (const f of lunar.getFestivals()) {
    if (f?.trim()) {
      festivals.push({ name: f.trim(), date: dateStr, type: "seasonal", icon: FESTIVAL_ICON });
    }
  }

  // 3. Other festivals (e.g. 母亲节, 父亲节 via Lunar.getOtherFestivals)
  for (const f of lunar.getOtherFestivals()) {
    if (f?.trim()) {
      festivals.push({ name: f.trim(), date: dateStr, type: "seasonal", icon: FESTIVAL_ICON });
    }
  }

  // 4. Solar term (JieQi) for this day
  const jieqi = lunar.getJieQi();
  if (jieqi?.trim()) {
    festivals.push({ name: jieqi.trim(), date: dateStr, type: "seasonal", icon: SOLAR_TERM_ICON });
  }

  return festivals;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

/**
 * Convert festivals to EarthEvent[] with section: "events".
 * Validates each event with zod; invalid events are silently dropped.
 */
export function apiEventsToEarthEvents(festivals: Festival[]): EarthEvent[] {
  const result: EarthEvent[] = [];
  for (const f of festivals) {
    const parsed = earthEventSchema.safeParse({
      name: f.name || "节日",
      type: f.type || "seasonal",
      icon: f.icon || FESTIVAL_ICON,
      section: "events",
    });
    if (parsed.success) {
      result.push(parsed.data);
    } else {
      console.warn(`[earth-online] Invalid festival "${f.name}": ${parsed.error.message}`);
    }
  }
  return result;
}

/**
 * Fetch festival events for a given date (now computed locally, no network).
 */
export async function getFestivalEvents(dateStr: string): Promise<EarthEvent[]> {
  const festivals = computeFestivals(dateStr);
  return apiEventsToEarthEvents(festivals);
}