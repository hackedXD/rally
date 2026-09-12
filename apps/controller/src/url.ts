/**
 * The browser-only half of getting connected.
 *
 * Kept out of `net.ts` so the transport itself depends on nothing but
 * `WebSocket` — which means it can be driven from a test, and a test that drives
 * the real client is the only kind that catches a message-ordering bug.
 */

import type { Seat } from '@rally/protocol';
import type { Pairing } from './net.js';

/** Same-origin WebSocket URL, so a tunnel needs no configuration. */
export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/**
 * Parse the pairing out of the URL FRAGMENT.
 *
 * The token is in the fragment and not the query string on purpose: fragments are
 * not sent to the server in the HTTP request line, so a single-use pair token
 * never lands in an access log.
 */
export function readPairing(): Pairing | null {
  const frag = location.hash.replace(/^#/, '');
  if (!frag) return null;
  const params = new URLSearchParams(frag);
  const room = params.get('r');
  const seat = Number(params.get('s'));
  const token = params.get('t');
  if (!room || !token || !Number.isInteger(seat) || seat < 0 || seat > 3) return null;
  return { room: room.toUpperCase(), seat: seat as Seat, token };
}
