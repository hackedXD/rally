/**
 * Rally server: Fastify for HTTP, raw `ws` for sockets, one 60 Hz tick loop for
 * every room in the process.
 *
 * Socket.IO's reconnection and fallback machinery buys nothing here and adds
 * framing overhead, so this is the raw protocol described in `@rally/protocol`
 * and nothing else.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { WebSocketServer } from 'ws';
import { TUNING, flattenTuning, hrNowMs, makeServerClock } from '@rally/protocol';
import { SPORT_ORDER, getSport } from '@rally/sim';
import { CONFIG, aiStatus } from './config.js';
import { log } from './log.js';
import { NetLoop } from './netloop.js';
import { lanAddress, resolveOrigin } from './origin.js';
import { SessionManager } from './session.js';
import { Conn, attachParser } from './wire.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

/** Server time is the only time (coding standard 6). One monotonic source. */
const serverNow = makeServerClock(hrNowMs);

const app = Fastify({ logger: false, trustProxy: true });
const sessions = new SessionManager(serverNow);

// ── HTTP ──────────────────────────────────────────────────────────────────────

app.get('/healthz', async () => ({
  ok: true,
  uptimeMs: Math.round(serverNow()),
  rooms: sessions.roomCount,
  conns: sessions.connCount,
  tick: loop.snapshot,
  commentary: aiStatus(),
}));

app.get('/api/rooms', async () => ({ rooms: sessions.roomList() }));

app.get('/api/sports', async () => ({
  sports: SPORT_ORDER.map((id) => {
    const s = getSport(id);
    return {
      id: s.id,
      name: s.displayName,
      tagline: s.tagline,
      playable: s.playable,
      rallyBased: s.rallyBased,
      court: s.court,
    };
  }),
}));

app.get('/api/tuning', async () => ({ values: flattenTuning(TUNING) }));

/**
 * The display and controller bundles. In development these are served by Vite
 * (instant HMR matters more than anything else); in production the Node server
 * hosts them so the whole thing is one deployable over one TLS origin.
 */
if (CONFIG.serveStatic) {
  const displayDist = resolve(repoRoot, 'apps/display/dist');
  const controllerDist = resolve(repoRoot, 'apps/controller/dist');

  if (existsSync(controllerDist)) {
    await app.register(fastifyStatic, {
      root: controllerDist,
      prefix: '/c/',
      decorateReply: false,
    });
    // The QR code points at /c; serve the controller there and for any sub-path.
    app.get('/c', (_req, reply) => reply.sendFile('index.html', controllerDist));
  } else {
    log.warn('controller bundle missing; run `npm run build` before serving static');
  }

  if (existsSync(displayDist)) {
    await app.register(fastifyStatic, {
      root: displayDist,
      prefix: '/',
      decorateReply: true,
    });
    // Single-page app: anything unrecognised renders the display.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    log.warn('display bundle missing; run `npm run build` before serving static');
    app.get('/', async () => ({ ok: true, hint: 'run npm run build, or use the Vite dev server' }));
  }
} else {
  app.get('/', async () => ({
    ok: true,
    hint: 'dev mode — open the Vite display at http://localhost:5173',
    ws: '/ws',
  }));
}

// ── WebSockets ────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 16 });

const LAN = lanAddress();

/**
 * The origin used to build the controller QR URL. See `origin.ts` — a phone that
 * scans a `localhost` code reaches its own localhost and shows a blank screen.
 */
const originFromHeaders = (headers: Record<string, unknown>): string =>
  resolveOrigin(headers, {
    configured: CONFIG.publicOrigin,
    lan: LAN,
    port: CONFIG.port,
  });

const connOrigin = new WeakMap<Conn, string>();
sessions.originFor = (conn) => connOrigin.get(conn) ?? `http://localhost:${CONFIG.port}`;

app.server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const conn = new Conn(ws, serverNow);
    connOrigin.set(conn, originFromHeaders(req.headers as Record<string, unknown>));
    sessions.register(conn);
    attachParser(conn, (c, msg) => sessions.handle(c, msg));

    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('close', () => sessions.drop(conn));
    ws.on('error', (err) => {
      log.warn('socket error', conn.id, err.message);
      sessions.drop(conn);
    });
  });
});

/** Heartbeat: reap sockets that have stopped answering. */
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    try {
      client.ping();
    } catch {
      /* it will be closed by the error handler */
    }
  }
}, 15_000);

// ── The loop ──────────────────────────────────────────────────────────────────

const loop = new NetLoop(
  serverNow,
  (dt, t) => sessions.tickRooms(dt, t),
  (t) => sessions.sweep(t),
);

// ── Boot ──────────────────────────────────────────────────────────────────────

const shutdown = async (signal: string): Promise<void> => {
  log.info(`${signal} — shutting down`);
  clearInterval(heartbeat);
  loop.stop();
  sessions.disposeAll();
  for (const client of wss.clients) client.close(1001, 'server shutting down');
  await app.close().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', err));

try {
  await app.listen({ port: CONFIG.port, host: CONFIG.host });
  loop.start();
  log.info(
    `rally server on http://${CONFIG.host}:${CONFIG.port}  ` +
      `tick=${TUNING.net.tickHz}Hz snapshots=${TUNING.net.snapshotHz}Hz`,
  );
  log.info(`commentary: ${aiStatus()}`);
  if (!CONFIG.publicOrigin) {
    log.info(
      LAN
        ? `RALLY_PUBLIC_ORIGIN is unset; QR codes will point at http://${LAN}:${CONFIG.port} ` +
          'so a phone on the same wifi can reach them. For motion sensors a phone also needs ' +
          'HTTPS: run `npm run tunnel` and set RALLY_PUBLIC_ORIGIN to the tunnel URL.'
        : 'RALLY_PUBLIC_ORIGIN is unset and no LAN address was found; QR codes will point at ' +
          'localhost, which a phone cannot reach. Run `npm run tunnel` and set ' +
          'RALLY_PUBLIC_ORIGIN to the tunnel URL.',
    );
  }
} catch (err) {
  log.error('failed to start', err);
  process.exit(1);
}
