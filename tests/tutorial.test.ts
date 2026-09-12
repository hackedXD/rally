/**
 * The tutorial checklist.
 *
 * Pure logic, so it is tested rather than clicked through. The two things that
 * matter here are the two that were wrong first time: a step must be satisfied
 * by something the PLAYER did rather than something the game did, and the
 * checklist must be cumulative — see the notes in `tutorial.ts` for why each of
 * those was a real bug rather than a preference.
 */

import { describe, expect, it } from 'vitest';
import type { GameEvent, Seat, SportId } from '@rally/protocol';
import { filterLine } from '../apps/server/src/commentary/filter.js';
import {
  TUTOR_STEPS,
  coachLine,
  isTutorStep,
} from '../apps/server/src/commentary/tutor.js';
import {
  AIM_TURN_RAD,
  MIN_DWELL_S,
  NUDGE_AFTER_S,
  STRUGGLING,
  isMine,
  tutorialSteps,
  type StepContext,
  type TutorialStep,
} from '../apps/display/src/ui/tutorial.js';

const ctx = (over: Partial<StepContext> = {}): StepContext => ({
  mine: new Set<GameEvent['type']>(),
  phase: 'rally',
  bestRally: 0,
  aimed: 0,
  whiffs: 0,
  elapsed: 0,
  ...over,
});

const detailOf = (s: TutorialStep, c: StepContext = ctx()): string =>
  typeof s.detail === 'function' ? s.detail(c) : (s.detail ?? '');

const ev = (over: Partial<GameEvent>): GameEvent => ({
  id: 'e',
  t: 0,
  type: 'hit',
  data: {},
  salience: 0.5,
  priority: 1,
  ...over,
});

describe('the tutorial checklist', () => {
  it('covers every sport, and says different things for table tennis', () => {
    const pb = tutorialSteps('pickleball');
    const tt = tutorialSteps('tabletennis');
    const bd = tutorialSteps('badminton');
    for (const steps of [pb, tt, bd]) {
      expect(steps.length).toBeGreaterThanOrEqual(5);
      // Every step needs a readable instruction and a unique id — the id keys
      // the progress dots, and a duplicate would collapse two of them into one.
      expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
      for (const s of steps) expect(s.title.length).toBeGreaterThan(3);
    }
    // Pickleball and badminton share the shared engine, so they share the words.
    expect(pb.map((s) => s.title)).toEqual(bd.map((s) => s.title));
    // Table tennis does not: it has no telegraph ring to point at, and a
    // tutorial that mentioned one would be teaching a control that is not there.
    const ttContact = tt.find((s) => s.id === 'contact')!;
    expect(detailOf(ttContact)).not.toMatch(/ring/i);
    expect(detailOf(pb.find((s) => s.id === 'contact')!)).toMatch(/ring/i);
  });

  it('offers a more specific hint once the player is clearly missing', () => {
    // A tutorial that repeats the same sentence while somebody misses for the
    // fifth time is not coaching, it is nagging.
    for (const sport of ['pickleball', 'tabletennis'] as const) {
      const contact = tutorialSteps(sport).find((s) => s.id === 'contact')!;
      const calm = detailOf(contact, ctx({ whiffs: 0 }));
      const struggling = detailOf(contact, ctx({ whiffs: STRUGGLING }));
      expect(struggling).not.toBe(calm);
      expect(struggling.length).toBeGreaterThan(10);
      // ...and it only changes once they have actually missed a few.
      expect(detailOf(contact, ctx({ whiffs: STRUGGLING - 1 }))).toBe(calm);
    }
  });

  it('advances on what the player did, not on what the game did', () => {
    const [aim, serve, contact] = tutorialSteps('pickleball');
    // Standing still finishes nothing, however long you stand there.
    expect(aim.done(ctx({ elapsed: 30 }))).toBe(false);
    expect(aim.done(ctx({ aimed: AIM_TURN_RAD * 0.9 }))).toBe(false);
    expect(aim.done(ctx({ aimed: AIM_TURN_RAD * 1.1 }))).toBe(true);

    // An opponent's serve is not your serve.
    expect(serve.done(ctx())).toBe(false);
    expect(serve.done(ctx({ mine: new Set<GameEvent['type']>(['serve']) }))).toBe(true);
    expect(contact.done(ctx({ mine: new Set<GameEvent['type']>(['serve']) }))).toBe(false);
    expect(contact.done(ctx({ mine: new Set<GameEvent['type']>(['hit']) }))).toBe(true);
  });

  it('is cumulative: doing a later step early still counts', () => {
    // The bug this replaced. Serving while still reading step one used to
    // discard the serve, leaving the player on "swing to serve" through two more
    // points of somebody else's service, having done nothing wrong.
    const steps = tutorialSteps('pickleball');
    const early = ctx({
      mine: new Set<GameEvent['type']>(['serve', 'hit']),
      aimed: 1,
      bestRally: 6,
    });
    for (const id of ['aim', 'serve', 'contact', 'rally']) {
      expect(steps.find((s) => s.id === id)!.done(early)).toBe(true);
    }
    // ...but winning a point is still not implied by any of it.
    expect(steps.find((s) => s.id === 'point')!.done(early)).toBe(false);
  });

  it('ends itself rather than waiting on the player', () => {
    const last = tutorialSteps('pickleball').at(-1)!;
    expect(last.done(ctx({ elapsed: 1 }))).toBe(false);
    expect(last.done(ctx({ elapsed: 6 }))).toBe(true);
    // Long enough to read, which is the whole reason the dwell floor exists.
    expect(MIN_DWELL_S).toBeGreaterThan(1);
  });

  it('knows whose event is whose, including the point', () => {
    expect(isMine(ev({ type: 'serve', seat: 0 }), 0 as Seat)).toBe(true);
    expect(isMine(ev({ type: 'serve', seat: 1 }), 0 as Seat)).toBe(false);
    // A point names its winner in the data, and without that branch "win a
    // point" never completes for the person who won it.
    expect(isMine(ev({ type: 'point', seat: 0, data: { winner: 0 } }), 0 as Seat)).toBe(true);
    expect(isMine(ev({ type: 'point', seat: 0, data: { winner: 1 } }), 0 as Seat)).toBe(false);
    // An event belonging to nobody belongs to nobody.
    expect(isMine(ev({ type: 'bounce' }), 0 as Seat)).toBe(false);
  });
});

/**
 * The spoken half.
 *
 * The checklist lives in the browser and the script lives on the server, so the
 * thing most likely to break is not either one — it is the join. A step renamed
 * on one side and not the other produces a tutorial that advances in silence,
 * which nothing else here would catch.
 */
describe('the commentator teaching it', () => {
  const SPORTS: SportId[] = ['pickleball', 'tabletennis', 'badminton'];

  it('has a line for every step the display can ask about', () => {
    for (const sport of SPORTS) {
      for (const step of tutorialSteps(sport)) {
        expect(isTutorStep(step.id)).toBe(true);
        expect(coachLine(step.id as never, sport).length).toBeGreaterThan(0);
      }
    }
    // ...and the welcome, which is the commentator's alone — no card shows it.
    expect(isTutorStep('intro')).toBe(true);
    // A step name off the wire is matched against this list and nothing else.
    expect(isTutorStep('serve')).toBe(true);
    expect(isTutorStep('__proto__')).toBe(false);
    expect(isTutorStep('')).toBe(false);
  });

  it('says something different the second time, for every step', () => {
    // A coach who repeats the sentence you did not understand is not coaching.
    for (const sport of SPORTS) {
      for (const step of TUTOR_STEPS) {
        expect(coachLine(step, sport, true)).not.toBe(coachLine(step, sport));
      }
    }
  });

  it('clears the filter every other spoken line has to clear', () => {
    // These go to the same voice, under the same hold on play, so they are held
    // to the same ceiling — including once a sixteen-character name is in them.
    for (const sport of SPORTS) {
      for (const step of TUTOR_STEPS) {
        for (const nudge of [false, true]) {
          const line = coachLine(step, sport, nudge).replace(/\{player\}/g, 'W'.repeat(16));
          const r = filterLine(line);
          expect(r.ok, `${sport}/${step}${nudge ? ' (nudge)' : ''}: ${r.reason}`).toBe(true);
        }
      }
    }
  });

  it('teaches table tennis as its own game', () => {
    for (const step of TUTOR_STEPS) {
      const tt = coachLine(step, 'tabletennis');
      // There is no telegraph ring at a table tennis table, so the voice must
      // never send anybody looking for one.
      expect(tt).not.toMatch(/ring/i);
      // The steps that are genuinely the same game keep the same words rather
      // than being reworded for the sake of it.
      if (!['aim', 'serve', 'contact', 'point'].includes(step)) {
        expect(tt).toBe(coachLine(step, 'pickleball'));
      }
    }
    expect(coachLine('point', 'tabletennis')).toMatch(/spin|brush/i);
  });

  it('waits long enough before saying it again', () => {
    // Longer than the dwell floor, or the second line lands on top of the first.
    expect(NUDGE_AFTER_S).toBeGreaterThan(MIN_DWELL_S * 4);
  });
});
