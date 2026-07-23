/* ------------------------------------------------------------------ */
/*  Notifier snapshot tests                                           */
/*                                                                     */
/*  buildNotificationPanel() is a pure function — no mocks needed.     */
/* ------------------------------------------------------------------ */

import { describe, it, expect, vi } from "vitest";

vi.mock("../state/i18n-bridge.ts", () => ({
  t: (_key: string, fallback: string) => fallback,
  i18nAvailable: false,
  i18nInitDone: false,
  I18N_NAMESPACE: "pi-wishlist",
}));

import { buildNotificationPanel } from "./notifier.ts";
import type { CheckResult } from "../data/types.ts";

const versionEvent: CheckResult = {
  packageKey: "npm:pi-marketplace",
  entry: {} as any,
  newEvents: [{ type: "new_version", from: "0.7.0", to: "0.8.0", at: "2026-06-23T00:00:00.000Z" }],
  trackerResult: {} as any,
};

const starsEvent: CheckResult = {
  packageKey: "npm:pi-subagents",
  entry: {} as any,
  newEvents: [{ type: "stars_changed", from: "200", to: "250", at: "2026-06-23T00:00:00.000Z" }],
  trackerResult: {} as any,
};

const multiEventSinglePkg: CheckResult = {
  packageKey: "npm:pi-core",
  entry: {} as any,
  newEvents: [
    { type: "new_version", from: "1.0.0", to: "2.0.0", at: "2026-06-23T00:00:00.000Z" },
    { type: "stars_changed", from: "50", to: "80", at: "2026-06-23T00:00:00.000Z" },
  ],
  trackerResult: {} as any,
};

describe("buildNotificationPanel — snapshot", () => {
  it("matches snapshot: single version update", () => {
    expect(buildNotificationPanel([versionEvent], 60)).toMatchSnapshot();
  });

  it("matches snapshot: two different packages with different event types", () => {
    expect(buildNotificationPanel([versionEvent, starsEvent], 60)).toMatchSnapshot();
  });

  it("matches snapshot: multiple events on same package", () => {
    expect(buildNotificationPanel([multiEventSinglePkg], 60)).toMatchSnapshot();
  });
});