/**
 * Validation — Earth Online Changelog
 *
 * Zod schemas for runtime type validation at system boundaries:
 * - YAML config parser output (EarthEntry/EarthEvent)
 * - Festival API response conversion
 */

import { z } from "zod";

// ─── Event Types ──────────────────────────────────────────────────────────────

const eventTypeSchema = z.enum(["seasonal", "promotion", "limited", "recurring", "special"]);
const eventSectionSchema = z.enum(["events", "promotion", "system"]);

// ─── EarthEvent ───────────────────────────────────────────────────────────────

export const earthEventSchema = z.object({
  name: z.string().min(1),
  type: eventTypeSchema,
  icon: z.string().min(1),
  section: eventSectionSchema,
  names: z.record(z.string(), z.string()).optional(),
  description: z.string().optional(),
  descriptions: z.record(z.string(), z.string()).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => {
      const [y, m, d] = s.split("-").map(Number);
      const dt = new Date(y!, m! - 1, d!);
      return dt.getFullYear() === y && dt.getMonth() === m! - 1 && dt.getDate() === d;
    }, "Invalid date")
    .optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => {
      const [y, m, d] = s.split("-").map(Number);
      const dt = new Date(y!, m! - 1, d!);
      return dt.getFullYear() === y && dt.getMonth() === m! - 1 && dt.getDate() === d;
    }, "Invalid date")
    .optional(),
  reward: z.string().optional(),
  warmupDays: z.number().int().min(1, "warmupDays must be at least 1").optional(),
});

export type ValidatedEarthEvent = z.infer<typeof earthEventSchema>;

/** Raw event fields as read from YAML — all strings before validation. */
export interface RawEarthEvent {
  name: string;
  type: string;
  icon: string;
  section: string;
  names?: Record<string, string>;
  description?: string;
  descriptions?: Record<string, string>;
  startDate?: string;
  endDate?: string;
  reward?: string;
  warmupDays?: number;
}

// ─── EarthEntry ───────────────────────────────────────────────────────────────

export const earthEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  tag: z.string().optional(),
  highlight: z.string().optional(),
  events: z.array(earthEventSchema),
});

export type ValidatedEarthEntry = z.infer<typeof earthEntrySchema>;

// ─── EarthData ────────────────────────────────────────────────────────────────

export const earthDataSchema = z.object({
  entries: z.array(earthEntrySchema),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse and validate a single event, normalizing defaults for missing fields.
 * Returns null if validation fails.
 */
export function validateEvent(raw: Partial<RawEarthEvent>): ValidatedEarthEvent | null {
  const result = earthEventSchema.safeParse({
    name: raw.name,
    type: raw.type || "seasonal",
    icon: raw.icon || "🎯",
    section: raw.section || "events",
    names: raw.names,
    description: raw.description,
    descriptions: raw.descriptions,
    startDate: raw.startDate,
    endDate: raw.endDate,
    reward: raw.reward,
    warmupDays: raw.warmupDays,
  });
  if (!result.success) {
    // TODO: 在 Pi 扩展中使用合适的日志机制（ctx.logger 或 ui.notify）
    // console.warn 在 Pi 扩展环境中可能不显示，调用方仅收到 null 无法获知失败原因
    console.warn(`[earth-online] Invalid EarthEvent: ${result.error.message}`);
    return null;
  }
  return result.data;
}

// ─── Chronicle ──────────────────────────────────────────────────────────────

export const chronicleEventSchema = z.object({
  title: z.string().min(1),
  description: z.record(z.string(), z.string().min(1)).optional(),
  epoch: z.number().int().positive(),
  tags: z.array(z.string()).optional(),
});

export const chronicleEntrySchema = z.object({
  date: z.string().regex(/^\d{2}-\d{2}$/),
  events: z.array(chronicleEventSchema),
});

export const chronicleDataSchema = z.object({
  entries: z.array(chronicleEntrySchema),
});

export type ValidatedChronicleEvent = z.infer<typeof chronicleEventSchema>;
export type ValidatedChronicleEntry = z.infer<typeof chronicleEntrySchema>;
export type ValidatedChronicleData = z.infer<typeof chronicleDataSchema>;

// ─── Peace Day Config ─────────────────────────────────────────────────────────

export const peaceDayConfigSchema = z.object({
  zh: z.object({
    title: z.string(),
    description: z.array(z.string()),
  }),
  en: z.object({
    title: z.string(),
    description: z.array(z.string()),
  }),
});

export type PeaceDayConfig = z.infer<typeof peaceDayConfigSchema>;

// ─── Season Tips Schema ─────────────────────────────────────────────────────

const tipEntrySchema = z.record(z.string(), z.string());

const seasonTipSetSchema = z.object({
  buffs: z.array(tipEntrySchema),
  debuffs: z.array(tipEntrySchema),
});

export const seasonTipsSchema = z.record(
  z.enum(["spring", "summer", "autumn", "winter"]),
  seasonTipSetSchema,
);
