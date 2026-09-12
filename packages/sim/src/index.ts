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
export * from './bot.js';
export * from './sports/index.js';
