/**
 * Seeded PRNG. `packages/sim` is pure (coding standard 1): no `Math.random()`
 * without an injected seed, no `Date.now()`. Randomness is a parameter, which
 * is what makes the simulation replayable and its tests deterministic.
 *
 * mulberry32 — 32 bits of state, good enough for shot jitter, fast, and trivial
 * to reimplement if a replay ever needs to be read by something else.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number;
  /** Uniform in [-m, +m). */
  spread(m: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /**
   * Approximately normal, mean 0, standard deviation `sd`, clipped at 3 sd.
   * Needed wherever an error model has to have tails: a bounded uniform jitter
   * can never exceed a timing window, so a bot using one never misses by
   * accident no matter how tight the window gets.
   */
  gauss(sd: number): number;
  pick<T>(items: readonly T[]): T;
  /** Current state, for snapshotting a replay mid-match. */
  state(): number;
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + next() * (hi - lo),
    spread: (m) => (next() * 2 - 1) * m,
    chance: (p) => next() < p,
    // Irwin-Hall with n = 3: close enough to normal, cheap, and bounded.
    gauss: (sd) => ((next() + next() + next() - 1.5) / 0.5) * sd * 0.577,
    pick: (items) => items[Math.floor(next() * items.length)],
    state: () => a,
  };
}

/** A deterministic RNG that always returns 0.5. Useful in tests. */
export const FIXED_RNG: Rng = {
  next: () => 0.5,
  range: (lo, hi) => (lo + hi) / 2,
  spread: () => 0,
  chance: (p) => p > 0.5,
  gauss: () => 0,
  pick: (items) => items[Math.floor(items.length / 2)],
  state: () => 0,
};
