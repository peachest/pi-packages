import { readFile as nodeReadFile } from "node:fs/promises";
import { watch as nodeWatch } from "node:fs";
import type { Fs } from "./types.ts";

/** 真文件读薄 adapter：utf-8 全文读，错误原形上抛（ENOENT 等分类归调用方）。 */
export class NodeFs implements Fs {
  readFile(path: string): Promise<string> {
    return nodeReadFile(path, "utf8");
  }

  /** 原生推送监听薄 adapter（票 18 fs-watch 停点）：fs.watch 事件原样转发；error 事件经 onError 上抛（缺省 close 收尾），处理语义（回流 waiting 等）归消费方。路径不存在等同步抛错原形上抛（参数错归调用方）。 */
  watch(path: string, onEvent: () => void, onError?: (err: unknown) => void): { close(): void } {
    const watcher = nodeWatch(path, () => onEvent());
    watcher.on("error", (err) => {
      if (onError) onError(err);
      else watcher.close();
    });
    return { close: () => watcher.close() };
  }
}
