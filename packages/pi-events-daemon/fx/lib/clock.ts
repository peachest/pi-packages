import type { Clock } from "./types.ts";

/** 真时钟薄 adapter：Date.now + Node timer，一行转发。 */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  setTimeout(fn: () => void, ms: number): { cancel(): void } {
    const timer = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(timer) };
  }
}
