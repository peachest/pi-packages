#!/usr/bin/env node
/**
 * pi-events-daemon 可执行入口（票 38）：真 adapter 接线（读 templates/schema 资产）+ 进程信号生命周期。
 * 组合根本体在 daemon-main/bootstrap——本文件不承载任何裁决逻辑。
 *
 * 运行：node --experimental-transform-types packages/pi-events-daemon/bin/pi-events-daemon.ts
 *   [--sock <path>] [--db <path>] [--pid <path>]
 *   [--sessions '[{"sessionId":"s1","sessionFile":"/path/s1.jsonl"}]']
 * 环境白名单 = PI_EVENTS_SOCK（#31）；db/pid/sessions 为显式 CLI 面（测试与托管场景用，缺省走正典路径）。
 */
import { readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { daemonMain } from "../index.ts";
import { resolveSocketPath } from "../transport/index.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const readAsset = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const schemaUrl = new URL("../schemas/profile.schema.json", import.meta.url);
const templateAssets: unknown[] = readdirSync(new URL("../templates/", import.meta.url))
  .filter((f) => f.endsWith(".json"))
  .map((f) => readAsset(new URL(`../templates/${f}`, import.meta.url)));

const sessionsJson = flag("sessions");
const daemon = await daemonMain.bootstrap({
  sockPath: flag("sock"),
  dbPath: flag("db"),
  pidPath: flag("pid"),
  profileSchema: readAsset(schemaUrl) as object,
  profileAssets: templateAssets,
  settingsPath: join(homedir(), ".pi", "settings.json"),
  sessionRefs: sessionsJson ? (JSON.parse(sessionsJson) as never[]) : [],
});

// epoch 旁车文件（<sock>.epoch，extension client 发现约定票 34/38 对齐点；bin 层持有——A 层禁 node IO，
// 信号生命周期同处）。每次成功启动覆写新世代；停机回收，kill -9 残留旧世代 = 新 daemon 覆写前帧被 epoch 门拒（正确语义）。
// 票 40 评审 F8：tmp+rename 原子写且先于 ready 宣布——ready 行是 client 发现信号，读到的一刻旁车必须已就绪（无半写无缺失）。
const sockForEpoch = flag("sock") ?? resolveSocketPath();
const epochPath = `${sockForEpoch}.epoch`;
const epochTmpPath = `${epochPath}.tmp`;
writeFileSync(epochTmpPath, String(daemon.epoch));
renameSync(epochTmpPath, epochPath);

process.stdout.write(`pi-events-daemon ready (pid ${process.pid}, epoch ${daemon.epoch}, sock ${flag("sock") ?? "(canonical)"}, profiles ${templateAssets.length})\n`);

// SIGTERM/SIGINT 优雅退出（票 38 验收面）：drain 在途 L0 事务（同步消费）→ 关 socket → 释锁 → 退出 0。
const shutdown = (signal: NodeJS.Signals): void => {
  process.removeListener(signal, shutdown);
  try {
    unlinkSync(`${sockForEpoch}.epoch`);
  } catch {
    /* 不存在即目标状态 */
  }
  void daemon.stop().then(
    () => process.exit(0),
    (err: unknown) => {
      process.stderr.write(`daemon stop failed: ${String(err)}\n`);
      process.exit(1);
    },
  );
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
