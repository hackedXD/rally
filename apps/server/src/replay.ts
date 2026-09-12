/**
 * Match recorder.
 *
 * Every match can be written to a JSONL log of inputs and events. Two things make
 * that worth the twenty lines: a replay reproduces a bug deterministically
 * (`packages/sim` is pure, so the same seed and the same inputs give byte-identical
 * output), and it generates commentary test fixtures for free.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameEvent, Seat, Snapshot, SportId, SwingInput } from '@rally/protocol';
import { CONFIG } from './config.js';
import { log } from './log.js';

const logger = log.child('replay');

export type ReplayLine =
  | { k: 'start'; t: number; sport: SportId; names: [string, string]; seed: number }
  | { k: 'swing'; t: number; seat: Seat; swing: SwingInput; tServer: number }
  | { k: 'event'; t: number; e: GameEvent }
  | { k: 'snap'; t: number; s: Snapshot }
  | { k: 'end'; t: number; winner: Seat; summary: string[] };

export class ReplayRecorder {
  private path: string | null = null;
  private buffer: string[] = [];
  private snapshotEvery = 6; // ~5 Hz of snapshots is plenty to scrub with
  private snapCount = 0;

  constructor(
    private readonly room: string,
    private readonly now: () => number,
  ) {}

  start(sport: SportId, names: [string, string], seed: number): void {
    try {
      mkdirSync(CONFIG.replayDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      this.path = join(CONFIG.replayDir, `${stamp}-${this.room}-${sport}.jsonl`);
      writeFileSync(this.path, '');
      this.write({ k: 'start', t: this.now(), sport, names, seed });
      logger.info('recording to', this.path);
    } catch (err) {
      logger.warn('could not open a replay file', err);
      this.path = null;
    }
  }

  swing(seat: Seat, swing: SwingInput, tServer: number): void {
    this.write({ k: 'swing', t: this.now(), seat, swing, tServer });
  }

  event(e: GameEvent): void {
    this.write({ k: 'event', t: this.now(), e });
  }

  snapshot(s: Snapshot): void {
    if (this.snapCount++ % this.snapshotEvery !== 0) return;
    this.write({ k: 'snap', t: this.now(), s });
  }

  end(winner: Seat, summary: string[]): void {
    this.write({ k: 'end', t: this.now(), winner, summary });
    this.flush();
  }

  private write(line: ReplayLine): void {
    if (!this.path) return;
    this.buffer.push(JSON.stringify(line));
    if (this.buffer.length >= 64) this.flush();
  }

  private flush(): void {
    if (!this.path || !this.buffer.length) return;
    try {
      appendFileSync(this.path, this.buffer.join('\n') + '\n');
    } catch (err) {
      logger.warn('replay write failed', err);
      this.path = null;
    }
    this.buffer = [];
  }

  close(): void {
    this.flush();
  }
}

export function makeRecorder(room: string, now: () => number): ReplayRecorder | null {
  return CONFIG.recordReplays ? new ReplayRecorder(room, now) : null;
}
