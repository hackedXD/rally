/**
 * echo-server — replaces W2 so the phone can be built with no real server.
 *
 * Accepts any WebSocket message, validates it against the protocol, logs it, and
 * answers PONG. That is enough for the controller to connect, sync its clock, and
 * stream pose while you work on sensor fusion.
 *
 *   npm run echo
 *   npm run echo -- --port 9000 --verbose
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { hrNowMs, inboundSchema, makeServerClock, parseMessage } from '@rally/protocol';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8788;
const verbose = args.includes('--verbose');

const now = makeServerClock(hrNowMs);
const http = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, mock: 'echo-server' }));
});
const wss = new WebSocketServer({ server: http, path: '/ws' });

const counts = new Map<string, number>();

wss.on('connection', (ws, req) => {
  console.log(`[echo] connected from ${req.socket.remoteAddress}`);
  ws.on('message', (data: Buffer) => {
    const parsed = parseMessage(inboundSchema, data.toString());
    if (!parsed.ok) {
      console.warn('[echo] invalid:', parsed.error, data.toString().slice(0, 120));
      return;
    }
    const msg = parsed.value;
    counts.set(msg.t, (counts.get(msg.t) ?? 0) + 1);
    if (verbose || (msg.t !== 'POSE' && msg.t !== 'PING')) {
      console.log('[echo]', JSON.stringify(msg).slice(0, 200));
    }

    if (msg.t === 'PING') {
      ws.send(JSON.stringify({ t: 'PONG', c0: msg.c0, st: Math.round(now()) }));
    } else if (msg.t === 'HELLO') {
      ws.send(JSON.stringify({ t: 'WELCOME', clientId: 'echo', st: Math.round(now()) }));
      if (msg.role === 'controller') {
        ws.send(
          JSON.stringify({
            t: 'PAIRED',
            seat: msg.seat,
            room: msg.room,
            sport: 'pickleball',
            opponent: 'Echo',
          }),
        );
      }
    } else if (msg.t === 'SWING') {
      ws.send(JSON.stringify({ t: 'CUE', kind: 'hit' }));
    }
  });
  ws.on('close', () => {
    console.log('[echo] disconnected. Messages seen:');
    for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${t.padEnd(12)} ${n}`);
    }
  });
});

http.listen(port, () => {
  console.log(`[echo] ws://localhost:${port}/ws — point the controller here`);
});
