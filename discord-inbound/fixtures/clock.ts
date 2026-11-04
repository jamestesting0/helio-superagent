import type { TurnClock } from "../intake/turns.ts";

/** Deterministic timer queue shared by assembler and process-boundary fixtures. */
export class FakeClock implements TurnClock {
  private time: number;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  constructor(now = 0) { this.time = now; }
  now = (): number => this.time;
  setTimeout = (callback: () => void, delay: number): number => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  };
  clearTimeout = (id: number): void => { this.timers.delete(id); };

  advance(milliseconds: number): void {
    const target = this.time + milliseconds;
    for (;;) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = target;
  }
}
