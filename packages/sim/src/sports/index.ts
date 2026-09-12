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

export const SPORT_ORDER: SportId[] = ['pickleball', 'tabletennis', 'badminton', 'bowling'];

export function getSport(id: SportId | string | undefined): SportModule {
  if (id && id in SPORTS) return SPORTS[id as SportId];
  return pickleball;
}

export function playableSports(): SportModule[] {
  return SPORT_ORDER.map((id) => SPORTS[id]).filter((s) => s.playable);
}
