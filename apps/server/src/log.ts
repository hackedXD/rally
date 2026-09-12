/** Minimal levelled logger. Nothing here should ever be in the hot tick path. */

import { CONFIG } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
const threshold = LEVELS[CONFIG.logLevel] ?? LEVELS.info;

const stamp = (): string => new Date().toISOString().slice(11, 23);

function emit(level: keyof typeof LEVELS, tag: string, args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const prefix = `${stamp()} ${level.toUpperCase().padEnd(5)} [${tag}]`;
  if (level === 'error') console.error(prefix, ...args);
  else if (level === 'warn') console.warn(prefix, ...args);
  else console.log(prefix, ...args);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(tag: string): Logger;
}

export function makeLogger(tag: string): Logger {
  return {
    debug: (...a) => emit('debug', tag, a),
    info: (...a) => emit('info', tag, a),
    warn: (...a) => emit('warn', tag, a),
    error: (...a) => emit('error', tag, a),
    child: (sub) => makeLogger(`${tag}:${sub}`),
  };
}

export const log = makeLogger('rally');
