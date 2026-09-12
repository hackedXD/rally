/**
 * Zod schemas for every network boundary (coding standard 2). A malformed
 * message logs and drops; it never throws into the tick loop.
 *
 * The two hot paths — SNAPSHOT and LOCALPOSE, 30 Hz each — get hand-written
 * structural guards at the bottom of this file instead of a Zod parse, because
 * allocating a validation result 60 times a second on the render thread is a
 * frame-time cost with no safety benefit: both originate from our own server.
 */

import { z } from 'zod';
import { CUE_CLASSES, GAME_EVENT_TYPES } from './events.js';

const num = z.number().finite();
const vec3 = z.tuple([num, num, num]);
const quat = z.tuple([num, num, num, num]);
const seat = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const sportId = z.enum(['pickleball', 'tabletennis', 'badminton', 'bowling']);
const phase = z.enum(['lobby', 'serve', 'rally', 'point', 'gameover', 'paused']);
const priority = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const cueClass = z.enum(CUE_CLASSES);

/** Room codes are 4 characters from an unambiguous alphabet. */
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const roomCode = z
  .string()
  .length(4)
  .transform((s) => s.toUpperCase())
  .refine((s) => [...s].every((c) => ROOM_ALPHABET.includes(c)), 'bad room code');

/**
 * Player names are user input that gets rendered to audio in front of an
 * audience (§8.5.6). Strip to a safe set, cap the length, and never trust the
 * client to have done it.
 */
export const NAME_MAX = 16;
export function sanitizeName(raw: unknown, fallback = 'Player'): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .replace(/[^A-Za-z0-9 '-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
  return cleaned.length >= 1 ? cleaned : fallback;
}

const nameField = z.string().max(64).transform((s) => sanitizeName(s));

export const tuningPatchSchema = z.record(z.string(), z.record(z.string(), num));

// ── controller → server ───────────────────────────────────────────────────────

export const c2sSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('HELLO'),
    role: z.literal('controller'),
    room: roomCode,
    seat,
    pairToken: z.string().min(8).max(64),
  }),
  z.object({ t: z.literal('PING'), c0: num, rtt: num.min(0).max(5000).optional() }),
  z.object({
    t: z.literal('POSE'),
    seq: num,
    ct: num,
    q: z.tuple([num, num, num, num]),
    // Table tennis: forward lean and cross-body travel, metres, and whether a
    // stroke is in progress.
    z: num.min(-2).max(2).optional(),
    dx: num.min(-2).max(2).optional(),
    hold: z.boolean().optional(),
  }),
  z.object({
    t: z.literal('SWING'),
    seq: num,
    ctPeak: num,
    speed: num.min(0).max(100),
    dir: vec3,
    q: quat,
    elev: num.min(-Math.PI).max(Math.PI),
    // Table tennis: wrist rotation and hand velocity at peak. See SwingInput.
    omega: vec3.optional(),
    vsw: vec3.optional(),
  }),
  z.object({ t: z.literal('BUTTON'), button: z.enum(['serve', 'mute']) }),
  z.object({ t: z.literal('CALIBRATED'), yawOffset: num }),
  z.object({ t: z.literal('READY'), name: nameField }),
  z.object({ t: z.literal('READY_POINT') }),
  z.object({ t: z.literal('REMATCH') }),
  z.object({ t: z.literal('ABORT') }),
  z.object({ t: z.literal('PAUSE'), paused: z.boolean() }),
]);

// ── display → server ──────────────────────────────────────────────────────────

export const d2sSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('HELLO'), role: z.literal('display') }),
  z.object({ t: z.literal('PING'), c0: num, rtt: num.min(0).max(5000).optional() }),
  z.object({ t: z.literal('ROOM_CREATE'), sport: sportId }),
  z.object({ t: z.literal('ROOM_JOIN'), room: roomCode }),
  z.object({ t: z.literal('SPORT_SELECT'), sport: sportId }),
  z.object({ t: z.literal('ADD_BOT'), skill: num.min(0).max(1) }),
  z.object({ t: z.literal('SET_NAME'), name: nameField }),
  z.object({
    t: z.literal('COACH'),
    // A step name, matched against a fixed list on the server. Capped here so a
    // malformed one is dropped at the boundary rather than carried inward.
    step: z.string().max(32),
    nudge: z.boolean().optional(),
  }),
  z.object({ t: z.literal('READY') }),
  z.object({ t: z.literal('START') }),
  z.object({ t: z.literal('REMATCH') }),
  z.object({ t: z.literal('ABORT') }),
  z.object({ t: z.literal('AUDIO_UNLOCKED') }),
  z.object({ t: z.literal('MUTE'), muted: z.boolean() }),
  z.object({ t: z.literal('TUNE'), patch: tuningPatchSchema }),
]);

/** One entry point for the server: figure out which side sent this. */
export const inboundSchema = z.union([c2sSchema, d2sSchema]);

// ── server → clients (validated on the client side) ───────────────────────────

const ballState = z.object({
  p: vec3,
  v: vec3,
  spin: num,
  b: num,
  owner: seat.nullable(),
});

const playerState = z.object({
  seat,
  name: z.string(),
  p: vec3,
  paddleQ: quat,
  anim: z.enum(['idle', 'wind', 'swing', 'whiff', 'celebrate']),
  connected: z.boolean(),
  bot: z.boolean(),
});

export const snapshotSchema = z.object({
  tick: num,
  t: num,
  phase,
  ball: ballState.nullable(),
  players: z.array(playerState),
  score: z.object({
    points: z.tuple([num, num]),
    server: seat,
    gamePoint: z.boolean(),
    gamePointSeat: seat.nullable(),
  }),
  strike: z
    .object({ seat, tIdeal: num, p: vec3, open: z.boolean(), difficulty: num })
    .optional(),
  reconcile: z
    .object({ seat, t: num, p: vec3, q: quat, kind: z.enum(['hit', 'whiff']) })
    .optional(),
  rally: num,
  phaseT: num,
  ready: z.tuple([z.boolean(), z.boolean()]).optional(),
});

const gameEvent = z.object({
  id: z.string(),
  t: num,
  type: z.enum(GAME_EVENT_TYPES),
  seat: seat.optional(),
  data: z.record(z.string(), z.union([num, z.string(), z.boolean()])),
  salience: num,
  priority,
});

const preloadedCue = z.object({
  id: z.string(),
  text: z.string(),
  audioB64: z.string(),
  durationMs: num,
  layer: z.enum(['cache', 'speculative', 'fallback']),
  cls: cueClass,
  speak: z.boolean().optional(),
});

const seatInfo = z.object({
  seat,
  name: z.string().nullable(),
  ready: z.boolean(),
  paired: z.boolean(),
  bot: z.boolean(),
  connected: z.boolean(),
});

const sportMeta = z.object({
  id: sportId,
  displayName: z.string(),
  rallyBased: z.boolean(),
  tagline: z.string(),
  playable: z.boolean(),
    beta: z.boolean().optional(),
});

export const s2dSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('WELCOME'), clientId: z.string(), st: num }),
  z.object({ t: z.literal('PONG'), c0: num, st: num }),
  z.object({
    t: z.literal('ROOM_STATE'),
    room: z.string(),
    seat,
    pairToken: z.string(),
    pairUrl: z.string(),
    joinUrl: z.string(),
    otherPairUrl: z.string().nullable(),
    sport: sportId,
    seats: z.array(seatInfo),
    sports: z.array(sportMeta),
    host: z.boolean(),
  }),
  z.object({
    t: z.literal('MATCH_START'),
    sport: sportId,
    st: num,
    names: z.tuple([z.string(), z.string()]),
  }),
  z.object({
    t: z.literal('LOBBY_STATUS'),
    text: z.string(),
    progress: num,
    done: z.boolean(),
  }),
  z.object({ t: z.literal('SNAPSHOT'), s: snapshotSchema }),
  z.object({ t: z.literal('LOCALPOSE'), seat, q: quat, ct: num }),
  z.object({ t: z.literal('EVENT'), e: gameEvent }),
  z.object({ t: z.literal('CUE_PRELOAD'), cues: z.array(preloadedCue) }),
  z.object({ t: z.literal('CUE_PLAY'), id: z.string(), priority }),
  z.object({
    t: z.literal('CUE_STREAM_BEGIN'),
    id: z.string(),
    priority,
    mime: z.string(),
    speak: z.boolean().optional(),
    text: z.string().optional(),
  }),
  z.object({ t: z.literal('CUE_TEXT'), id: z.string(), text: z.string() }),
  z.object({ t: z.literal('CUE_STREAM_END'), id: z.string() }),
  z.object({
    t: z.literal('MATCH_END'),
    winner: seat,
    final: z.tuple([num, num]),
    summary: z.array(z.string()),
  }),
  z.object({ t: z.literal('MATCH_ABORT') }),
  z.object({ t: z.literal('TUNING'), values: z.record(z.string(), num) }),
  z.object({ t: z.literal('ERROR'), code: z.string(), message: z.string() }),
]);

export const s2cSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('WELCOME'), clientId: z.string(), st: num }),
  z.object({ t: z.literal('PONG'), c0: num, st: num }),
  z.object({
    t: z.literal('PAIRED'),
    seat,
    room: z.string(),
    sport: sportId,
    opponent: z.string().nullable(),
  }),
  z.object({
    t: z.literal('CUE'),
    kind: z.enum(['hit', 'whiff', 'point_won', 'point_lost', 'your_serve', 'incoming', 'match_end']),
  }),
  z.object({
    t: z.literal('LITE'),
    points: z.tuple([num, num]),
    yourServe: z.boolean(),
    phase,
    rally: num,
    you: seat,
    opponent: z.string().nullable(),
    gamePoint: z.boolean(),
    ready: z.tuple([z.boolean(), z.boolean()]),
    seated: z.tuple([z.boolean(), z.boolean()]),
  }),
  z.object({ t: z.literal('ERROR'), code: z.string(), message: z.string() }),
]);

// ── Hot-path guards (see file header) ─────────────────────────────────────────

export function isSnapshotish(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.tick === 'number' &&
    typeof s.t === 'number' &&
    typeof s.phase === 'string' &&
    Array.isArray(s.players) &&
    typeof s.score === 'object' &&
    s.score !== null
  );
}

export function isLocalPoseish(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.seat === 'number' &&
    Array.isArray(m.q) &&
    (m.q as unknown[]).length === 4 &&
    (m.q as unknown[]).every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function safeParse<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  const first = result.error.issues[0];
  return {
    ok: false,
    error: first ? `${first.path.join('.') || '<root>'}: ${first.message}` : 'invalid',
  };
}

/** Parse a JSON string and validate it in one step. Never throws. */
export function parseMessage<T>(schema: z.ZodType<T>, raw: string): ParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  return safeParse(schema, json);
}
