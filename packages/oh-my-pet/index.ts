import { randomUUID } from "crypto";
import * as path from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BinlogManager } from "./src/binlog";
import { replay } from "./src/replay";
import { computeDeltas } from "./src/feeding";
import { renderDashboard } from "./src/dashboard";
import { findProjectRoot, formatStatusLine, resolvePetsBase, migrateOldPetData } from "./src/utils";
import type { AttrPolicies, FeedingMemo } from "./src/types";

const POLICIES: AttrPolicies = {
  "core.exp": { min: 0, max: Infinity },
  "core.vitality": { min: 0, max: 100 },
};

function computeStatusLine(binlog: BinlogManager, liveExp?: number) {
  const attrs = replay(binlog.readAllEntries(), POLICIES);
  const live = liveExp ?? attrs["core.exp"] ?? 0;
  return formatStatusLine({ ...attrs, "core.exp": live });
}

export default function (pi: ExtensionAPI) {
  const projectRoot = findProjectRoot();
  const petsBase = resolvePetsBase();
  migrateOldPetData(projectRoot, petsBase);
  const binlog = new BinlogManager(petsBase, projectRoot);
  const sessionId = path.basename(projectRoot);
  const memo: FeedingMemo = { lastVitality: 0 };
  let turnStart = 0;

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("pet", computeStatusLine(binlog));
  });

  pi.on("turn_start", () => {
    turnStart = Date.now();
  });

  let accumulatedOutputTokens = 0;

  pi.on("message_update", (event, ctx) => {
    if (!ctx.hasUI) return;
    const currentOutput = event.message.usage?.output ?? 0;
    if (currentOutput <= accumulatedOutputTokens) return;
    accumulatedOutputTokens = currentOutput;

    const attrs = replay(binlog.readAllEntries(), POLICIES);
    const liveExp = (attrs["core.exp"] ?? 0) + currentOutput;
    ctx.ui.setStatus("pet", formatStatusLine({ ...attrs, "core.exp": liveExp }));
  });

  pi.on("turn_end", async (event, ctx) => {
    const outputTokens = event.message.usage?.output ?? 0;
    accumulatedOutputTokens = 0;
    const durationMs = Date.now() - turnStart;
    const outputTokensPerSec = durationMs > 0
      ? outputTokens / (durationMs / 1000)
      : 0;

    const deltas = computeDeltas(
      { outputTokens, outputTokensPerSec },
      memo,
    );

    if (Object.values(deltas).some(v => v !== 0)) {
      binlog.appendEntry(sessionId, {
        responseId: randomUUID(),
        timestamp: Date.now(),
        mod: "feeding",
        attributes: deltas,
      });
    }

    if (ctx.hasUI) {
      ctx.ui.setStatus("pet", computeStatusLine(binlog));
    }
  });

  pi.registerCommand("pet", {
    description: "显示宠物面板",
    handler: async (_args, ctx) => {
      const entries = binlog.readAllEntries();
      const attrs = replay(entries, POLICIES);
      const cu = ctx.getContextUsage();
      const fullness = cu?.percent ?? 0;
      const panel = renderDashboard({ ...attrs, "core.fullness": fullness }, path.basename(projectRoot));
      pi.sendMessage({
        customType: "pet-dashboard",
        content: panel,
        display: true,
      });
    },
  });
}
