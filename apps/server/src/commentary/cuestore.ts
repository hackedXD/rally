/**
 * The cue store.
 *
 * A cue is a line plus, usually, the audio for it — already pushed to every
 * display and already decoded there. At event time the server sends only
 * `CUE_PLAY{id}`: forty bytes against an already-decoded AudioBuffer, so the
 * perceived latency is one network hop. Nothing else in the system can do that,
 * and it is the entire reason the cold bank exists.
 *
 * Cues are consumed on use and become unavailable for the rest of the match,
 * which is what stops the commentator repeating a cached line.
 */

import {
  TUNING,
  cueId,
  type CueClass,
  type Millis,
  type PreloadedCue,
  type Seat,
} from '@rally/protocol';

export interface StoredCue {
  cue: PreloadedCue;
  consumed: boolean;
  /** Speculative cues expire; cache and fallback cues do not. */
  expiresAt: Millis | null;
  /** Speculative cues are keyed by the outcome they predicted. */
  outcome?: string;
  /**
   * Seat the line is ABOUT, when it names somebody.
   *
   * Without this, a cached line naming one player fires when the other one wins
   * the point — "Ada takes it" as Bolt celebrates. Cue class alone is not enough
   * of a key for a bank whose whole appeal is having the names baked in.
   */
  seat?: Seat;
}

export class CueStore {
  private byId = new Map<string, StoredCue>();
  private byClass = new Map<CueClass, string[]>();
  private byOutcome = new Map<string, string>();

  add(
    cls: CueClass,
    text: string,
    audio: Uint8Array,
    durationMs: number,
    layer: PreloadedCue['layer'],
    speak: boolean,
    opts: { expiresAt?: Millis; outcome?: string; seat?: Seat } = {},
  ): PreloadedCue {
    const cue: PreloadedCue = {
      id: cueId(layer === 'cache' ? 'c' : layer === 'speculative' ? 's' : 'f'),
      text,
      audioB64: audio.length ? Buffer.from(audio).toString('base64') : '',
      durationMs,
      layer,
      cls,
      speak,
    };
    this.byId.set(cue.id, {
      cue,
      consumed: false,
      expiresAt: opts.expiresAt ?? null,
      outcome: opts.outcome,
      seat: opts.seat,
    });
    const list = this.byClass.get(cls) ?? [];
    list.push(cue.id);
    this.byClass.set(cls, list);
    if (opts.outcome) this.byOutcome.set(opts.outcome, cue.id);
    return cue;
  }

  /**
   * An unconsumed, unexpired cue for this class.
   *
   * A cue that names a specific player is only eligible when that player is the
   * one the event is about. Seat-agnostic cues are always eligible, which is why
   * the static fallbacks name nobody.
   */
  take(
    cls: CueClass,
    now: Millis,
    opts: { seat?: Seat; layer?: PreloadedCue['layer'] } = {},
  ): StoredCue | null {
    const ids = this.byClass.get(cls);
    if (!ids) return null;
    let best: StoredCue | null = null;
    for (const id of ids) {
      const s = this.byId.get(id);
      if (!s || s.consumed) continue;
      if (s.expiresAt !== null && now > s.expiresAt) continue;
      if (opts.layer && s.cue.layer !== opts.layer) continue;
      if (s.seat !== undefined && opts.seat !== undefined && s.seat !== opts.seat) continue;
      if (!best || score(s, opts.seat) > score(best, opts.seat)) best = s;
    }
    if (best) best.consumed = true;
    return best;
  }

  /** The speculative cue that predicted this outcome, if it is still valid. */
  takeOutcome(outcome: string, now: Millis): StoredCue | null {
    const id = this.byOutcome.get(outcome);
    if (!id) return null;
    const s = this.byId.get(id);
    if (!s || s.consumed) return null;
    if (s.expiresAt !== null && now > s.expiresAt) return null;
    s.consumed = true;
    return s;
  }

  /** Drop every speculative cue: the rally resolved and they are now stale. */
  clearSpeculative(): void {
    for (const [id, s] of this.byId) {
      if (s.cue.layer === 'speculative') {
        this.byId.delete(id);
        const list = this.byClass.get(s.cue.cls);
        if (list) this.byClass.set(s.cue.cls, list.filter((x) => x !== id));
      }
    }
    this.byOutcome.clear();
  }

  /**
   * Mark a cue used, whoever played it.
   *
   * `take` consumes what it hands out, but the live layer adds a cue and plays it
   * directly — and a cue that was played but not consumed is still sitting in the
   * store for the arbiter to pick up and play a second time. Making this callable
   * from the one place that plays anything turns "a cue is spoken at most once"
   * into an invariant rather than a property of each call site.
   */
  consume(id: string): void {
    const s = this.byId.get(id);
    if (s) s.consumed = true;
  }

  /** How long this cue takes to say, ms. 0 if it is not a cue we know. */
  durationOf(id: string): number {
    return this.byId.get(id)?.cue.durationMs ?? 0;
  }

  has(cls: CueClass, now: Millis): boolean {
    const ids = this.byClass.get(cls);
    if (!ids) return false;
    return ids.some((id) => {
      const s = this.byId.get(id);
      return s && !s.consumed && (s.expiresAt === null || now <= s.expiresAt);
    });
  }

  get size(): number {
    return this.byId.size;
  }

  get unconsumed(): number {
    let n = 0;
    for (const s of this.byId.values()) if (!s.consumed) n++;
    return n;
  }

  reset(): void {
    this.byId.clear();
    this.byClass.clear();
    this.byOutcome.clear();
  }

  /** Expiry for a speculative cue generated now. */
  static speculativeExpiry(now: Millis): Millis {
    return now + TUNING.commentary.queueStaleMs * 4;
  }
}

function rank(layer: PreloadedCue['layer']): number {
  return layer === 'speculative' ? 3 : layer === 'cache' ? 2 : 1;
}

/** Prefer a higher layer, and prefer a line that actually names the right player. */
function score(s: StoredCue, seat?: Seat): number {
  return rank(s.cue.layer) * 2 + (s.seat !== undefined && s.seat === seat ? 1 : 0);
}
