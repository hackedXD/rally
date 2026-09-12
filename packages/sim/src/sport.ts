/**
 * A sport is one file. That is the whole point of this interface.
 *
 * Pickleball and table tennis differ only in constants and scoring — same code
 * path. Bowling sets `rallyBased: false` and ships as a compiling interface
 * stub, which is an honest way to show the shape of the abstraction without
 * pretending to have built a second game.
 */

import type {
  BallSpec,
  CourtSpec,
  GameEvent,
  MatchPhase,
  Millis,
  PersonaSpec,
  ScoreState,
  ServeSpec,
  SportId,
  SportMeta,
  StrikeTuning,
} from '@rally/protocol';
import type { ScoringModule } from './scoring.js';
import type { MatchStats } from './stats.js';

/**
 * The slice of simulation state that state-derived events are diffed against.
 * Impulse events (hit, whiff, net, out, point) are emitted where they happen,
 * because that is the only place their rich `data` payload is available;
 * `classifyEvents` handles the events that genuinely *are* diffs — streaks,
 * comebacks, rally milestones, game point.
 */
export interface DerivedState {
  t: Millis;
  phase: MatchPhase;
  score: ScoreState;
  rally: number;
  rallyStartedAt: Millis;
  stats: MatchStats;
}

export interface SportModule {
  id: SportId;
  displayName: string;
  rallyBased: boolean;
  /** False for sports that ship only as an interface stub. */
  playable: boolean;
  tagline: string;
  court: CourtSpec;
  ball: BallSpec;
  strike: StrikeTuning;
  serve: ServeSpec;
  scoring: ScoringModule;
  persona: PersonaSpec;
  classifyEvents(prev: DerivedState, next: DerivedState): GameEvent[];
}

export function sportMeta(s: SportModule): SportMeta {
  return {
    id: s.id,
    displayName: s.displayName,
    rallyBased: s.rallyBased,
    tagline: s.tagline,
    playable: s.playable,
  };
}
