import { homedir } from "os";
import { execSync } from "child_process";
import { join } from "path";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { expBar, vitalityLabel } from "./dashboard";

export function findProjectRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return process.cwd();
  }
}

/**
 * Pi 风格路径编码：将文件系统路径转换为扁平标识符。
 * /mnt/disk1/hyx/projects/foo → --mnt-disk1-hyx-projects-foo--
 */
export function encodeProjectPath(projectRoot: string): string {
  // 去掉首尾斜杠，替换 / 和 . 为 -
  const trimmed = projectRoot.replace(/^\/+|\/+$/g, "");
  const encoded = trimmed.replace(/[/.]/g, "-");
  return `--${encoded}--`;
}

/**
 * 解析宠物数据基础目录（中心化全局路径）。
 * 遵循 pi 的 ~/.pi/agent/sessions/ 模式。
 */
export function resolvePetsBase(): string {
  const envDir = process.env.PI_PETS_DIR;
  if (envDir && envDir.length > 0) return envDir;
  return join(homedir(), ".pi", "agent", "pets");
}

/**
 * 从旧位置 .pet/binlogs/ 迁移数据到中心化目录。
 * 一次性迁移，仅在新位置无数据时执行。
 *
 * 注意：当前使用同步 I/O，不是并发安全的。
 * 若多个进程同时迁移同一项目，可能出现先到者被后者清空数据的竞态。
 * 后续可考虑文件锁（fs.flock）或仅复制不删除的策略。
 */
export function migrateOldPetData(projectRoot: string, petsBase: string): void {
  const oldDir = join(projectRoot, ".pet", "binlogs");
  if (!existsSync(oldDir)) return;

  const encoded = encodeProjectPath(projectRoot);
  const newDir = join(petsBase, encoded, "binlogs");

  // 新位置已有数据则不迁移（避免覆盖）
  if (existsSync(newDir)) return;

  mkdirSync(newDir, { recursive: true });
  for (const file of readdirSync(oldDir).filter(f => f.endsWith(".log"))) {
    copyFileSync(join(oldDir, file), join(newDir, file));
  }

  // 迁移后清理旧 .pet/ 目录
  const oldPetDir = join(projectRoot, ".pet");
  rmSync(oldPetDir, { recursive: true, force: true });
}

export function formatStatusLine(attrs: Record<string, number>): string {
  const exp = attrs["core.exp"] ?? 0;
  const vitality = attrs["core.vitality"] ?? 0;
  const level = Math.floor(exp / 1000) + 1;
  const bar = expBar(exp);
  const vLabel = vitalityLabel(vitality).split(" ")[0];
  return `[🐣 Lv.${level}] ${bar} ⚡${vLabel}`;
}
