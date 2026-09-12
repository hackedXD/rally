/**
 * The Commentary Director.
 *
 * Two goals are in tension: *instant* and *novel*. Cached lines are instant but
 * generic; generated lines are specific but slow. The resolution is three layers
 * running at different points in the rally clock, each covering the other's
 * weakness:
 *
 *   L0 cold bank    written during the lobby, pushed to displays as audio, fires
 *                   in one network hop because there is nothing left to do but
 *                   play an already-decoded buffer
 *   L1 speculative  generated mid-rally for each way the rally could resolve;
 *                   two thirds are thrown away, which is the correct trade
 *   L2 live         runs in dead time after a point, where 1.5 s is free, and
 *                   carries the full narrative so it can say something true
 *
 * Arbitration, the budget guard and the fallback chain all live here. Every layer
 * times out rather than blocking: the APIs will fail exactly once, on stage.
 */

import {
  TUNING,
  lane,
  type CueClass,
  type GameEvent,
  type MatchPhase,
  type Millis,
  type PreloadedCue,
  type S2D,
  type ScoreState,
  type Seat,
  type SportId,
} from '@rally/protocol';
import type { MatchStats, SportModule } from '@rally/sim';
import { CONFIG } from '../config.js';
import { log } from '../log.js';
import { classifyCue, isDeadTimeTrigger } from './classify.js';
import { CueStore } from './cuestore.js';
import { STATIC_LINES } from './fallback.js';
import { filterLine } from './filter.js';
import { Narrative } from './narrative.js';
import {
  selectProviders,
  type LineContext,
  type ProviderSet,
  type SpecOutcome,
} from './providers/index.js';
import { estimateDurationMs } from './providers/voice.js';

const logger = log.child('director');

/** Cue classes worth pre-writing. Roughly 40 lines once multiplied out. */
const BANK_CLASSES: CueClass[] = [
  'match.intro',
  'serve.normal',
  'whiff.bad',
  'whiff.repeat',
  'net.hit',
  'out.long',
  'rally.long',
  'rally.epic',
  'hit.smash',
  'hit.dink',
  'hit.lob',
  'point.close',
  'point.blowout',
  'point.winner',
  'streak',
  'comeback',
  'gamepoint',
  'match.end',
];

export interface DirectorHost {
  sport: SportModule;
  names(): [string, string];
  now(): Millis;
  stats(): MatchStats;
  score(): ScoreState;
  phase(): MatchPhase;
  rally(): number;
  broadcast(msg: S2D): void;
  broadcastAudio(cueId: string, bytes: Uint8Array): void;
}

export interface DirectorStatus {
  writer: string;
  voice: string;
  banked: number;
  spoken: number;
  charsUsed: number;
  budgetCapped: boolean;
  bits: string[];
  facts: string[];
}

export class CommentaryDirector {
  private providers: ProviderSet;
  private store = new CueStore();
  private narrative: Narrative;
  private lastSpokeAt = -1e9;
  /**
   * Server time at which the display will have finished saying everything it has
   * been asked to say.
   *
   * The display never interrupts a line now, so it plays what it is sent
   * back-to-back and this tracks the end of that queue. The match reads it and
   * holds the next serve, which is what makes a line land in a gap instead of
   * under a serve. Kept here rather than reported back by the display because
   * the server is the authority and there can be two displays: waiting on the
   * slower of two clients would make the game's pace a function of whose laptop
   * is busier.
   */
  private speakingUntil = -1e9;
  private spoken = 0;
  private charsUsed = 0;
  private budgetCapped = false;
  private hitsSinceSpec = 0;
  private specInFlight = 0;
  private liveInFlight = false;
  private muted = false;
  private disposed = false;
  private prepared = false;

  constructor(
    private readonly host: DirectorHost,
    seed: number,
  ) {
    this.providers = selectProviders(seed);
    this.narrative = new Narrative(host.sport.displayName, host.names());
  }

  get status(): DirectorStatus {
    return {
      writer: this.providers.writer.name,
      voice: this.providers.voice.name,
      banked: this.store.unconsumed,
      spoken: this.spoken,
      charsUsed: this.charsUsed,
      budgetCapped: this.budgetCapped,
      bits: this.narrative.bitsList,
      facts: [],
    };
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  // ── Layer 0: the cold bank ──────────────────────────────────────────────────

  /**
   * Write and synthesise the cold bank, then push every clip to the displays
   * before the match starts. Budget about 15 seconds with real APIs; the offline
   * writer returns instantly.
   *
   * Never rejects. A failed cold bank means the fallback chain does more work.
   */
  async prepare(): Promise<void> {
    if (this.prepared || this.disposed) return;
    this.prepared = true;
    this.narrative.setNames(this.host.names());

    const progress = (text: string, p: number, done = false) =>
      this.host.broadcast({ t: 'LOBBY_STATUS', text, progress: p, done });

    progress('Briefing the commentator…', 0.1);

    // Static fallbacks go in first, so the chain has a floor even if everything
    // after this point fails.
    const preload: PreloadedCue[] = [];
    for (const line of STATIC_LINES) {
      const r = await this.providers.voice.synth(line.text).catch(() => null);
      preload.push(
        this.store.add(
          line.cls,
          line.text,
          r?.audio ?? new Uint8Array(0),
          r?.durationMs ?? 1200,
          'fallback',
          r?.speak ?? true,
        ),
      );
      this.narrative.claim(line.text);
    }
    progress('Warming up…', 0.25);

    let bank = new Map<CueClass, string[]>();
    try {
      const perClass = Math.max(2, Math.round(TUNING.commentary.coldBankSize / BANK_CLASSES.length) + 1);
      bank = await this.providers.writer.bank(
        this.narrative.snapshot(this.host.stats(), [0, 0], 0, 'lobby', 0),
        BANK_CLASSES,
        perClass,
      );
    } catch (err) {
      logger.warn('cold bank failed, falling back to the offline writer', err);
    }
    if (bank.size === 0 && this.providers.writer !== this.providers.offline) {
      // The model failed. The offline writer cannot.
      bank = await this.providers.offline.bank(
        this.narrative.snapshot(this.host.stats(), [0, 0], 0, 'lobby', 0),
        BANK_CLASSES,
        3,
      );
    }

    progress('Writing the script…', 0.55);

    // Expand placeholders per seat, then dedupe before synthesis: paying to
    // voice a duplicate is the one cost that buys literally nothing.
    const names = this.host.names();
    const jobs: { cls: CueClass; text: string; seat?: Seat }[] = [];
    for (const [cls, lines] of bank) {
      for (const raw of lines) {
        const check = filterLine(raw, true);
        if (!check.ok) continue;
        for (const variant of expandForSeats(check.text, names)) {
          const r = filterLine(variant.text);
          if (!r.ok) continue;
          if (!this.narrative.claim(r.text)) continue;
          jobs.push({ cls, text: r.text, seat: variant.seat });
        }
      }
    }

    // Concurrency is enforced process-wide inside the voice provider — the limit
    // belongs to the API key, not to this room. What the batch size controls here
    // is how often progress is reported and how often a chunk of finished cues is
    // pushed to the displays.
    const batch = Math.max(1, CONFIG.elevenlabs.batchSize);
    const cues: PreloadedCue[] = [];
    for (let i = 0; i < jobs.length && !this.disposed; i += batch) {
      const slice = jobs.slice(i, i + batch);
      const results = await Promise.all(
        slice.map((j) =>
          this.providers.voice.synth(j.text).catch(() => ({
            audio: new Uint8Array(0),
            durationMs: 1200,
            speak: true,
          })),
        ),
      );
      for (let k = 0; k < slice.length; k++) {
        const j = slice[k];
        const r = results[k];
        this.charsUsed += j.text.length;
        cues.push(
          this.store.add(j.cls, j.text, r.audio, r.durationMs, 'cache', r.speak, {
            seat: j.seat,
          }),
        );
      }
      // Push each chunk as it lands rather than the whole bank at the end. On a
      // rate-limited key the bank can take longer than the lobby does, and a cue
      // that arrives during the first rally is still worth having — whereas one
      // held back until the last line is synthesised is worth nothing.
      const chunk = [...(i === 0 ? preload : []), ...cues.slice(i)];
      if (chunk.length) this.host.broadcast({ t: 'CUE_PRELOAD', cues: chunk });
      progress('Recording the lines…', 0.55 + 0.4 * ((i + batch) / Math.max(1, jobs.length)));
    }

    if (this.disposed) return;

    // The static fallbacks still need pushing if there was nothing else to send.
    if (!jobs.length && preload.length) {
      this.host.broadcast({ t: 'CUE_PRELOAD', cues: preload });
    }
    logger.info(
      `cold bank ready: ${cues.length} written + ${preload.length} static, ` +
        `writer=${this.providers.writer.name} voice=${this.providers.voice.name}`,
    );
    progress('Ready.', 1, true);
  }

  // ── Event intake ────────────────────────────────────────────────────────────

  onEvent(e: GameEvent): void {
    if (this.disposed) return;
    this.narrative.observe(e, this.host.stats());

    if (e.type === 'hit') {
      this.hitsSinceSpec++;
      if (this.hitsSinceSpec >= TUNING.commentary.speculativeEveryNHits) {
        this.hitsSinceSpec = 0;
        void this.runSpeculative();
      }
    }
    if (e.type === 'serve') {
      this.hitsSinceSpec = 0;
      this.store.clearSpeculative();
      void this.runSpeculative();
    }

    const cls = classifyCue(e);
    if (cls) this.react(e, cls);

    // Dead time: after the point reaction has fired, write something novel.
    if (isDeadTimeTrigger(e)) void this.runLive(e);
  }

  /**
   * Arbitration (design §8.5.5).
   *
   *   salience too low ............................ silence
   *   a speculative cue predicted this ............ play it
   *   the cold bank has an unconsumed line ........ play it
   *   nothing ..................................... static fallback, then silence
   *
   * Never let two cues play at once, and never talk over yourself: a commentator
   * who fills every gap becomes noise inside thirty seconds.
   *
   * "At once" now means what it says. The display no longer interrupts a line to
   * start a newer one, so dispatching while the last is still being spoken does
   * not overlap them — it queues the new one and plays it late, describing a
   * game state that has moved on. Better to stay quiet and let the moment pass.
   *
   * Priority 3 is the exception and must be: the point itself, and the end of
   * the match. Those queue rather than being dropped, and the match holds the
   * next serve until they have been said.
   */
  private react(e: GameEvent, cls: CueClass): void {
    if (this.muted) return;
    const now = this.host.now();
    if (e.priority < 3) {
      if (now < this.speakingUntil) return;
      if (now - this.lastSpokeAt < TUNING.commentary.minGapMs) return;
    }

    const outcome = outcomeKeyFor(e);
    const spec = outcome ? this.store.takeOutcome(outcome, now) : null;
    // The subject matters: a cached line naming one player must never fire when
    // the other one is the story.
    const chosen = spec ?? this.store.take(cls, now, { seat: subjectOf(e) });
    if (!chosen) {
      logger.debug('no cue available for', cls);
      return;
    }

    this.play(chosen.cue.id, e.priority, chosen.cue.text);
    if (e.type === 'point' || e.type === 'match_end') this.store.clearSpeculative();
  }

  private play(id: string, priority: GameEvent['priority'], text: string): void {
    // Everything that speaks goes through here, so consuming here is what makes
    // "no line twice in a match" true rather than merely intended.
    this.store.consume(id);
    this.host.broadcast({ t: 'CUE_PLAY', id, priority });
    this.lastSpokeAt = this.host.now();
    this.claimAir(this.store.durationOf(id) || estimateDurationMs(text));
    this.spoken++;
    this.narrative.spoke(text);
  }

  /**
   * Book `ms` of speaking time, starting when the queue currently empties.
   *
   * Appends rather than overwrites, because the display plays queued lines
   * back-to-back: two cues dispatched in the same tick occupy the sum of their
   * durations, not the longer of them.
   */
  private claimAir(ms: number): void {
    const now = this.host.now();
    const from = Math.max(now, this.speakingUntil);
    /*
     * The cap is applied HERE, when the claim is made, and is therefore an
     * absolute deadline.
     *
     * Capping at read time instead — `min(speakingUntil, now + max)` — looks
     * equivalent and is a deadlock. Once enough lines are booked to push past
     * the ceiling, that expression returns a time that is always `max` ahead of
     * whenever you ask, so the deadline slides forward forever, the point phase
     * never ends, and the match never serves again. Both full-match tests hung
     * on exactly that.
     */
    this.speakingUntil = Math.min(
      from + Math.max(0, ms) + TUNING.commentary.holdTailMs,
      now + TUNING.commentary.holdPlayMaxMs,
    );
  }

  /**
   * Server time until which play should wait for the commentator.
   *
   * Already bounded by `claimAir`, so this is a plain read: a bad duration
   * estimate or a provider that returns a monologue slows the game down by at
   * most `holdPlayMaxMs`, and cannot stop it.
   */
  airtimeUntil(): Millis {
    return this.muted ? this.host.now() : this.speakingUntil;
  }

  /** How long to wait for the current line to finish, at least `minMs`. */
  private msUntilClear(minMs: number): number {
    const remaining = this.speakingUntil - this.host.now();
    return Math.max(minMs, Math.min(remaining, TUNING.commentary.holdPlayMaxMs));
  }

  // ── Layer 1: speculative ────────────────────────────────────────────────────

  /**
   * During a rally the outcome space is small: A wins, B wins, or it goes long.
   * So generate for all three before it happens, push them as preloaded cues, and
   * play the matching one on resolution. Roughly two thirds are thrown away — a
   * few pennies of quota to buy a 1.5 second latency reduction at the exact
   * moment the demo is most exciting.
   */
  private async runSpeculative(): Promise<void> {
    if (this.disposed || this.muted || this.budgetCheck()) return;
    if (this.specInFlight >= TUNING.commentary.speculativeInFlight) return;
    const names = this.host.names();
    const outcomes: SpecOutcome[] = [
      { key: 'win0', describe: `${names[0]} wins the rally`, cls: 'point.close' },
      { key: 'win1', describe: `${names[1]} wins the rally`, cls: 'point.close' },
      { key: 'long', describe: 'the rally keeps going and becomes notable', cls: 'rally.long' },
    ];

    this.specInFlight++;
    const started = this.host.now();
    try {
      const lines = await withTimeout(
        this.providers.writer.speculate(this.currentNarrative(), outcomes),
        TUNING.commentary.speculativeTimeoutMs,
        new Map<string, string>(),
      );
      if (this.disposed || lines.size === 0) return;

      const cues = [];
      for (const o of outcomes) {
        const raw = lines.get(o.key);
        if (!raw) continue;
        const r = filterLine(raw);
        if (!r.ok || !this.narrative.claim(r.text)) continue;
        const synth = await this.providers.voice.synth(r.text).catch(() => null);
        this.charsUsed += r.text.length;
        cues.push(
          this.store.add(
            o.cls,
            r.text,
            synth?.audio ?? new Uint8Array(0),
            synth?.durationMs ?? 1200,
            'speculative',
            synth?.speak ?? true,
            {
              expiresAt: CueStore.speculativeExpiry(this.host.now()),
              outcome: o.key,
              seat: o.key === 'win0' ? 0 : o.key === 'win1' ? 1 : undefined,
            },
          ),
        );
      }
      if (cues.length && !this.disposed) {
        this.host.broadcast({ t: 'CUE_PRELOAD', cues });
        logger.debug(
          `speculative: ${cues.length} cues in ${Math.round(this.host.now() - started)}ms`,
        );
      }
    } catch (err) {
      logger.debug('speculative dropped', err);
    } finally {
      this.specInFlight--;
    }
  }

  // ── Layer 2: live ───────────────────────────────────────────────────────────

  /**
   * The novel content. Runs in dead time, where 1.5 seconds is free.
   *
   * With a streaming voice the text stream is piped straight into the synthesis
   * socket and the audio arrives as binary frames. Without one, the line is
   * written, synthesised and played as a normal cue — identical from the
   * display's point of view.
   */
  private async runLive(e: GameEvent): Promise<void> {
    if (this.disposed || this.muted || this.liveInFlight || this.budgetCheck()) return;
    const cls = classifyCue(e);
    if (!cls) return;

    this.liveInFlight = true;
    try {
      /*
       * Wait for the airwaves, not for a fixed guess at them.
       *
       * This used to sleep a flat 1400 ms to "give the cached reaction its
       * moment". A spoken reaction is two seconds or more, so the live layer —
       * whose entire job is filling silence — reliably started talking over the
       * line it was supposed to be following. It was the last thing still
       * cutting commentary off after the display stopped interrupting, and it
       * bypassed the arbitration in `react` entirely by calling `play` direct.
       */
      await sleep(this.msUntilClear(Math.min(1400, TUNING.match.pointPauseMs * 0.45)));
      if (this.disposed || this.muted) return;

      const ctx: LineContext = {
        cls,
        narrative: this.currentNarrative(),
        subject: e.seat,
        data: e.data,
      };

      const streaming =
        this.providers.voice.producesAudio &&
        typeof this.providers.writer.liveStream === 'function';

      if (streaming) {
        const ok = await this.streamLive(ctx, e);
        if (ok) return;
      }

      let result = await withTimeout(
        this.providers.writer.live(ctx),
        TUNING.commentary.liveTimeoutMs,
        { line: '', newBit: null },
      );
      // Fallback chain: the model failed or repeated itself, so ask the writer
      // that cannot fail.
      if (!result.line || this.narrative.seen(result.line)) {
        result = await this.providers.offline.live(ctx);
      }
      const r = filterLine(result.line);
      if (!r.ok || !this.narrative.claim(r.text)) return;

      this.charsUsed += r.text.length;
      if (result.newBit) this.narrative.addBit(result.newBit);

      const synth = await this.providers.voice.synth(r.text).catch(() => null);
      const cue = this.store.add(
        cls,
        r.text,
        synth?.audio ?? new Uint8Array(0),
        synth?.durationMs ?? 1400,
        'cache',
        synth?.speak ?? true,
        { seat: subjectOf(e) },
      );
      if (this.disposed) return;
      // Generating took time, and somebody may have started talking during it.
      // The cue stays in the store unconsumed, so `react` can still use it later
      // rather than the work being thrown away.
      if (this.host.now() < this.speakingUntil) return;
      this.host.broadcast({ t: 'CUE_PRELOAD', cues: [cue] });
      this.play(cue.id, 2, r.text);
    } catch (err) {
      logger.debug('live layer dropped', err);
    } finally {
      this.liveInFlight = false;
    }
  }

  /** Pipe the text stream into the voice socket and the audio out as frames. */
  private async streamLive(ctx: LineContext, e: GameEvent): Promise<boolean> {
    // Same rule as every other layer: never start on top of a line in progress.
    if (this.host.now() < this.speakingUntil) return false;
    const textStream = this.providers.writer.liveStream?.(ctx);
    if (!textStream) return false;

    const id = `live-${Date.now().toString(36)}`;
    let sentAny = false;
    let transcript = '';

    // Tee the text so the subtitle and the dedupe ledger see it too.
    const tee = async function* (): AsyncIterable<string> {
      for await (const piece of textStream) {
        transcript += piece;
        yield piece;
      }
    };

    try {
      for await (const bytes of this.providers.voice.streamSynth(tee())) {
        if (this.disposed) break;
        if (!sentAny) {
          this.host.broadcast({
            t: 'CUE_STREAM_BEGIN',
            id,
            priority: e.priority,
            mime: 'audio/mpeg',
          });
          sentAny = true;
          this.lastSpokeAt = this.host.now();
          // Provisional: the stream has started and the length is not yet known.
          // Corrected from the real transcript once it ends.
          this.claimAir(1200);
        }
        this.host.broadcastAudio(id, bytes);
      }
    } catch (err) {
      logger.warn('live stream failed', err);
    }

    if (!sentAny) return false;
    const r = filterLine(transcript);
    if (r.ok) {
      this.host.broadcast({ t: 'CUE_TEXT', id, text: r.text });
      this.narrative.claim(r.text);
      this.narrative.spoke(r.text);
      this.charsUsed += r.text.length;
      // The provisional 1200 ms booked at CUE_STREAM_BEGIN was a guess made
      // before a single word existed. Now the line is known, book the rest.
      const real = estimateDurationMs(r.text);
      if (real > 1200) this.claimAir(real - 1200);
    }
    this.host.broadcast({ t: 'CUE_STREAM_END', id });
    this.spoken++;
    return true;
  }

  // ── Budget and lifecycle ────────────────────────────────────────────────────

  /**
   * Budget guard. A runaway speculative loop can burn a quota in minutes, so on
   * breach the Director drops to Layer 0 only and says so loudly.
   */
  private budgetCheck(): boolean {
    if (this.charsUsed <= TUNING.commentary.maxCharsPerMatch) return false;
    if (!this.budgetCapped) {
      this.budgetCapped = true;
      logger.warn(
        `commentary budget exhausted (${this.charsUsed} chars). ` +
          'Dropping to the cold bank for the rest of this match.',
      );
    }
    return true;
  }

  private currentNarrative() {
    return this.narrative.snapshot(
      this.host.stats(),
      [...this.host.score().points] as [number, number],
      this.host.score().server,
      this.host.phase(),
      this.host.rally(),
    );
  }

  reset(): void {
    this.store.reset();
    this.narrative.reset();
    this.providers.offline.reset();
    this.lastSpokeAt = -1e9;
    this.speakingUntil = -1e9;
    this.spoken = 0;
    this.charsUsed = 0;
    this.budgetCapped = false;
    this.hitsSinceSpec = 0;
    this.prepared = false;
  }

  dispose(): void {
    this.disposed = true;
    this.store.reset();
  }
}

/**
 * Instantiate a bank line for each seat it could be about.
 *
 * A line with no placeholder names nobody and is usable for either player, so it
 * is stored once, untagged.
 */
function expandForSeats(
  text: string,
  names: [string, string],
): { text: string; seat?: Seat }[] {
  if (!text.includes('{player}') && !text.includes('{opponent}')) {
    // A writer that ignored the placeholder instruction and baked in one name has
    // still written a seat-specific line. Tag it rather than letting it fire for
    // whoever happens to be the story. Naming BOTH players is symmetric and safe.
    const mentions = ([0, 1] as Seat[]).filter(
      (seat) => names[lane(seat)] && text.includes(names[lane(seat)]),
    );
    return mentions.length === 1 ? [{ text, seat: mentions[0] }] : [{ text }];
  }
  return ([0, 1] as Seat[]).map((seat) => ({
    seat,
    text: text
      .split('{player}')
      .join(names[lane(seat)])
      .split('{opponent}')
      .join(names[lane(seat) === 0 ? 1 : 0]),
  }));
}

/** Seat an event is about, for matching a cue that names somebody. */
function subjectOf(e: GameEvent): Seat | undefined {
  if (e.type === 'point' || e.type === 'match_end') return Number(e.data.winner) as Seat;
  return e.seat;
}

/** Which speculative outcome an event resolves, if any. */
function outcomeKeyFor(e: GameEvent): string | null {
  if (e.type === 'point') return `win${lane(Number(e.data.winner) as Seat)}`;
  if (e.type === 'rally_milestone') return 'long';
  return null;
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type { SportId };
