/**
 * Working out what URL to put in the QR code.
 *
 * This is more subtle than it looks, and getting it wrong produces the most
 * confusing failure in the whole project: a phone scans the code, opens
 * `http://localhost:8787`, reaches its OWN localhost, and shows a blank screen
 * with no explanation at all.
 */

import { networkInterfaces } from 'node:os';

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0)$/i;

/** First non-internal IPv4 address of this machine, or null. */
export function lanAddress(
  interfaces: () => ReturnType<typeof networkInterfaces> = networkInterfaces,
): string | null {
  for (const addrs of Object.values(interfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

/** Split `host:port`, leaving a bracketed IPv6 literal intact. */
export function splitHost(host: string): [string, string | null] {
  if (host.endsWith(']')) return [host, null];
  const at = host.lastIndexOf(':');
  if (at < 0) return [host, null];
  return [host.slice(0, at), host.slice(at + 1)];
}

export interface OriginOptions {
  /** `RALLY_PUBLIC_ORIGIN`, when set. Always wins. */
  configured?: string;
  /** This machine's LAN address, or null if it has none. */
  lan?: string | null;
  /** Port the server is listening on, used when the Host header carries none. */
  port: number;
}

/**
 * The origin the controller QR code should point at.
 *
 * Precedence:
 *   1. Explicit configuration — a tunnel hostname is not knowable at build time.
 *   2. A proxy's forwarded host and protocol, verbatim.
 *   3. The request's own host — unless that is loopback, in which case substitute
 *      the LAN address so a phone on the same wifi can actually reach it.
 *
 * The scheme is never guessed from the hostname. This server does not terminate
 * TLS, so without a forwarded protocol the request arrived over plain HTTP,
 * whatever the host looks like — inferring `https` from "not localhost" hands out
 * a URL that cannot connect at all, which is worse than one that merely cannot
 * use the motion sensors. Deployments behind a TLS terminator get the right
 * answer from `x-forwarded-proto`, or from `RALLY_PUBLIC_ORIGIN`.
 */
export function resolveOrigin(
  headers: Record<string, unknown>,
  opts: OriginOptions,
): string {
  if (opts.configured) return opts.configured.replace(/\/+$/, '');

  const host = String(
    headers['x-forwarded-host'] ?? headers.host ?? `localhost:${opts.port}`,
  );
  const [hostname, port] = splitHost(host);
  const forwardedProto = headers['x-forwarded-proto'];
  const loopback = LOOPBACK.test(hostname);

  // Behind a proxy the forwarded values are authoritative, loopback or not.
  if (!forwardedProto && loopback && opts.lan) {
    return `http://${opts.lan}:${port ?? opts.port}`;
  }
  const proto = String(forwardedProto ?? 'http');
  return `${proto}://${host}`;
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.test(hostname);
}
