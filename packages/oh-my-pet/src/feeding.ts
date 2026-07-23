import type { FeedingMemo } from "./types";

export function classifyVitality(tokensPerSec: number): number {
  if (tokensPerSec === 0) return 0;
  if (tokensPerSec < 10) return 25;
  if (tokensPerSec < 50) return 50;
  if (tokensPerSec < 100) return 75;
  return 100;
}

export function computeDeltas(
  params: { outputTokens: number; outputTokensPerSec: number },
  memo: FeedingMemo,
): Record<string, number> {
  const vitality = classifyVitality(params.outputTokensPerSec);

  const deltas: Record<string, number> = {
    "core.exp": params.outputTokens,
    "core.vitality": vitality - memo.lastVitality,
  };

  memo.lastVitality = vitality;

  return deltas;
}
