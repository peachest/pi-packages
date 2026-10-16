import type { Clock } from "./types.ts";

/** 真时钟薄 adapter：Date.now + Node timer，一行转发。 */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  setTimeout(fn: () => void, ms: number): { cancel(): void } {
    // Node 对 >2^31-1 的 delay 并成 1ms（never-fire 哨兵/超长 cron 会成忙循环）——钳到定时器最大窗口，
    // 超长到点由调用方到点重排轮询兜底（loops reschedule level-trigger）
    const timer = setTimeout(fn, Math.min(ms, 2_147_483_647));
    return { cancel: () => clearTimeout(timer) };
  }
}
