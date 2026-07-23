export function fullnessBar(percent: number): string {
  const pctRounded = Math.round(percent);
  const filled = Math.round(pctRounded / 10);
  const empty = 10 - filled;
  const label = Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
  return `${"█".repeat(filled) + "░".repeat(empty)  } ${label}`;
}

export function expBar(exp: number): string {
  const level = Math.floor(exp / 1000) + 1;
  const expInLevel = exp % 1000;
  const pct = Math.round((expInLevel / 1000) * 100);
  const filled = Math.round(pct / 10);
  const empty = 10 - filled;
  return `${"█".repeat(filled) + "░".repeat(empty)} ${pct}%`;
}

export function vitalityLabel(value: number): string {
  const labels: Record<number, string> = {
    0: "dormant",
    25: "slow",
    50: "normal",
    75: "fast",
    100: "burst",
  };
  return `${labels[value] ?? "unknown"} (${value})`;
}

export function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

export function renderDashboard(
  attrs: Record<string, number>,
  projectName: string,
): string {
  const exp = attrs["core.exp"] ?? 0;
  const vitality = attrs["core.vitality"] ?? 0;
  const level = Math.floor(exp / 1000) + 1;
  const vLabel = vitalityLabel(vitality);

  const expBarStr = expBar(exp);
  const nextLevelExp = ((Math.floor(exp / 1000) + 1) * 1000) - exp;

  const lines = [
    `╭──────────── 🐣 ${projectName} ────────────╮`,
    `│  Lv.${level}  ${expBarStr}  ⚡ ${vLabel.split(" ")[0]}      │`,
    `│                                      │`,
    `│  📊 等级: ${level}                          │`,
    `│  📈 总经验: ${exp.toLocaleString()}                    │`,
    `│  🎯 距下一级: ${nextLevelExp.toLocaleString()} exp              │`,
    `│  ⚡ 活力: ${vLabel}                  │`,
    `│                                      │`,
    `╰──────────────────────────────────────╯`,
  ];

  return lines.join("\n");
}
