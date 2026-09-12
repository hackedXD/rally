/**
 * The offline writer.
 *
 * Rally ships a commentator that needs no API keys, because a demo that is one
 * expired credential away from silence is not a demo. This is a template engine
 * with a large phrase bank, driven by the same `MatchNarrative` the language
 * model gets — so it cites real facts, coins a running bit, and never repeats a
 * line within a match.
 *
 * It is deliberately structured the same way the prompt is: tone rules as slot
 * vocabularies, specificity as fact injection, novelty as a dedupe ledger. The
 * model writes better sentences; this writes the same *kind* of sentence.
 */

import { lane, type CueClass, type Seat, type ShotType } from '@rally/protocol';
import { makeRng, type Rng } from '@rally/sim';
import type { MatchNarrative } from '../narrative.js';
import type { LineContext, LiveLine, SpecOutcome, Writer } from './types.js';

type Slots = Record<string, string>;

// ── Vocabulary ────────────────────────────────────────────────────────────────

const WHIFF_VERBS = [
  'swung at the air',
  'found nothing but atmosphere',
  'played an invisible ball',
  'missed by a postcode',
  'waved it through',
  'auditioned for the windmill',
];

const BIG_HIT = [
  'absolutely leathered',
  'flattened',
  'detonated',
  'put the boot through',
  'crunched',
  'unloaded on',
];

const PRAISE = [
  'that is lovely',
  'chef-kiss stuff',
  'clean as you like',
  'textbook',
  'filthy',
  'no notes',
];

const NICKNAME_ADJ = [
  'the Reluctant',
  'the Hopeful',
  'the Enthusiastic',
  'Captain',
  'the Honourable',
  'Doctor',
  'the Artisanal',
];

const NICKNAME_NOUN: Record<string, string[]> = {
  whiff: ['Windmill', 'Swing-and-Miss', 'Air Guitarist', 'Breeze Merchant'],
  net: ['Tape Measurer', 'Net Inspector', 'Tollbooth Operator'],
  out: ['Long Baller', 'Parking Attendant', 'Fence Painter'],
  smash: ['Hammer', 'Demolition Unit', 'Roof Raiser'],
  dink: ['Kitchen Lawyer', 'Pastry Chef', 'Softly Softly'],
  lob: ['Moon Shot', 'Weather Balloon', 'Stratosphere Tourist'],
  drive: ['Freight Train', 'Express Service', 'Flat Earther'],
  neutral: ['Optimist', 'Work in Progress', 'Project'],
};

// ── Templates ─────────────────────────────────────────────────────────────────
//
// Each class gets several families so the same situation never sounds the same
// twice. `{slot}` names are filled from the event and the narrative; a template
// whose slot is missing is skipped rather than rendered with a hole in it.

const BANK_TEMPLATES: Record<CueClass, string[]> = {
  'match.intro': [
    '{a} versus {b}. One of them has practised.',
    '{a}, {b}, and a ball that did not ask for this.',
    '{a} against {b}. Nobody warmed up. Everybody is confident.',
    'Here we go. Try to make it look deliberate.',
  ],
  'serve.normal': [
    '{p} to serve. Deep breaths.',
    'Service {p}.',
    '{p} has a plan. Probably.',
    'Up steps {p}.',
  ],
  'serve.ace': [
    '{p} serves, {o} waves. Free.',
    'Untouched. Take that all day.',
  ],
  'rally.long': [
    'This one has a mortgage.',
    'Neither of them wants to end it.',
    'Still going. Somebody decide.',
    'I have lost the thread of this.',
  ],
  'rally.epic': [
    'This is not a rally, it is a lifestyle.',
    'Put the kettle on.',
    'I have aged during this point.',
  ],
  'hit.smash': [
    '{p} {bighit} that.',
    'Oh, {p} meant that. {praise}.',
    '{p} has decided the ball is the problem.',
  ],
  'hit.dink': [
    'Soft hands, {p}.',
    '{p} takes the pace off. Cunning.',
    'A nudge, full of bad intentions.',
  ],
  'hit.lob': [
    '{p} sends it into orbit.',
    'Up it goes. Buying airspace.',
    'That ball has a window seat.',
  ],
  'whiff.bad': [
    '{p} {whiff}.',
    'And {p} {whiff}. We all saw it.',
    'Timing of a rotary phone.',
    '{p} {whiff}. The ball moved on.',
  ],
  'whiff.repeat': [
    '{p} again. A theme, then.',
    '{p} is collecting these.',
    'Twice. {p} is workshopping something.',
  ],
  'net.hit': [
    '{p} finds the net. It was right there.',
    'Into the tape. Want that back.',
    'The net remains undefeated.',
  ],
  'out.long': [
    'Long. Aiming for the car park.',
    'Out, and out by a distance.',
    '{p} overcooked it.',
  ],
  'point.close': [
    '{p} takes it. Tight.',
    'Point {p}. Earned, barely.',
    'That goes to {p}. {o} knows it.',
  ],
  'point.blowout': [
    '{p} again. This is getting one-sided.',
    'Point {p}. {o} is having a think.',
    '{p} is simply better at this.',
  ],
  'point.winner': [
    '{p} ends it properly.',
    'A winner. No argument.',
    '{p} closes the door.',
  ],
  streak: [
    '{p} is on a roll.',
    '{p} has found something.',
    'Three on the spin.',
  ],
  comeback: [
    '{p} was gone. {p} is not gone.',
    'Look at this. Dragged it back.',
  ],
  gamepoint: [
    'Match point. Try not to think about it.',
    'This is for the match.',
    'One point. Everything on it.',
  ],
  'match.end': [
    '{p} wins it. {o} blames the sun.',
    "That's the match to {p}. Genuinely well played.",
    '{p} takes it. Someone sit {o} down.',
  ],
  /*
   * Nothing is happening.
   *
   * These are the only lines in the bank whose subject is the absence of play,
   * and they are the ones that stop a stalled game reading as a broken one.
   * Kept light: the player has probably wandered off, and the right register is
   * an amused commentator filling air, not an error message.
   */
  'stall.waiting': [
    'Any time, {p}.',
    '{p} is taking a moment.',
    'We wait. The ball waits.',
    'Still {p} to serve.',
    '{p}? Whenever you are ready.',
  ],
  'stall.long': [
    '{p} has gone. Genuinely gone.',
    '{waited} seconds. I have checked my phone twice.',
    'The ball is out there somewhere. So is {p}.',
    'Has anybody seen {p}?',
    'This is the longest serve in the sport.',
    '{waited} seconds of nothing. Riveting.',
  ],
  /*
   * Deliberately empty, and it has to be.
   *
   * Coaching is written on demand in `commentary/tutor.ts`, keyed to the step
   * the player is actually stuck on. A cold bank is the opposite of that — lines
   * drawn at random, before the match, for whatever comes up — so a pre-written
   * one here would eventually teach somebody the wrong step. `BANK_CLASSES` does
   * not ask for this class; the entry exists because the map is exhaustive over
   * every cue class, which is what makes adding one a compile error rather than
   * a silent gap.
   */
  tutorial: [],
};

/** Templates that cite a concrete fact. These are what make it sound attentive. */
const FACT_TEMPLATES: Partial<Record<CueClass, string[]>> = {
  'whiff.bad': ['{p} {whiff} — and {fact}.', '{fact}. Not helping.'],
  'whiff.repeat': ['{fact}, and there goes another.'],
  'net.hit': ['Into the net again. {fact}.'],
  'out.long': ['Out. {fact}.'],
  'point.close': ['{p} takes it, and {fact}.'],
  'point.blowout': ['{p} again — {fact}.'],
  'point.winner': ['{p} finishes it. {fact}.'],
  streak: ['{fact}. {o} needs an idea.'],
  comeback: ['{fact}. Extraordinary.'],
  gamepoint: ['Match point, and {fact}.'],
  'match.end': ['{p} wins. For the record: {fact}.'],
  'rally.long': ['{n} shots. {fact}.'],
  'rally.epic': ['{n} shots. {fact}. Absurd.'],
  'hit.smash': ['{p} {bighit} it — {fact}.'],
  // A wait is the one moment with room for a whole fact. Nothing is happening,
  // so there is nothing to talk over.
  'stall.waiting': ['While we wait: {fact}.'],
  'stall.long': ['Still nothing. {fact}, for what it is worth.'],
};

/** Templates that call back to the coined running bit. */
const BIT_TEMPLATES: Partial<Record<CueClass, string[]>> = {
  'whiff.bad': ['{bit} does it again.', 'Classic {bit}.'],
  'whiff.repeat': ['{bit} is living up to the name.'],
  'net.hit': ['{bit} visits the tape again.'],
  'out.long': ['{bit}, ladies and gentlemen.'],
  'point.close': ['{bit} sneaks one.'],
  'point.blowout': ['{bit} is running away with this.'],
  'point.winner': ['{bit} with the finish.'],
  streak: ['{bit} is on a run. Did not see that coming.'],
  gamepoint: ['Match point for {bit}. The name fits.'],
  'match.end': ['{bit} takes the match. The name stays.'],
  'hit.smash': ['{bit} found a hammer.'],
  'stall.long': ['{bit} has left the building.'],
};

export class OfflineWriter implements Writer {
  readonly name = 'offline-writer';
  private rng: Rng;
  private usedTemplates = new Set<string>();

  constructor(seed = 0xc0ffee) {
    this.rng = makeRng(seed);
  }

  async bank(
    narrative: MatchNarrative,
    classes: readonly CueClass[],
    perClass: number,
  ): Promise<Map<CueClass, string[]>> {
    const out = new Map<CueClass, string[]>();
    for (const cls of classes) {
      const lines: string[] = [];
      const templates = BANK_TEMPLATES[cls] ?? [];
      // The bank is pre-written, so it knows names but not event detail. The
      // subject stays a placeholder: the Director instantiates it per seat.
      //
      // Counting what RENDERS, not what is attempted. A template with a slot the
      // bank cannot fill — one citing how long a wait has been, say — renders to
      // nothing, and stopping after `perClass` attempts let a single such
      // template silently cost the class a line. The classes that need the most
      // variety are exactly the ones with conditional slots, so they were the
      // ones that ran dry first.
      for (const tpl of templates) {
        if (lines.length >= perClass) break;
        const line = render(tpl, this.slotsFor(cls, narrative, 0, {}, true));
        if (line && !lines.includes(line)) lines.push(line);
      }
      if (lines.length) out.set(cls, lines);
    }
    return out;
  }

  async speculate(
    narrative: MatchNarrative,
    outcomes: readonly SpecOutcome[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const o of outcomes) {
      const line = this.compose({
        cls: o.cls,
        narrative,
        subject: subjectFromKey(o.key),
        data: {},
      });
      if (line) out.set(o.key, line);
    }
    return out;
  }

  async live(ctx: LineContext): Promise<LiveLine> {
    const line = this.compose(ctx);
    let newBit: string | null = null;
    // Coin at most one nickname, and only once there is evidence for it.
    if (ctx.narrative.runningBits.length === 0 && this.shouldCoin(ctx)) {
      newBit = this.coinNickname(ctx);
    }
    return { line, newBit };
  }

  // ── Composition ─────────────────────────────────────────────────────────────

  /**
   * Pick a template family, preferring the ones that make the commentary sound
   * like it is paying attention: a callback to the running bit, then a concrete
   * fact, then the plain version.
   */
  private compose(ctx: LineContext): string {
    const { cls, narrative } = ctx;
    const subject = ctx.subject ?? 0;
    const slots = this.slotsFor(cls, narrative, subject, ctx.data);

    const families: string[][] = [];
    if (narrative.runningBits.length && this.rng.chance(0.38)) {
      families.push(BIT_TEMPLATES[cls] ?? []);
    }
    if (narrative.facts.length) families.push(FACT_TEMPLATES[cls] ?? []);
    families.push(BANK_TEMPLATES[cls] ?? []);
    families.push(BANK_TEMPLATES['point.close']);

    for (const family of families) {
      const candidates = family.filter((t) => renderable(t, slots));
      if (!candidates.length) continue;
      // Prefer a template this match has not used yet.
      const fresh = candidates.filter((t) => !this.usedTemplates.has(`${cls}:${t}`));
      const pool = fresh.length ? fresh : candidates;
      const tpl = this.rng.pick(pool);
      this.usedTemplates.add(`${cls}:${tpl}`);
      // "Robo takes it, and Robo has won 3 in a row" is two sentences that should
      // have been one. When a template names the subject AND cites a fact, prefer
      // a fact about somebody else.
      if (tpl.includes('{p}') && tpl.includes('{fact}') && slots.p) {
        const others = narrative.facts.filter((f) => !f.includes(slots.p));
        if (others.length) slots.fact = this.rng.pick(others);
      }
      const line = render(tpl, slots);
      if (line) return line;
    }
    return '';
  }

  private slotsFor(
    cls: CueClass,
    n: MatchNarrative,
    subject: Seat,
    data: Record<string, unknown>,
    keepSubjectPlaceholder = false,
  ): Slots {
    const me = n.players[lane(subject)];
    const them = n.players[lane(subject) === 0 ? 1 : 0];
    const slots: Slots = {
      a: n.players[0]?.name ?? 'Player 1',
      b: n.players[1]?.name ?? 'Player 2',
      p: keepSubjectPlaceholder ? '{player}' : (me?.name ?? 'they'),
      o: keepSubjectPlaceholder ? '{opponent}' : (them?.name ?? 'the other one'),
      sport: n.sport,
      score: `${n.score[0]}-${n.score[1]}`,
      whiff: this.rng.pick(WHIFF_VERBS),
      bighit: this.rng.pick(BIG_HIT),
      praise: this.rng.pick(PRAISE),
    };
    if (n.facts.length) slots.fact = this.rng.pick(n.facts);
    if (n.runningBits.length) slots.bit = n.runningBits[0];
    const num = data.shots ?? data.rallyLength ?? data.length ?? data.deficit;
    if (typeof num === 'number') slots.n = String(num);
    if (typeof data.shot === 'string') slots.shot = data.shot;
    // How long the wait has been, in whole seconds. Only the stall lines use it,
    // and a template whose slot is missing is skipped rather than rendered with
    // a hole in it — so this being absent everywhere else costs nothing.
    if (typeof data.waitedS === 'number') slots.waited = String(data.waitedS);
    void cls;
    return slots;
  }

  private shouldCoin(ctx: LineContext): boolean {
    const worst = ctx.narrative.players.reduce((a, b) =>
      errorScore(a) >= errorScore(b) ? a : b,
    );
    // Wait for something actually characterful to name them after.
    return errorScore(worst) >= 3 || (worst.signatureShot !== null && ctx.narrative.score[0] + ctx.narrative.score[1] >= 3);
  }

  private coinNickname(ctx: LineContext): string {
    const worst = ctx.narrative.players.reduce((a, b) =>
      errorScore(a) >= errorScore(b) ? a : b,
    );
    const trait = dominantTrait(worst);
    const nouns = NICKNAME_NOUN[trait] ?? NICKNAME_NOUN.neutral;
    return `${this.rng.pick(NICKNAME_ADJ)} ${this.rng.pick(nouns)}`;
  }

  reset(seed = 0xc0ffee): void {
    this.rng = makeRng(seed);
    this.usedTemplates.clear();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function render(tpl: string, slots: Slots): string {
  let out = tpl;
  for (const [key, value] of Object.entries(slots)) {
    out = out.split(`{${key}}`).join(value);
  }
  // A template with an unfilled slot is dropped, never rendered with a hole.
  // `{player}` and `{opponent}` are deliberate: the Director fills them per seat.
  if (/\{(?!player\}|opponent\})[a-z]+\}/.test(out)) return '';
  return out;
}

function renderable(tpl: string, slots: Slots): boolean {
  const needed = tpl.match(/\{([a-z]+)\}/g) ?? [];
  return needed.every((m) => slots[m.slice(1, -1)] !== undefined);
}

function errorScore(p: {
  whiffs: number;
  netErrors: number;
  outErrors: number;
}): number {
  return p.whiffs * 2 + p.netErrors + p.outErrors;
}

function dominantTrait(p: {
  whiffs: number;
  netErrors: number;
  outErrors: number;
  signatureShot: ShotType | null;
}): string {
  const ranked: [string, number][] = [
    ['whiff', p.whiffs * 2],
    ['net', p.netErrors * 1.5],
    ['out', p.outErrors * 1.5],
    [p.signatureShot ?? 'neutral', 2],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  return ranked[0][1] > 0 ? ranked[0][0] : 'neutral';
}

function subjectFromKey(key: string): Seat {
  return key.includes('1') ? 1 : 0;
}
