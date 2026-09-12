/**
 * The end of the fallback chain: Live -> Speculative -> Cache -> these -> silence.
 *
 * Ten lines, in the repo, that require nothing. They exist so that killing
 * network access to both APIs mid-match degrades to static commentary with no
 * visible stall, which is the last link before silence — and silence is still a
 * valid output, just a less fun one.
 */

import type { CueClass } from '@rally/protocol';

export const STATIC_LINES: { cls: CueClass; text: string }[] = [
  { cls: 'match.intro', text: "Here we go. Let's play." },
  { cls: 'serve.normal', text: 'Service.' },
  { cls: 'whiff.bad', text: 'Swing and a miss.' },
  { cls: 'whiff.repeat', text: 'Again! Oh dear.' },
  { cls: 'net.hit', text: 'Into the net.' },
  { cls: 'out.long', text: "That's long." },
  { cls: 'rally.long', text: 'Great rally, this.' },
  { cls: 'hit.smash', text: 'Smashed away!' },
  { cls: 'point.close', text: "That's the point." },
  { cls: 'point.blowout', text: 'Another one.' },
  { cls: 'point.winner', text: 'What a finish!' },
  { cls: 'streak', text: "They're on a run." },
  { cls: 'comeback', text: "What a comeback!" },
  { cls: 'gamepoint', text: 'Match point.' },
  { cls: 'match.end', text: "And that's the match!" },
];
