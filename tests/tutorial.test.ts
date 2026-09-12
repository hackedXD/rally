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
import type { GameEvent, Seat } from '@rally/protocol';
import {
  AIM_TURN_RAD,
  MIN_DWELL_S,
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
