import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** pidfile 正典路径（#31 数据布局：运行时目录；票 38 单活仲裁）。 */
export function defaultPidPath(): string {
  return join(homedir(), ".pi", "run", "pi-events-daemon.pid");
}

/**
 * FileLock — O_EXCL pidfile 单活仲裁（票 38；flock 的 MVP 简化，coordinator 裁定）。
 * 票 38 评审修复（3H1M）：①创建后立即同步写 pid（open(wx) 与写 pid 两步间窗口最小化）；
 * ②pidfile 读错误 ≠ stale——仅 ENOENT（真 stale）可回收，EACCES 等 I/O 错原样上抛不碰锁；
 * ③内容空/不可解析 = 创建-写 pid 交错窗口，无法验证持有者死亡 → fail-safe 拒取不回收；
 * ④rm 前校验锁内 pid 是自己——锁已被他人接管时不误删。
 * 冲突分派：持有者活 → 双启动拒绝报状态；死（kill -9 残留）→ 回收重取，自愈前置。
 * 真壳 adapter（fx 唯一锁实现：单机单活由 pidfile+flock+epoch 足以承载，#31 daemon 存留性 POC 结论，无 fake seam）。
 */
export class FileLock {
  constructor(
    private readonly path: string,
    private readonly pid: number = process.pid,
  ) {}

  /** 获取锁：O_EXCL 创建 pidfile + 立即写 pid（创建即仲裁）；冲突按持有者活性分派（活→拒绝，死→回收重试一轮）。 */
  acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.path, "wx"); // O_CREAT|O_EXCL：创建即仲裁
        try {
          writeSync(fd, `${this.pid}\n`); // 立即同步写：交错读者见空文件也不得回收（评审 ①③）
        } finally {
          closeSync(fd);
        }
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        let content: string;
        try {
          content = readFileSync(this.path, "utf8");
        } catch (readErr) {
          if ((readErr as NodeJS.ErrnoException).code === "ENOENT") continue; // 锁已被移除：真 stale，重试一轮
          throw readErr; // EACCES 等 I/O 错 ≠ stale（评审 ②）：不碰锁，原样上抛
        }
        const holder = Number(content.trim());
        if (Number.isInteger(holder) && holder > 0) {
          if (this.alive(holder)) {
            throw new Error(`daemon already running (pid ${holder}, pidfile ${this.path})`);
          }
          rmSync(this.path, { force: true }); // 死进程残留：回收后重取（活持有者不会走到这——活性已验）
          continue;
        }
        // 空/不可解析 = 持有者创建后尚未写 pid 的交错窗口（或损坏文件）：无法验证死亡，
        // 回收会误删真持有者的锁（评审 ③）——fail-safe 拒取不回收
        throw new Error(`daemon lock contended (pidfile ${this.path} unparseable; holder may be mid-acquire — not recovering)`);
      }
    }
    throw new Error(`daemon lock contended (pidfile ${this.path})`);
  }

  /** 释放：仅当锁内 pid 是自己才删（评审 ④：他人接管后不误删；读不回 = 无法验证所有权，同样不删）。 */
  release(): void {
    try {
      if (readFileSync(this.path, "utf8").trim() === String(this.pid)) rmSync(this.path);
    } catch {
      /* ENOENT = 已释放；EACCES 等 = 无法验证所有权：都不删（泄漏由重启侧死 pid 回收兜底） */
    }
  }

  /** kill(pid, 0) 探活：ESRCH=死，EPERM=活（他者进程仍在），其他错误按死处理。 */
  private alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }
}
