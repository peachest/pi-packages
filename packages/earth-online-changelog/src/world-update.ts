/**
 * World Update — Earth Online Changelog
 *
 * Pure functions for solar terms, seasons, day/night length, and moon phases.
 * All data computed locally via lunar-typescript — no network dependencies.
 */

import { Solar, LunarMonth } from "lunar-typescript";

// ─── Shared Utility ───────────────────────────────────────────────────────────

/** Truncate a Date to midnight (00:00:00.000) and return as epoch ms. */
export function midnightOf(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * 24 solar terms in order of the Chinese calendar year (starts at 立春).
 * Used to determine season and to find intervals between adjacent terms.
 */
const SOLAR_TERM_ORDER = [
  "立春", "雨水", "惊蛰", "春分", "清明", "谷雨",
  "立夏", "小满", "芒种", "夏至", "小暑", "大暑",
  "立秋", "处暑", "白露", "秋分", "寒露", "霜降",
  "立冬", "小雪", "大雪", "冬至", "小寒", "大寒",
];

/** English names for Chinese solar terms. */
export const SOLAR_TERM_EN: Record<string, string> = {
  "立春": "Start of Spring", "雨水": "Rain Water",
  "惊蛰": "Awakening of Insects", "春分": "Spring Equinox",
  "清明": "Clear and Bright", "谷雨": "Grain Rain",
  "立夏": "Start of Summer", "小满": "Grain Buds",
  "芒种": "Grain in Ear", "夏至": "Summer Solstice",
  "小暑": "Minor Heat", "大暑": "Major Heat",
  "立秋": "Start of Autumn", "处暑": "End of Heat",
  "白露": "White Dew", "秋分": "Autumn Equinox",
  "寒露": "Cold Dew", "霜降": "Frost's Descent",
  "立冬": "Start of Winter", "小雪": "Minor Snow",
  "大雪": "Major Snow", "冬至": "Winter Solstice",
  "小寒": "Minor Cold", "大寒": "Major Cold",
};

/**
 * lunar-typescript's getJieQiTable() sometimes returns UPPERCASE pinyin keys
 * instead of Chinese characters. This map converts them back.
 */
const PINYIN_TO_CHINESE: Record<string, string> = {
  "LI_CHUN": "立春", "YU_SHUI": "雨水", "JING_ZHE": "惊蛰", "CHUN_FEN": "春分",
  "QING_MING": "清明", "GU_YU": "谷雨", "LI_XIA": "立夏", "XIAO_MAN": "小满",
  "MANG_ZHONG": "芒种", "XIA_ZHI": "夏至", "XIAO_SHU": "小暑", "DA_SHU": "大暑",
  "LI_QIU": "立秋", "CHU_SHU": "处暑", "BAI_LU": "白露", "QIU_FEN": "秋分",
  "HAN_LU": "寒露", "SHUANG_JIANG": "霜降", "LI_DONG": "立冬", "XIAO_XUE": "小雪",
  "DA_XUE": "大雪", "DONG_ZHI": "冬至", "XIAO_HAN": "小寒", "DA_HAN": "大寒",
};

// ─── Solar Term Helpers ──────────────────────────────────────────────────────

/**
 * Build a sorted array of {name, date} for all solar terms relevant to the
 * given date. Uses lunar-typescript's getJieQiTable() which returns terms
 * for the current year, late previous year, and early next year.
 */
function buildSolarTermList(date: Date): Array<{ name: string; date: Date }> {
  const year = date.getFullYear();
  const solar = Solar.fromYmd(year, date.getMonth() + 1, date.getDate());
  const lunar = solar.getLunar();
  const table = lunar.getJieQiTable();

  const terms: Array<{ name: string; date: Date }> = [];

  for (const [key, val] of Object.entries(table)) {
    if (typeof val !== "object" || val === null) continue;
    const st = val as { _year: number; _month: number; _day: number; _hour: number; _minute: number; _second: number };
    if (typeof st._year !== "number" || typeof st._month !== "number" || typeof st._day !== "number") continue;

    // The table contains both Chinese-name keys (e.g. "立春") and pinyin/uppercase
    // keys (e.g. "LI_CHUN"). Normalize to Chinese names using the mapping.
    const chineseName = /[\u4e00-\u9fff]/.test(key) ? key : (PINYIN_TO_CHINESE[key] ?? null);
    if (!chineseName) continue;

    const termDate = new Date(st._year, st._month - 1, st._day);
    // Keep terms within a reasonable window around the given year
    if (termDate.getFullYear() < year - 1 || termDate.getFullYear() > year + 1) continue;

    terms.push({ name: chineseName, date: termDate });
  }

  // Sort by date
  terms.sort((a, b) => a.date.getTime() - b.date.getTime());

  return terms;
}

// ─── Public Functions ─────────────────────────────────────────────────────────

/**
 * Return the current solar term name for the given date.
 * If the date is exactly a solar term day, returns that term.
 * Otherwise returns the most recent solar term before today.
 */
export function getCurrentSolarTerm(date: Date): string {
  // Check if today is a solar term day
  const solar = Solar.fromYmd(date.getFullYear(), date.getMonth() + 1, date.getDate());
  const lunar = solar.getLunar();
  const todayJieQi = lunar.getJieQi();
  if (todayJieQi) return todayJieQi;

  // Build sorted solar term list and find the interval
  const terms = buildSolarTermList(date);
  const todayMs = midnightOf(date);

  for (let i = terms.length - 1; i >= 0; i--) {
    if (terms[i].date.getTime() <= todayMs) {
      return terms[i].name;
    }
  }

  // Fallback: if no term found before today (should only happen for very early
  // dates in January), return the last term of the list
  return terms.length > 0 ? terms[terms.length - 1].name : "";
}

/**
 * Return the next solar term name and date after the given date.
 */
export function getNextSolarTerm(date: Date): { name: string; date: Date } {
  const terms = buildSolarTermList(date);
  const todayMs = midnightOf(date);

  for (const term of terms) {
    if (term.date.getTime() > todayMs) {
      return { name: term.name, date: term.date };
    }
  }

  // Fallback: if no next term found (should not happen with reasonable date range),
  // return the first term
  return { name: terms[0]?.name ?? "", date: terms[0]?.date ?? new Date() };
}

/**
 * Return the current season based on the solar term:
 *   立春 → 立夏 = spring
 *   立夏 → 立秋 = summer
 *   立秋 → 立冬 = autumn
 *   立冬 → 立春 = winter
 */
export function getSeason(date: Date): "spring" | "summer" | "autumn" | "winter" {
  const term = getCurrentSolarTerm(date);
  const idx = SOLAR_TERM_ORDER.indexOf(term);

  if (idx === -1) return "spring"; // fallback

  // 立春(0) to 立夏(6): spring
  // 立夏(6) to 立秋(12): summer
  // 立秋(12) to 立冬(18): autumn
  // 立冬(18) to 立春(0): winter
  if (idx < 6) return "spring";
  if (idx < 12) return "summer";
  if (idx < 18) return "autumn";
  return "winter";
}

/**
 * Calculate approximate day and night length using the solar declination
 * formula for latitude 30°N (center server). Returns rounded hours.
 */
export function getDayNightLength(date: Date): { dayHours: number; nightHours: number } {
  const LATITUDE_DEG = 30; // North 30° (Hangzhou/Shanghai area)
  const latRad = (LATITUDE_DEG * Math.PI) / 180;

  // Day of year (1-indexed)
  const startOfYear = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor(
    (date.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24),
  );

  // Solar declination: δ = -23.44° × cos(360°/365 × (N + 10))
  const declinationDeg =
    -23.44 * Math.cos(((360 / 365) * (dayOfYear + 10) * Math.PI) / 180);
  const declinationRad = (declinationDeg * Math.PI) / 180;

  // Day length: 24 - (24/π) × acos(tan(lat) × tan(δ))
  const cosArg = Math.tan(latRad) * Math.tan(declinationRad);
  // Clamp to [-1, 1] to avoid domain errors from floating point
  const clamped = Math.max(-1, Math.min(1, cosArg));
  const dayLength = 24 - (24 / Math.PI) * Math.acos(clamped);

  const dayHours = Math.round(dayLength);
  const nightHours = 24 - dayHours;

  return { dayHours, nightHours };
}

/**
 * Return a 12-segment moon phase progress bar for the given date.
 * filled = round(lunarDay / totalDaysInLunarMonth × 12)
 * percent = round(lunarDay / totalDaysInLunarMonth × 100)
 */
export function getMoonPhaseBar(date: Date): {
  filled: number;
  total: number;
  percent: number;
  phaseName: string;
} {
  const solar = Solar.fromYmd(
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
  );
  const lunar = solar.getLunar();
  const lunarDay = lunar.getDay();
  const phaseName = lunar.getYueXiang();

  // Get total days in this lunar month
  const lm = LunarMonth.fromYm(lunar.getYear(), lunar.getMonth());
  const totalDays = lm ? lm.getDayCount() : 30;

  const filled = Math.round((lunarDay / totalDays) * 12);
  const percent = Math.round((lunarDay / totalDays) * 100);

  return {
    filled: Math.min(12, filled),
    total: 12,
    percent: Math.min(100, percent),
    phaseName,
  };
}
