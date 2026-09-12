import type { SportId } from '@rally/protocol';
import type { SportModule } from '../sport.js';
import { badminton } from './badminton.js';
import { bowling } from './bowling.js';
import { pickleball } from './pickleball.js';
import { tabletennis } from './tabletennis.js';

export { badminton, bowling, pickleball, tabletennis };
export type { LaneOutcome, PinState, TurnController } from './bowling.js';

export const SPORTS: Record<SportId, SportModule> = {
  pickleball,
  tabletennis,
  badminton,
  bowling,
};

/**
 * Table tennis leads: it is the sport with its own engine, its own physics and
 * the spin model, and the one the product is actually about. The other two share
 * the generic engine and ship as previews behind it.
 */
export const SPORT_ORDER: SportId[] = ['tabletennis', 'pickleball', 'badminton', 'bowling'];

export function getSport(id: SportId | string | undefined): SportModule {
  if (id && id in SPORTS) return SPORTS[id as SportId];
  return pickleball;
}

export function playableSports(): SportModule[] {
  return SPORT_ORDER.map((id) => SPORTS[id]).filter((s) => s.playable);
}
