import { mkdirSync, appendFileSync, readFileSync, readdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import type { BinlogEntry } from "./types";
import { encodeProjectPath } from "./utils";

function parseJsonl(content: string): BinlogEntry[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  return trimmed.split("\n").map(line => JSON.parse(line));
}

function binlogDir(petsBase: string, projectRoot: string): string {
  return join(petsBase, encodeProjectPath(projectRoot), "binlogs");
}

export class BinlogManager {
  constructor(
    private petsBase: string,
    private projectRoot: string,
  ) {}

  appendEntry(sessionId: string, entry: Omit<BinlogEntry, "seq">): void {
    const dir = binlogDir(this.petsBase, this.projectRoot);
    mkdirSync(dir, { recursive: true });

    const filePath = join(dir, `${sessionId}.log`);
    const entries = this.readSessionEntries(sessionId);

    // 幂等去重：同 session 同 responseId 静默忽略
    if (entries.some(e => e.responseId === entry.responseId)) return;

    const seq = entries.length + 1;
    const fullEntry: BinlogEntry = { ...entry, seq, sessionId };
    appendFileSync(filePath, `${JSON.stringify(fullEntry)}
`);
  }

  readAllEntries(): BinlogEntry[] {
    const dir = binlogDir(this.petsBase, this.projectRoot);
    if (!existsSync(dir)) return [];

    const entries: BinlogEntry[] = [];
    for (const file of readdirSync(dir).filter(f => f.endsWith(".log"))) {
      try {
        entries.push(...parseJsonl(readFileSync(join(dir, file), "utf-8")));
      } catch (err: any) {
        if (err.code !== "ENOENT") throw err;
        // 文件在 readdirSync 后被删除（并发场景），静默跳过
      }
    }
    return entries;
  }

  deleteSession(sessionId: string): void {
    const filePath = join(
      binlogDir(this.petsBase, this.projectRoot),
      `${sessionId}.log`,
    );
    if (existsSync(filePath)) unlinkSync(filePath);
  }

  private readSessionEntries(sessionId: string): BinlogEntry[] {
    const filePath = join(
      binlogDir(this.petsBase, this.projectRoot),
      `${sessionId}.log`,
    );
    try {
      if (!existsSync(filePath)) return [];
      return parseJsonl(readFileSync(filePath, "utf-8"));
    } catch (err: any) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  }
}
