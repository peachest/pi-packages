import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** pidfile 正典路径（#31 数据布局：运行时目录；票 38 单活仲裁）。 */
export function defaultPidPath(): string {
  return join(homedir(), ".pi", "run", "pi-events-daemon.pid");
}

/**
 * FileLock — O_EXCL pidfile 单活仲裁（票 38；flock 的 MVP 简化，coordinator 裁定）：
 * 创建即持锁（O_EXCL 原子），内容 = 持有者 pid。冲突 → 读 pid 探活：活 = 双启动拒绝报状态；
 * 死（kill -9 残留）= 回收重取，自愈前置。真壳 adapter（fx 唯一锁实现：单机单活由
 * pidfile+flock+epoch 足以承载，#31 daemon 存留性 POC 结论，无 fake seam）。
 */
export class FileLock {
  constructor(
    private readonly path: string,
    private readonly pid: number = process.pid,
  ) {}

  /** 获取锁：O_EXCL 创建 pidfile；EEXIST 时按持有者活性分派（活→拒绝，死→回收重试一轮）。 */
  acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.path, "wx"); // O_CREAT|O_EXCL：创建即仲裁
        try {
          writeSync(fd, `${this.pid}\n`);
        } finally {
          closeSync(fd);
        }
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const holder = this.holderPid();
        if (holder !== null && this.alive(holder)) {
          throw new Error(`daemon already running (pid ${holder}, pidfile ${this.path})`);
        }
        rmSync(this.path, { force: true }); // 死进程残留：回收后重取（活持有者不会走到这——活性已验）
      }
    }
    throw new Error(`daemon lock contended (pidfile ${this.path})`);
  }

  release(): void {
    rmSync(this.path, { force: true });
  }

  private holderPid(): number | null {
    try {
      const pid = Number(readFileSync(this.path, "utf8").trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
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
