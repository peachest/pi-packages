import { readFile as nodeReadFile } from "node:fs/promises";
import type { Fs } from "./types.ts";

/** 真文件读薄 adapter：utf-8 全文读，错误原形上抛（ENOENT 等分类归调用方）。 */
export class NodeFs implements Fs {
  readFile(path: string): Promise<string> {
    return nodeReadFile(path, "utf8");
  }
}
