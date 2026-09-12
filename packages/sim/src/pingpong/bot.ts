/**
 * A bot for the empty seat, so one phone is still a game. Transplanted from
 * `pickle`, with Rally's seeded RNG and skill dial wired through.
 *
 * It plays through the exact same path a human does — `swingCheck` +
 * `applySwing` with a synthesised swing — so it cannot do anything a player
 * could not.
 */

import type { Rng } from '../rng.js';
import { swingCheck, type PpMatchState, type PpSwing } from './rules.js';

/**
 * The bot plays an opponent you can beat, not a wall. Hitting at the top of the
 * human range with a 266 ms worst reaction reads, against this slower ball, as
 * being aced rather than outplayed.
 */
const REACT_MIN = 7; //     ticks at 60 Hz -> ~117 ms
const REACT_MAX = 24; //    ~400 ms, a genuinely late one
const MISS_CHANCE = 0.26; // how often it lets one go by, so you can win points
/**
 * Power is what makes its shots legal, so this is NOT the difficulty dial —
 * starved of it the bot just nets everything and hands over points, which is not
 * "beatable", it is broken. Difficulty lives in MISS_CHANCE and reaction.
 */
const DPS_MIN = 440;
const DPS_MAX = 900;

export interface PpBotState {
  wait: number;
  patience: number;
  armed: boolean;
  skip: boolean;
}

const pitchQ = (r: number): [number, number, number, number] => [
  Math.sin(r / 2),
  0,
  0,
  Math.cos(r / 2),
];

/**
 * Skill bends reaction and the miss rate, and deliberately leaves power alone.
 * 0.5 reproduces the transplanted bot exactly.
 */
const reaction = (rng: Rng, skill: number): number => {
  const slack = 1 + (0.5 - skill) * 1.2; // a worse bot is slower to start
  return Math.round(rng.range(REACT_MIN, REACT_MAX) * Math.max(0.35, slack));
};

const missChance = (skill: number): number =>
  Math.max(0.02, Math.min(0.6, MISS_CHANCE * (1 + (0.5 - skill) * 1.6)));

export const newPpBot = (): PpBotState => ({
  wait: 0,
  patience: REACT_MIN,
  armed: false,
  skip: false,
});

/**
 * One tick. Returns [bot, swing | null].
 *
 * The miss is deliberate and decided once per opportunity: rather than swinging
 * badly (which the assist would mostly rescue anyway) the bot simply lets some
 * balls go. That reads as "it missed" instead of "the physics is broken".
 */
export const stepPpBot = (
  bot: PpBotState,
  match: PpMatchState,
  seat: 0 | 1,
  rng: Rng,
  skill = 0.5,
): [PpBotState, PpSwing | null] => {
  if (swingCheck(match, seat) !== null) return [bot.armed ? newPpBot() : bot, null];

  // Window just opened: commit to a reaction time and whether to bother. Never
  // skip a serve — nobody else can start the point, so a skipped serve is a
  // deadlock, not a miss.
  const b: PpBotState = bot.armed
    ? bot
    : {
        wait: 0,
        patience: reaction(rng, skill),
        armed: true,
        skip: match.phase === 'rally' && rng.chance(missChance(skill)),
      };
  if (b.skip) return [b, null];

  const wait = b.wait + 1;
  if (wait < b.patience) return [{ ...b, wait }, null];

  return [
    newPpBot(),
    {
      // slightly closed face plus a lifting stroke: the bot loops rather than
      // pushing. Without the linear term it could not generate spin at all.
      q: pitchQ(rng.range(-0.42, -0.12)),
      omega: [
        (seat === 0 ? -1 : 1) * rng.range(DPS_MIN, DPS_MAX),
        rng.range(-90, 90),
        rng.range(-140, 140),
      ],
      vsw: [rng.range(-0.7, 0.7), rng.range(1.3, 2.9), -rng.range(1.5, 2.9)],
    },
  ];
};
