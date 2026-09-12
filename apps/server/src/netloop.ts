/**
 * The authoritative tick loop.
 *
 * Fixed 60 Hz with an accumulator, so the simulation is decoupled from
 * `setInterval` jitter. The guard clause matters: if the process stalls — garbage
 * collection, or a synchronous call someone forgot to await — you want to drop
 * time rather than spiral into a death loop trying to catch up.
 */

import { TUNING } from '@rally/protocol';
import { log } from './log.js';

const logger = log.child('netloop');

export interface LoopStats {
  ticks: number;
  /** Ticks dropped because the process fell too far behind. */
  dropped: number;
  /** Worst single-tick duration seen, ms. */
  worstMs: number;
  /** Rolling average tick duration, ms. */
  avgMs: number;
}

export class NetLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private acc = 0;
  private last = 0;
  private stats: LoopStats = { ticks: 0, dropped: 0, worstMs: 0, avgMs: 0 };

  constructor(
    private readonly now: () => number,
    private readonly step: (dt: number, t: number) => void,
    private readonly onSweep?: (t: number) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.last = this.now();
    const dt = 1 / TUNING.net.tickHz;
    let sweepAt = this.last + 30_000;

    this.timer = setInterval(() => {
      const now = this.now();
      this.acc += (now - this.last) / 1000;
      this.last = now;

      let guard = 0;
      const began = now;
      while (this.acc >= dt && guard++ < 5) {
        this.step(dt, this.now());
        this.acc -= dt;
        this.stats.ticks++;
      }
      if (guard >= 5 && this.acc >= dt) {
        // Drop the backlog rather than chase it.
        this.stats.dropped += Math.floor(this.acc / dt);
        this.acc = 0;
      }

      const elapsed = this.now() - began;
      if (elapsed > this.stats.worstMs) this.stats.worstMs = elapsed;
      this.stats.avgMs = this.stats.avgMs * 0.98 + elapsed * 0.02;

      if (now >= sweepAt) {
        sweepAt = now + 30_000;
        this.onSweep?.(now);
        if (this.stats.dropped > 0) {
          logger.warn(
            `dropped ${this.stats.dropped} ticks so far ` +
              `(worst tick ${this.stats.worstMs.toFixed(1)}ms)`,
          );
        }
      }
    }, 4);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get snapshot(): LoopStats {
    return { ...this.stats };
  }
}
