/**
 * Regression tests for the QR code's origin.
 *
 * Handing a phone a `localhost` URL is the most confusing failure this project
 * has: the phone opens its OWN localhost, gets nothing, and shows a blank screen
 * with no error to go on.
 */

import { describe, expect, it } from 'vitest';
import { isLoopbackHost, lanAddress, resolveOrigin, splitHost } from '../apps/server/src/origin.js';

const opts = { lan: '192.168.1.50', port: 8787 };

describe('QR origin resolution', () => {
  it('never hands a phone a loopback URL when a LAN address exists', () => {
    for (const host of ['localhost:8787', '127.0.0.1:8787', '0.0.0.0:8787', 'localhost']) {
      const origin = resolveOrigin({ host }, opts);
      expect(origin, host).toBe('http://192.168.1.50:8787');
      expect(origin).not.toContain('localhost');
      expect(origin).not.toContain('127.0.0.1');
    }
  });

  it('keeps the loopback host when the machine has no LAN address', () => {
    // Nothing better to offer; the server logs a warning telling you to tunnel.
    expect(resolveOrigin({ host: 'localhost:8787' }, { lan: null, port: 8787 })).toBe(
      'http://localhost:8787',
    );
  });

  it('never guesses HTTPS from the hostname', () => {
    // This server does not terminate TLS. Without a forwarded protocol the
    // request arrived over plain HTTP, whatever the host looks like — and a URL
    // that cannot connect is worse than one that merely cannot use the sensors.
    expect(resolveOrigin({ host: 'rally.example.dev' }, opts)).toBe(
      'http://rally.example.dev',
    );
    // A LAN address is already reachable by a phone; leave it alone.
    expect(resolveOrigin({ host: '192.168.1.50:8787' }, opts)).toBe(
      'http://192.168.1.50:8787',
    );
  });

  it('honours a proxy verbatim, loopback or not', () => {
    expect(
      resolveOrigin(
        { host: 'localhost:8787', 'x-forwarded-host': 'abc.trycloudflare.com', 'x-forwarded-proto': 'https' },
        opts,
      ),
    ).toBe('https://abc.trycloudflare.com');
    // A proxy that terminates on loopback still knows best.
    expect(
      resolveOrigin({ host: '127.0.0.1:8787', 'x-forwarded-proto': 'https' }, opts),
    ).toBe('https://127.0.0.1:8787');
  });

  it('lets explicit configuration win over everything, without a trailing slash', () => {
    expect(
      resolveOrigin(
        { host: 'localhost:8787', 'x-forwarded-host': 'other.example' },
        { ...opts, configured: 'https://rally.example.dev/' },
      ),
    ).toBe('https://rally.example.dev');
  });

  it('falls back to the listening port when the Host header carries none', () => {
    expect(resolveOrigin({ host: 'localhost' }, opts)).toBe('http://192.168.1.50:8787');
  });

  it('splits hosts without mangling IPv6 literals', () => {
    expect(splitHost('localhost:8787')).toEqual(['localhost', '8787']);
    expect(splitHost('rally.example.dev')).toEqual(['rally.example.dev', null]);
    expect(splitHost('[::1]')).toEqual(['[::1]', null]);
    expect(splitHost('[::1]:8787')).toEqual(['[::1]', '8787']);
  });

  it('recognises every loopback spelling', () => {
    for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]', '0.0.0.0']) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    expect(isLoopbackHost('192.168.1.50')).toBe(false);
    expect(isLoopbackHost('rally.example.dev')).toBe(false);
  });

  it('picks a real external IPv4 and ignores loopback interfaces', () => {
    const fake = () => ({
      lo0: [
        { family: 'IPv4', internal: true, address: '127.0.0.1' } as never,
      ],
      en0: [
        { family: 'IPv6', internal: false, address: 'fe80::1' } as never,
        { family: 'IPv4', internal: false, address: '10.0.0.7' } as never,
      ],
    });
    expect(lanAddress(fake as never)).toBe('10.0.0.7');
    expect(lanAddress((() => ({})) as never)).toBeNull();
  });
});
