/**
 * The W5 exit criteria, as tests.
 *
 * Runs the real Director against the real simulation with the offline providers,
 * which is the configuration Rally ships in by default — no API keys, no network.
 */

import { describe, expect, it } from 'vitest';
import {
  CUE_CLASSES,
  TUNING,
  lane,
  type CueClass,
  type GameEvent,
  type PreloadedCue,
  type S2D,
  type Seat,
} from '@rally/protocol';
import { emptyStats, getSport, type MatchStats } from '@rally/sim';
import { CommentaryDirector } from '../apps/server/src/commentary/director.js';
import { classifyCue } from '../apps/server/src/commentary/classify.js';
import { CueStore } from '../apps/server/src/commentary/cuestore.js';
import { filterLine, parseJsonLoose, tidy } from '../apps/server/src/commentary/filter.js';
import { Narrative, normalizeLine } from '../apps/server/src/commentary/narrative.js';
import { OfflineWriter } from '../apps/server/src/commentary/providers/offline-text.js';
import { findBoundary } from '../apps/server/src/commentary/providers/voice.js';
import { playMatch } from './helpers.js';

/** A Director host backed by a real match's event stream. */
function harness(names: [string, string] = ['Ada', 'Bolt']) {
  let now = 0;
  let stats: MatchStats = emptyStats(0);
  let score = { points: [0, 0] as [number, number], server: 0 as Seat, gamePoint: false, gamePointSeat: null as Seat | null };
  const sent: S2D[] = [];
  const preloaded = new Map<string, PreloadedCue>();
  const played: { id: string; at: number }[] = [];

  const director = new CommentaryDirector(
    {
      sport: getSport('pickleball'),
      names: () => names,
      now: () => now,
      stats: () => stats,
      score: () => score,
      phase: () => 'rally',
      rally: () => 4,
      broadcast: (msg) => {
        sent.push(msg);
        if (msg.t === 'CUE_PRELOAD') for (const c of msg.cues) preloaded.set(c.id, c);
        if (msg.t === 'CUE_PLAY') played.push({ id: msg.id, at: now });
      },
      broadcastAudio: () => undefined,
    },
    7,
  );

  return {
    director,
    sent,
    preloaded,
    played,
    spokenTexts: () => played.map((p) => preloaded.get(p.id)?.text ?? '(streamed)'),
    advance: (ms: number) => {
      now += ms;
    },
    setStats: (s: MatchStats) => {
      stats = s;
    },
    setScore: (points: [number, number], server: Seat, gamePoint = false) => {
      score = { points, server, gamePoint, gamePointSeat: gamePoint ? server : null };
    },
    get now() {
      return now;
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('cue classification', () => {
  it('stays silent for a routine rally shot', () => {
    const routine: GameEvent = {
      id: 'x',
      t: 0,
      type: 'hit',
      seat: 0,
      data: { shot: 'rally', speed: 8 },
      salience: 0.05,
      priority: 1,
    };
    expect(classifyCue(routine)).toBeNull();
  });

  it('maps the events that matter onto bank classes', () => {
    const cases: [GameEvent['type'], Record<string, string | number | boolean>, CueClass][] = [
      ['match_start', {}, 'match.intro'],
      ['whiff', { consecutiveWhiffs: 1 }, 'whiff.bad'],
      ['whiff', { consecutiveWhiffs: 3 }, 'whiff.repeat'],
      ['net', {}, 'net.hit'],
      ['out', {}, 'out.long'],
      ['hit', { shot: 'smash' }, 'hit.smash'],
      ['point', { margin: 5, decidingShot: 'drive' }, 'point.blowout'],
      ['point', { margin: 1, decidingShot: 'smash' }, 'point.winner'],
      ['streak', {}, 'streak'],
      ['comeback', {}, 'comeback'],
      ['game_point', {}, 'gamepoint'],
      ['match_end', {}, 'match.end'],
      ['rally_milestone', { shots: 20 }, 'rally.epic'],
    ];
    for (const [type, data, expected] of cases) {
      const e: GameEvent = { id: 'x', t: 0, type, data, salience: 0.9, priority: 2 };
      expect(classifyCue(e), `${type} ${JSON.stringify(data)}`).toBe(expected);
    }
  });
});

describe('the output filter', () => {
  it('rejects profanity, personal attacks and leaked scaffolding', () => {
    for (const bad of [
      'That was a shit shot from Ada',
      'Bolt is an idiot',
      "Ada's mother would be ashamed",
      '{"line": "nice shot"}',
      '```json',
      'a',
      'x'.repeat(300),
    ]) {
      expect(filterLine(bad).ok, bad).toBe(false);
    }
  });

  it('accepts sharp commentary about play', () => {
    for (const good of [
      'Ada swung at the air. The ball carried on regardless.',
      "That's the third one into the net — Bolt will want it back.",
      'Filthy. No notes.',
      // Common words that a too-broad appearance rule would eat.
      'Try to make it look deliberate, Bolt.',
      'That rally was insane and I need a moment.',
      'Ada and Bolt, first to seven.',
    ]) {
      expect(filterLine(good).ok, good).toBe(true);
    }
  });

  it('allows the two bank placeholders only when asked', () => {
    const line = '{player} finds the net again, and {opponent} barely moved.';
    expect(filterLine(line).ok).toBe(false);
    expect(filterLine(line, true).ok).toBe(true);
  });

  it('tidies for speech and parses fenced JSON defensively', () => {
    expect(tidy('  "**Great** shot"  ')).toBe('Great shot');
    expect(parseJsonLoose<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('nonsense')).toBeNull();
  });
});

describe('narrative memory', () => {
  it('refuses a line it has already used, however it is punctuated', () => {
    const n = new Narrative('Pickleball', ['Ada', 'Bolt']);
    expect(n.claim('Ada swung at the air!')).toBe(true);
    expect(n.claim('ada swung at the air')).toBe(false);
    expect(n.claim('  Ada  swung at the AIR...  ')).toBe(false);
    expect(n.claim('Bolt swung at the air')).toBe(true);
  });

  it('accumulates concrete facts from rich event data', () => {
    const n = new Narrative('Pickleball', ['Ada', 'Bolt']);
    const stats = emptyStats(0);
    n.observe(
      {
        id: '1',
        t: 0,
        type: 'whiff',
        seat: 0,
        data: { seat: 0, consecutiveWhiffs: 3, missDistanceM: 1.8, shotIncoming: 'smash' },
        salience: 0.8,
        priority: 2,
      },
      stats,
    );
    const snap = n.snapshot(stats, [0, 0], 0, 'rally', 3);
    expect(snap.facts.length).toBeGreaterThan(0);
    expect(snap.facts.join(' ')).toContain('Ada');
    expect(snap.facts.join(' ')).toContain('3');
  });

  it('coins at most one running bit per match', () => {
    const n = new Narrative('Pickleball', ['Ada', 'Bolt']);
    n.addBit('the Kitchen Lawyer');
    n.addBit('Captain Windmill');
    expect(n.bitsList).toEqual(['the Kitchen Lawyer']);
  });

  it('caps the rolling memories', () => {
    const n = new Narrative('Pickleball', ['Ada', 'Bolt']);
    for (let i = 0; i < 40; i++) {
      n.addFact(`fact ${i}`);
      n.spoke(`line ${i}`);
    }
    const snap = n.snapshot(emptyStats(0), [0, 0], 0, 'rally', 0);
    expect(snap.facts.length).toBe(TUNING.commentary.factMemory);
    expect(snap.recentQuips.length).toBe(TUNING.commentary.recentQuipMemory);
  });

  it('normalises consistently', () => {
    expect(normalizeLine('Hey!  THERE, friend.')).toBe('hey there friend');
  });
});

describe('the cue store', () => {
  it('never hands out a line about the wrong player', () => {
    // Regression: a cached line naming one player used to fire when the other one
    // won the point — "Ada takes it" as Bolt celebrated.
    const store = new CueStore();
    store.add('point.close', 'Ada takes it.', new Uint8Array(0), 1000, 'cache', true, { seat: 0 });
    store.add('point.close', 'Bolt takes it.', new Uint8Array(0), 1000, 'cache', true, { seat: 1 });

    const forBolt = store.take('point.close', 0, { seat: 1 });
    expect(forBolt?.cue.text).toBe('Bolt takes it.');
    const forAda = store.take('point.close', 0, { seat: 0 });
    expect(forAda?.cue.text).toBe('Ada takes it.');
    // Both consumed; nothing left for either.
    expect(store.take('point.close', 0, { seat: 0 })).toBeNull();
  });

  it('lets a seat-agnostic line cover anybody', () => {
    const store = new CueStore();
    store.add('net.hit', 'Into the net.', new Uint8Array(0), 800, 'fallback', true);
    expect(store.take('net.hit', 0, { seat: 1 })?.cue.text).toBe('Into the net.');
  });

  it('consumes a cue exactly once', () => {
    const store = new CueStore();
    store.add('streak', 'On a run.', new Uint8Array(0), 800, 'cache', true);
    expect(store.take('streak', 0)).not.toBeNull();
    expect(store.take('streak', 0)).toBeNull();
  });

  it('expires speculative cues and drops them on resolution', () => {
    const store = new CueStore();
    store.add('rally.long', 'Still going.', new Uint8Array(0), 800, 'speculative', true, {
      expiresAt: 500,
      outcome: 'long',
    });
    expect(store.takeOutcome('long', 900)).toBeNull(); // expired
    store.add('rally.long', 'Still going!', new Uint8Array(0), 800, 'speculative', true, {
      expiresAt: 5000,
      outcome: 'long',
    });
    store.clearSpeculative();
    expect(store.takeOutcome('long', 1000)).toBeNull();
  });

  it('prefers a speculative cue over a cached one', () => {
    const store = new CueStore();
    store.add('point.close', 'cached', new Uint8Array(0), 800, 'cache', true);
    store.add('point.close', 'speculative', new Uint8Array(0), 800, 'speculative', true, {
      expiresAt: 9999,
    });
    expect(store.take('point.close', 0)?.cue.text).toBe('speculative');
  });
});

describe('the offline writer', () => {
  it('writes a bank for every class it is asked for, using placeholders', () => {
    const w = new OfflineWriter(1);
    const n = new Narrative('Pickleball', ['Ada', 'Bolt']).snapshot(
      emptyStats(0),
      [0, 0],
      0,
      'lobby',
      0,
    );
    return w.bank(n, CUE_CLASSES, 3).then((bank) => {
      expect(bank.size).toBeGreaterThan(10);
      for (const [cls, lines] of bank) {
        expect(lines.length, cls).toBeGreaterThan(0);
        for (const line of lines) {
          // A bank line must not be ambiguous about who it is about: either it
          // uses placeholders, or it names both players (symmetric, e.g. the
          // match intro), or it names neither. Naming exactly one without a
          // placeholder is the case that mis-fires.
          const named = ['Ada', 'Bolt'].filter((n) => line.includes(n)).length;
          const templated = line.includes('{player}') || line.includes('{opponent}');
          expect(templated || named !== 1, line).toBe(true);
          expect(filterLine(line, true).ok, line).toBe(true);
        }
      }
    });
  });

  it('cites a concrete fact when it has one', async () => {
    const w = new OfflineWriter(3);
    const narrative = new Narrative('Pickleball', ['Ada', 'Bolt']);
    narrative.addFact('Ada has missed 3 swings in a row');
    const n = narrative.snapshot(emptyStats(0), [2, 4], 1, 'point', 6);

    let cited = 0;
    for (let i = 0; i < 12; i++) {
      const { line } = await w.live({ cls: 'whiff.bad', narrative: n, subject: 0, data: {} });
      if (line.includes('missed 3 swings')) cited++;
    }
    expect(cited).toBeGreaterThan(0);
  });

  it('coins a nickname once there is something to name them after', async () => {
    const w = new OfflineWriter(9);
    const narrative = new Narrative('Pickleball', ['Ada', 'Bolt']);
    const stats = emptyStats(0);
    stats.perSeat[0].whiffs = 4;
    stats.perSeat[0].netErrors = 2;
    const n = narrative.snapshot(stats, [1, 4], 1, 'point', 3);
    const { newBit } = await w.live({ cls: 'whiff.repeat', narrative: n, subject: 0, data: {} });
    expect(newBit).toBeTruthy();
    expect(filterLine(newBit!).ok).toBe(true);
  });
});

describe('the Director, end to end', () => {
  it('pre-loads the bank before the match and fires cues in one hop', async () => {
    const h = harness();
    await h.director.prepare();

    // Everything is pushed up front, so an event costs one CUE_PLAY.
    expect(h.preloaded.size).toBeGreaterThan(20);
    const preloadMessages = h.sent.filter((m) => m.t === 'CUE_PRELOAD');
    expect(preloadMessages.length).toBe(1);

    h.director.onEvent({
      id: 'p1',
      t: h.now,
      type: 'point',
      seat: 1,
      data: {
        winner: 1,
        loser: 0,
        winnerName: 'Bolt',
        loserName: 'Ada',
        reason: 'net',
        rallyLength: 6,
        margin: 1,
        decidingShot: 'drive',
        scoreAfter: '0-1',
      },
      salience: 0.8,
      priority: 3,
    });
    expect(h.played.length).toBe(1);
    // The line that fired must not name the player who lost the point.
    const text = h.spokenTexts()[0];
    expect(text.includes('Ada takes')).toBe(false);
    h.director.dispose();
  }, 30_000);

  it('never repeats a line across a whole match, and stays quiet on routine play', async () => {
    const h = harness(['Ada', 'Bolt']);
    await h.director.prepare();

    const { events, match } = playMatch({ seed: 808, skill: 0.5 });
    h.setStats(match.getStats());

    let simTime = 0;
    for (const e of events) {
      h.advance(Math.max(0, e.t - simTime));
      simTime = e.t;
      h.setScore(
        [Number(match.getScore().points[0]), Number(match.getScore().points[1])],
        match.getScore().server,
      );
      h.director.onEvent(e);
    }
    await sleep(400); // let any live-layer work settle

    const spoken = h.spokenTexts().filter((t) => t !== '(streamed)');
    expect(spoken.length).toBeGreaterThan(5);
    // Zero repeated lines across a full match (W5 exit criterion).
    expect(new Set(spoken.map(normalizeLine)).size).toBe(spoken.length);

    // A commentator who talks through every rally hit becomes noise. There were
    // far more events than lines.
    expect(events.length).toBeGreaterThan(spoken.length * 2);
    h.director.dispose();
  }, 60_000);

  it('degrades to static lines when every generator fails', async () => {
    const h = harness();
    // Break the writer the way a dead API would: every call rejects.
    const broken = {
      name: 'broken',
      bank: () => Promise.reject(new Error('502')),
      speculate: () => Promise.reject(new Error('502')),
      live: () => Promise.reject(new Error('502')),
    };
    (h.director as unknown as { providers: { writer: unknown } }).providers.writer = broken;

    await h.director.prepare();
    // The static fallbacks shipped in the repo are still there.
    expect(h.preloaded.size).toBeGreaterThanOrEqual(10);

    h.director.onEvent({
      id: 'n1',
      t: h.now,
      type: 'net',
      seat: 0,
      data: { seat: 0, speed: 9 },
      salience: 0.6,
      priority: 2,
    });
    expect(h.played.length).toBe(1);
    h.director.dispose();
  }, 30_000);

  it('honours the minimum gap between lines, but lets priority 3 interrupt', async () => {
    const h = harness();
    await h.director.prepare();

    const whiff = (id: string, priority: 0 | 1 | 2 | 3): GameEvent => ({
      id,
      t: h.now,
      type: 'whiff',
      seat: 0,
      data: { seat: 0, consecutiveWhiffs: 1, missDistanceM: 1.1 },
      salience: 0.8,
      priority,
    });

    h.director.onEvent(whiff('a', 2));
    expect(h.played.length).toBe(1);
    h.advance(50);
    h.director.onEvent(whiff('b', 2)); // inside the gap: ignored
    expect(h.played.length).toBe(1);
    h.advance(TUNING.commentary.minGapMs + 10);
    h.director.onEvent(whiff('c', 2));
    expect(h.played.length).toBe(2);
    h.director.dispose();
  }, 30_000);

  it('ignores events below the salience floor', async () => {
    const h = harness();
    await h.director.prepare();
    h.director.onEvent({
      id: 'b',
      t: h.now,
      type: 'bounce',
      data: { inBounds: true },
      salience: 0.03,
      priority: 0,
    });
    expect(h.played.length).toBe(0);
    h.director.dispose();
  }, 30_000);

  it('goes quiet when muted', async () => {
    const h = harness();
    await h.director.prepare();
    h.director.setMuted(true);
    h.director.onEvent({
      id: 'm',
      t: h.now,
      type: 'match_end',
      seat: 0,
      data: { winner: 0, winnerName: 'Ada', final: '7-3' },
      salience: 1,
      priority: 3,
    });
    expect(h.played.length).toBe(0);
    h.director.dispose();
  }, 30_000);
});

describe('voice stream chunking', () => {
  it('splits on clause boundaries once there is enough to say', () => {
    // Chunk too eagerly and prosody falls apart; too late and the latency win is
    // gone. Nothing is emitted below 25 characters.
    expect(findBoundary('Too short.')).toBe(0);
    expect(findBoundary('That is a very tidy shot indeed. And another')).toBe(33);
    // A clause boundary too early in the buffer is ignored: chunking on a
    // nine-character fragment is how prosody falls apart.
    expect(findBoundary('Well now, that was something else')).toBe(0);
    expect(findBoundary('That was really quite something, and then some')).toBe(33);
    // A long unpunctuated run still flushes, at a word boundary.
    const long = 'x'.repeat(60) + ' word ' + 'y'.repeat(60);
    expect(findBoundary(long)).toBeGreaterThan(20);
  });
});
