/**
 * @rally/sim — pure, deterministic, headless simulation.
 *
 * Imports nothing outside `@rally/protocol`. No fetch, no WebSocket, no
 * Date.now(), no Math.random() without an injected seed. That is what makes it
 * unit-testable and replayable, and it is not negotiable.
 */

export * from './params.js';
export * from './physics.js';
export * from './predict.js';
export * from './rng.js';
export * from './scoring.js';
export * from './shot.js';
export * from './sport.js';
export * from './stats.js';
export * from './strike.js';
export * from './match.js';
/**
 * Table tennis runs its own engine. Namespaced rather than flattened: it has its
 * own GRAVITY, its own TABLE, its own `step` — all of which mean something
 * different from the shared simulation's, and all of which would collide.
 */
export * as pingpong from './pingpong/index.js';
export { PingPongMatch, type PingPongOptions } from './pingpong/match.js';
export * from './bot.js';
export * from './sports/index.js';
