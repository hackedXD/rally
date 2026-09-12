/**
 * The seam between the game and the commentary system.
 *
 * `GameEvent` is the only thing that crosses it: W3 emits them, W5 consumes
 * them, and neither needs to know anything else about the other. Keeping this a
 * real bus rather than a direct call means the replay recorder and the debug
 * overlay can subscribe too, without the simulation learning they exist.
 */

import type { GameEvent } from '@rally/protocol';
import { log } from './log.js';

export type EventListener = (e: GameEvent) => void;

export class EventBus {
  private listeners: EventListener[] = [];

  on(fn: EventListener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  publish(events: readonly GameEvent[]): void {
    for (const e of events) {
      for (const fn of this.listeners) {
        try {
          fn(e);
        } catch (err) {
          // A listener throwing must not stop the others, and must never
          // propagate into the tick loop that called publish().
          log.error('event listener threw', e.type, err);
        }
      }
    }
  }

  clear(): void {
    this.listeners = [];
  }
}
