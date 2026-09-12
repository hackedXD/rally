/**
 * Every byte that crosses a process boundary is described here.
 *
 * Conventions (coding standard 7): message type names are SCREAMING_SNAKE,
 * payload fields are camelCase, field names stay short — pose goes out at
 * 30 Hz per player.
 */

import type { CueClass, GameEvent } from './events.js';
import type { Millis, Quat, Seat, SportId, Vec3 } from './primitives.js';
import type { MatchPhase, Snapshot, SportMeta } from './state.js';
import type { TuningPatch } from './tuning.js';

/** A unit quaternion packed into four int16s. See `quantQuat` in math.ts. */
export type QuantQuat = [number, number, number, number];

/** What the controller measured at the peak of a swing. */
export interface SwingInput {
  /** Peak hand speed, m/s. */
  speed: number;
  /** Unit swing direction, world frame, yaw-corrected. */
  dir: Vec3;
  /** Paddle orientation at peak. */
  q: Quat;
  /** Elevation of the swing velocity, radians. */
  elev: number;
  /** Client clock at the peak sample. */
  ctPeak: number;
}

// ── controller → server ───────────────────────────────────────────────────────

export type C2S =
  | { t: 'HELLO'; role: 'controller'; room: string; seat: Seat; pairToken: string }
  /**
   * `rtt` is the client's own latest round-trip measurement. The server needs a
   * client->server clock offset to rewind a swing (lag compensation), and the
   * only side that can measure round-trip time is the side that sent the ping —
   * so it comes back with the next one. Optional: absent on the first ping.
   */
  | { t: 'PING'; c0: number; rtt?: number }
  | { t: 'POSE'; seq: number; ct: number; q: QuantQuat }
  | {
      t: 'SWING';
      seq: number;
      ctPeak: number;
      speed: number;
      dir: Vec3;
      q: Quat;
      elev: number;
    }
  | { t: 'BUTTON'; button: 'serve' | 'mute' }
  | { t: 'CALIBRATED'; yawOffset: number }
  | { t: 'READY'; name: string }
  | { t: 'PAUSE'; paused: boolean };

// ── display → server ──────────────────────────────────────────────────────────

export type D2S =
  | { t: 'HELLO'; role: 'display' }
  | { t: 'PING'; c0: number; rtt?: number }
  | { t: 'ROOM_CREATE'; sport: SportId }
  | { t: 'ROOM_JOIN'; room: string }
  | { t: 'SPORT_SELECT'; sport: SportId }
  | { t: 'ADD_BOT'; skill: number }
  | { t: 'READY' }
  | { t: 'START' }
  | { t: 'REMATCH' }
  | { t: 'AUDIO_UNLOCKED' }
  | { t: 'MUTE'; muted: boolean }
  /** Dev-only live constant tuning (`tools/tune`). */
  | { t: 'TUNE'; patch: TuningPatch };

// ── server → controller ───────────────────────────────────────────────────────

export type CueKind =
  | 'hit'
  | 'whiff'
  | 'point_won'
  | 'point_lost'
  | 'your_serve'
  | 'incoming'
  | 'match_end';

export type S2C =
  | { t: 'WELCOME'; clientId: string; st: Millis }
  | { t: 'PONG'; c0: number; st: Millis }
  | { t: 'PAIRED'; seat: Seat; room: string; sport: SportId; opponent: string | null }
  | { t: 'CUE'; kind: CueKind }
  | {
      t: 'LITE';
      points: [number, number];
      yourServe: boolean;
      phase: MatchPhase;
      rally: number;
      you: Seat;
      opponent: string | null;
      gamePoint: boolean;
    }
  | { t: 'ERROR'; code: string; message: string };

// ── server → display ──────────────────────────────────────────────────────────

export interface SeatInfo {
  seat: Seat;
  name: string | null;
  ready: boolean;
  paired: boolean;
  bot: boolean;
  connected: boolean;
}

export interface PreloadedCue {
  id: string;
  /** For subtitles and debugging. */
  text: string;
  /** base64 mp3. Empty when the voice provider is client-side speech synthesis. */
  audioB64: string;
  durationMs: number;
  layer: 'cache' | 'speculative' | 'fallback';
  /** Cue class this clip was written for; drives arbitration. */
  cls: CueClass;
  /** True when the display must speak `text` itself via speechSynthesis. */
  speak?: boolean;
}

export type S2D =
  | { t: 'WELCOME'; clientId: string; st: Millis }
  | { t: 'PONG'; c0: number; st: Millis }
  | {
      t: 'ROOM_STATE';
      room: string;
      seat: Seat;
      pairToken: string;
      /** Fully-formed controller URL for the QR code, token in the fragment. */
      pairUrl: string;
      /**
       * Opens this room on a second machine. Share it to play a human who is
       * somewhere else: their display takes the other seat and pairs its own
       * phone.
       */
      joinUrl: string;
      /**
       * The OTHER seat's phone link, offered to this display only while no second
       * display has claimed that seat — which is what lets one screen host two
       * phones sitting next to each other.
       *
       * Null the moment a friend's display joins. A pair token is single-use, so
       * a code shown in two places at once fails on whichever scan arrives
       * second, and that failure looks exactly like a broken QR.
       */
      otherPairUrl: string | null;
      sport: SportId;
      seats: SeatInfo[];
      sports: SportMeta[];
      /** True when this display created the room and may change the sport. */
      host: boolean;
    }
  | { t: 'MATCH_START'; sport: SportId; st: Millis; names: [string, string] }
  /** Lobby progress while the commentator's cold bank is being written. */
  | { t: 'LOBBY_STATUS'; text: string; progress: number; done: boolean }
  | { t: 'SNAPSHOT'; s: Snapshot }
  | { t: 'LOCALPOSE'; seat: Seat; q: Quat; ct: number }
  | { t: 'EVENT'; e: GameEvent }
  | { t: 'CUE_PRELOAD'; cues: PreloadedCue[] }
  | { t: 'CUE_PLAY'; id: string; priority: 0 | 1 | 2 | 3 }
  | {
      t: 'CUE_STREAM_BEGIN';
      id: string;
      priority: 0 | 1 | 2 | 3;
      mime: string;
      /** Present when the display must speak the line itself. */
      speak?: boolean;
      text?: string;
    }
  | { t: 'CUE_TEXT'; id: string; text: string }
  | { t: 'CUE_STREAM_END'; id: string }
  | { t: 'MATCH_END'; winner: Seat; final: [number, number]; summary: string[] }
  | { t: 'TUNING'; values: Record<string, number> }
  | { t: 'ERROR'; code: string; message: string };

/**
 * Streaming audio chunks for CUE_STREAM_* travel as binary WebSocket frames
 * between BEGIN and END, not as JSON.
 *
 *   byte 0        cue-id length (n)
 *   bytes 1..n    cue id, ASCII
 *   bytes n+1..   raw audio
 */
export function encodeAudioFrame(cueId: string, audio: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(cueId);
  if (id.length > 255) throw new Error('cue id too long for a binary frame');
  const out = new Uint8Array(1 + id.length + audio.length);
  out[0] = id.length;
  out.set(id, 1);
  out.set(audio, 1 + id.length);
  return out;
}

export function decodeAudioFrame(
  frame: Uint8Array,
): { id: string; audio: Uint8Array } | null {
  if (frame.length < 1) return null;
  const n = frame[0];
  if (frame.length < 1 + n) return null;
  const id = new TextDecoder().decode(frame.subarray(1, 1 + n));
  return { id, audio: frame.subarray(1 + n) };
}

export type AnyInbound = C2S | D2S;
export type AnyOutbound = S2C | S2D;
