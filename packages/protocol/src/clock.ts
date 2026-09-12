/**
 * Clock synchronisation. Server time is the only time (coding standard 6);
 * client clocks are converted at the boundary and never used for game logic.
 *
 *   Client sends PING{c0}. Server replies PONG{c0, st}. Client stamps c1.
 *   rtt    = c1 - c0
 *   offset = st - (c0 + rtt / 2)
 *   serverNow() = performance.now() + offset
 *
 * The median of a rolling window is used rather than the mean: a single wifi
 * hiccup should not shift your clock. Both web apps import this file; neither
 * reimplements it.
 */

import { TUNING } from './tuning.js';

export interface ClockSample {
  rtt: number;
  offset: number;
}

export class ClockSync {
  private samples: ClockSample[] = [];
  private offsetCache = 0;
  private rttCache = 0;
  private synced = false;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Timestamp to put in PING. */
  stamp(): number {
    return this.now();
  }

  /**
   * Feed a PONG back in. `c0` is the value we sent, `st` the server's clock at
   * the time it replied.
   */
  accept(c0: number, st: number): void {
    const c1 = this.now();
    const rtt = c1 - c0;
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 5000) return;

    // Discard samples whose rtt exceeds 2x the current median (§6.5).
    if (this.samples.length >= 3 && rtt > this.medianRtt() * 2) return;

    const offset = st - (c0 + rtt / 2);
    this.samples.push({ rtt, offset });
    while (this.samples.length > TUNING.net.clockWindow) this.samples.shift();

    this.offsetCache = median(this.samples.map((s) => s.offset));
    this.rttCache = this.medianRtt();
    this.synced = this.samples.length >= 3;
  }

  /** Current best estimate of server time. */
  serverNow(): number {
    return this.now() + this.offsetCache;
  }

  /** Convert a client timestamp to server time. */
  toServer(clientTime: number): number {
    return clientTime + this.offsetCache;
  }

  /** Convert a server timestamp to local client time. */
  toClient(serverTime: number): number {
    return serverTime - this.offsetCache;
  }

  get offset(): number {
    return this.offsetCache;
  }

  get rtt(): number {
    return this.rttCache;
  }

  get isSynced(): boolean {
    return this.synced;
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /** Spread of the offset window. A large value means an unstable network. */
  get jitter(): number {
    if (this.samples.length < 2) return 0;
    const offsets = this.samples.map((s) => s.offset);
    return Math.max(...offsets) - Math.min(...offsets);
  }

  private medianRtt(): number {
    return median(this.samples.map((s) => s.rtt));
  }

  reset(): void {
    this.samples = [];
    this.offsetCache = 0;
    this.rttCache = 0;
    this.synced = false;
  }
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Server-side clock. One monotonic source, zeroed at process start, so all
 * `Millis` values in the protocol share an epoch small enough to stay precise
 * in a float and short enough to read in a log.
 */
export function makeServerClock(hrNow: () => number): () => number {
  const epoch = hrNow();
  return () => hrNow() - epoch;
}

/** Monotonic nanosecond-resolution clock for Node. */
export function hrNowMs(): number {
  // process.hrtime.bigint() is monotonic; Date.now() is not.
  const g = globalThis as { process?: { hrtime?: { bigint?: () => bigint } } };
  const bigint = g.process?.hrtime?.bigint;
  if (bigint) return Number(bigint()) / 1e6;
  return performance.now();
}
