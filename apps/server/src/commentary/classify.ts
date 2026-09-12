/**
 * GameEvent -> CueClass.
 *
 * Adding a commentary class means adding a bank key and a branch here, and
 * nothing else. The classifier deliberately returns null for events that should
 * produce silence: a commentator who talks through every rally hit becomes noise
 * within thirty seconds, and silence is a valid and often correct output.
 */

import { TUNING, type CueClass, type GameEvent } from '@rally/protocol';

export function classifyCue(e: GameEvent): CueClass | null {
  if (e.salience < TUNING.commentary.minSalience) return null;
  const d = e.data;

  switch (e.type) {
    case 'match_start':
      return 'match.intro';

    case 'serve':
      return d.gamePoint ? 'gamepoint' : 'serve.normal';

    case 'hit':
      if (d.shot === 'smash') return 'hit.smash';
      if (d.shot === 'lob') return 'hit.lob';
      if (d.shot === 'dink') return 'hit.dink';
      return null;

    case 'whiff':
      return Number(d.consecutiveWhiffs) >= 2 ? 'whiff.repeat' : 'whiff.bad';

    case 'net':
      return 'net.hit';

    case 'out':
      return 'out.long';

    case 'fault':
      return d.willLosePoint ? 'net.hit' : null;

    case 'rally_milestone':
      return Number(d.shots) >= 14 ? 'rally.epic' : 'rally.long';

    case 'point': {
      const margin = Number(d.margin);
      if (d.decidingShot === 'smash') return 'point.winner';
      if (margin >= 4) return 'point.blowout';
      return 'point.close';
    }

    case 'streak':
      return 'streak';

    case 'comeback':
      return 'comeback';

    case 'game_point':
      return 'gamepoint';

    case 'match_end':
      return 'match.end';

    case 'stall':
      return d.long ? 'stall.long' : 'stall.waiting';

    case 'double_bounce':
      return null;

    default:
      return null;
  }
}

/** Which events mark dead time the live layer can use (design §8.5.5). */
export function isDeadTimeTrigger(e: GameEvent): boolean {
  return e.type === 'point' || e.type === 'match_end' || e.type === 'game_point';
}
