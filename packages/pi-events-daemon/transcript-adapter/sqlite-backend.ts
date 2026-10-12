/**
 * transcript-adapter/sqlite-backend — harness-v2 SQLite 点查（票 20，#31 双后端 MVP 裁定 2026-10-10）。
 *
 * 驱动 = node:sqlite 内置模块（票 22 同款零依赖先例 store/sqlite.ts；A 层 IO 禁令按名单生效，
 * sqlite 不在其列——票 20 在册裁定）。只读打开：SQLite 层直接拒写，adapter 只读承诺的结构化强化。
 *
 * 形态 = harness-v2 代表性样本（待对齐：packages/session-backends/sqlite-node 定稿为准）：
 * 一库多 session；entries.payload = 条目 payload（type='message' 时为 custom agent message 对象）；
 * branch_entries.custom_type 索引 custom 条目。verdict 字段知识不出 index.ts（I9）——本文件只按
 * custom_type 取回候选行（seq + payload 原文），字段路径解析与 verdict 聚合在 index.ts。
 */
import { DatabaseSync } from "node:sqlite";

export interface SqliteEntryRow {
  seq: number;
  payload: string;
}

const POINT_QUERY = `
  SELECT e.seq AS seq, e.payload AS payload
    FROM entries AS e
    JOIN branch_entries AS b
      ON b.session_id = e.session_id AND b.entry_id = e.id
   WHERE e.session_id = ? AND b.custom_type = ?
   ORDER BY e.seq
`;

/** 通知条目点查：缺库/权限/锁等打开或查询失败 → 上抛，调用方归 unreadable（C1 正常返回值）。 */
export function queryNotificationEntries(dbPath: string, sessionId: string, customType: string): SqliteEntryRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(POINT_QUERY).all(sessionId, customType) as unknown as SqliteEntryRow[];
  } finally {
    db.close();
  }
}
