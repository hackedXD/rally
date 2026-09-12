/**
 * The connection wrapper: one place where bytes become validated messages and
 * back again.
 *
 * Coding standard 2 lives here — every inbound message is Zod-validated at the
 * boundary, and a malformed one logs and drops rather than throwing into the
 * tick loop. A client that sends garbage should cost the server one log line,
 * not a match.
 */

import type { WebSocket } from 'ws';
import {
  ClockSync,
  TUNING,
  encodeAudioFrame,
  inboundSchema,
  median,
  parseMessage,
  shortId,
  type AnyInbound,
  type Millis,
  type S2C,
  type S2D,
  type Seat,
} from '@rally/protocol';
import { log } from './log.js';

export type Role = 'display' | 'controller' | 'unknown';

export class Conn {
  readonly id = shortId(8);
  role: Role = 'unknown';
  roomCode: string | null = null;
  seat: Seat | null = null;
  muted = false;
  audioUnlocked = false;
  /** Set false after a failed heartbeat; the session manager reaps these. */
  alive = true;
  lastSeen = 0;

  /**
   * Client -> server clock offset, needed to rewind a swing.
   *
   * The server cannot measure round-trip time on its own (the gap between its
   * PONG and the client's next PING is dominated by the client's 2 s ping
   * interval), so the client reports the RTT it measured and the server does the
   * arithmetic. Median over a window, for the same reason the client uses one: a
   * single wifi hiccup must not shift the clock.
   */
  private offsets: number[] = [];
  private offsetCache = 0;
  rtt = 0;

  constructor(
    readonly ws: WebSocket,
    private readonly now: () => Millis,
  ) {
    this.lastSeen = now();
  }

  get clockOffset(): number {
    return this.offsetCache;
  }

  get clockSynced(): boolean {
    return this.offsets.length >= 3;
  }

  /** Called on every PING. `stRecv` is server time at arrival. */
  observePing(c0: number, stRecv: Millis, rtt?: number): void {
    const half = rtt !== undefined && rtt >= 0 && rtt < 4000 ? rtt / 2 : 0;
    if (rtt !== undefined && rtt >= 0 && rtt < 4000) this.rtt = rtt;
    const offset = stRecv - c0 - half;
    if (!Number.isFinite(offset)) return;
    this.offsets.push(offset);
    while (this.offsets.length > TUNING.net.clockWindow) this.offsets.shift();
    this.offsetCache = median(this.offsets);
  }

  /** Convert a client timestamp into server time. */
  toServer(clientTime: number): Millis {
    return clientTime + this.offsetCache;
  }

  send(msg: S2C | S2D): void {
    if (this.ws.readyState !== 1) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      log.warn('send failed', this.id, err);
    }
  }

  /** Streaming audio travels as binary frames, not JSON. */
  sendAudio(cueId: string, audio: Uint8Array): void {
    if (this.ws.readyState !== 1) return;
    try {
      this.ws.send(encodeAudioFrame(cueId, audio), { binary: true });
    } catch (err) {
      log.warn('audio frame failed', this.id, err);
    }
  }

  close(code = 1000, reason = 'bye'): void {
    try {
      this.ws.close(code, reason);
    } catch {
      /* already gone */
    }
  }
}

export type InboundHandler = (conn: Conn, msg: AnyInbound) => void;

/** Wire up message parsing for one socket. */
export function attachParser(conn: Conn, onMessage: InboundHandler): void {
  conn.ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (isBinary) return; // clients never send binary
    const raw = Array.isArray(data) ? Buffer.concat(data).toString() : data.toString();
    if (raw.length > 8192) {
      log.warn('oversized message dropped', conn.id, raw.length);
      return;
    }
    const parsed = parseMessage(inboundSchema, raw);
    if (!parsed.ok) {
      log.warn('invalid message dropped', conn.id, parsed.error, raw.slice(0, 120));
      return;
    }
    try {
      onMessage(conn, parsed.value);
    } catch (err) {
      // A handler throwing must never take the tick loop with it.
      log.error('handler threw', conn.id, err);
    }
  });
}

export { ClockSync };
