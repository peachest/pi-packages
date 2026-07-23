/**
 * Earth Online Changelog — Pi Extension
 *
 * Entry point. Re-exports the main extension function from src/main.ts.
 *
 * Daily "patch notes" for the real world, like a live-service game:
 *   ├ 版本号（按日期，如 2026.06.11）
 *   ├ 版本亮点（highlight）
 *   ├ 分类板块：🎯 新增活动 / 🛍️ 促销 & 限时 / 🔧 系统更新
 *   ├ 📅 即将到来（未来 7 天预告）
 *   └ 零事件日显示 "✨ 和平日"
 *
 * Config: config/YYYY/MM.yaml directory tree (one file per month)
 *
 * Trigger: /earth command | auto-show on first daily session
 */

export { default } from "./src/main.ts";

// Re-export for testing
import { buildPatchNotes, buildWidgetContent } from "./src/patch-notes-orch.ts";

export { buildPatchNotes, buildWidgetContent };
export { loadSeasonTips, getRandomSeasonTip } from "./src/season-tips.ts";
export type { SeasonTips, SeasonTipSet, TipEntry } from "./src/season-tips.ts";
export type { PeaceDayConfig } from "./src/validation.ts";
