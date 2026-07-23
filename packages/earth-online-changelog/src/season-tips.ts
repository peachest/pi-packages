/**
 * Season Tips — Earth Online Changelog
 *
 * Loads seasonal buff/debuff flavor text from config/base/season-tips.yaml
 * and provides random selection from the tip pools.
 *
 * Each tip is a record of language keys (e.g. { zh: "...", en: "..." }).
 * The renderer picks the text matching the current locale, falling back to
 * the first available language key if the target lang is missing.
 */

import { loadYamlFile } from "./yaml-loader.ts";
import { seasonTipsSchema } from "./validation.ts";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single tip with one or more language variants. */
export type TipEntry = Record<string, string>;

export interface SeasonTipSet {
  buffs: TipEntry[];
  debuffs: TipEntry[];
}

export interface SeasonTips {
  spring: SeasonTipSet;
  summer: SeasonTipSet;
  autumn: SeasonTipSet;
  winter: SeasonTipSet;
}

// ─── Fallback Defaults ───────────────────────────────────────────────────────

const FALLBACK_TIPS: SeasonTips = {
  spring: {
    buffs: [
      { zh: "🌱 万物复苏，所有种植/养育类活动产出 +10%", en: "🌱 Spring renewal: farming/raising output +10%" },
      { zh: "🌸 花卉进入盛放期，观光类任务经验 +15%", en: "🌸 Blooming season: sightseeing quest XP +15%" },
    ],
    debuffs: [
      { zh: "🌧️ 换季敏感，部分玩家获得喷嚏 DEBUFF", en: "🌧️ Seasonal allergies: some players get Sneezing DEBUFF" },
      { zh: "🌫️ 大雾天气，户外能见度降低", en: "🌫️ Heavy fog: outdoor visibility reduced" },
    ],
  },
  summer: {
    buffs: [
      { zh: "☀️ 昼长夜短，户外探索类任务体耗 -15%", en: "☀️ Long days: outdoor exploration stamina cost -15%" },
      { zh: "🍉 瓜果成熟季，食物类道具恢复效果 +25%", en: "🍉 Summer harvest: food item recovery +25%" },
    ],
    debuffs: [
      { zh: "🥵 高温警告，户外活动疲劳值累积加速", en: "🥵 Heat warning: outdoor fatigue accumulation accelerated" },
      { zh: "🦟 蚊虫肆虐，休息恢复效率 -20%", en: "🦟 Mosquito rampage: rest recovery efficiency -20%" },
    ],
  },
  autumn: {
    buffs: [
      { zh: "🍂 丰收季节，商店限时上架秋季限定兑换物", en: "🍂 Harvest season: limited autumn exchange items in shop" },
      { zh: "🌾 金秋收割，农作物最终产出 +20%", en: "🌾 Golden harvest: crop final yield +20%" },
    ],
    debuffs: [
      { zh: "💨 秋风渐起，飞行/滑翔类操作难度 +10%", en: "💨 Autumn gusts: flying/gliding difficulty +10%" },
      { zh: "🍂 落叶堆积，道路移动速度 -5%", en: "🍂 Fallen leaves: road movement speed -5%" },
    ],
  },
  winter: {
    buffs: [
      { zh: "❄️ 气温下降，室内活动类任务舒适度 +20%", en: "❄️ Temperature drop: indoor quest comfort +20%" },
      { zh: "🏔️ 雪山区域开放，冰雪主题副本解锁", en: "🏔️ Snow mountain zone open: ice-themed dungeons unlocked" },
    ],
    debuffs: [
      { zh: "🧊 低温警告，户外未穿保暖装备获冻伤 DEBUFF", en: "🧊 Freeze warning: no warm gear outdoors grants Frostbite DEBUFF" },
      { zh: "❄️ 暴雪封路，跨区域移动速度 -30%", en: "❄️ Blizzard road closure: cross-region move speed -30%" },
    ],
  },
};

// ─── YAML Parser ──────────────────────────────────────────────────────────────

/**
 * Parse season-tips.yaml content into SeasonTips.
 * Handles the i18n tip format:
 *   spring:
 *     buffs:
 *       - zh: "tip text"
 *         en: "tip text"
 */
// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load season tips from config/base/season-tips.yaml.
 */
export function loadSeasonTips(dir: string): SeasonTips {
  const raw = loadYamlFile(dir, "config/base/season-tips.yaml");
  if (!raw) return FALLBACK_TIPS;
  const result = seasonTipsSchema.safeParse(raw);
  if (!result.success) return FALLBACK_TIPS;

  const seasons = ["spring", "summer", "autumn", "winter"] as const;
  for (const s of seasons) {
    if (result.data[s].buffs.length === 0 || result.data[s].debuffs.length === 0) {
      return FALLBACK_TIPS;
    }
  }

  return result.data;
}

/**
 * Select a random tip from the pool for the given season, type, and language.
 *
 * Language resolution:
 *   1. Use `lang` to pick the matching language key from the tip
 *   2. If `lang` is missing, fall back to the first available key
 *      (deterministic per tip object — key order in JS objects is insertion order)
 */
export function getRandomSeasonTip(
  tips: SeasonTips,
  season: string,
  type: "buff" | "debuff",
  lang: string,
): string {
  const set = tips[season as keyof SeasonTips];
  if (!set) return "";

  const pool = type === "buff" ? set.buffs : set.debuffs;
  if (pool.length === 0) return "";

  const idx = Math.floor(Math.random() * pool.length);
  const tip = pool[idx]!;

  // Prefer target language, fall back to first available key
  if (tip[lang]) return tip[lang]!;

  const firstKey = Object.keys(tip)[0];
  return firstKey ? (tip[firstKey] ?? "") : "";
}
