/**
 * mock-controller — replaces W1 so the server, simulation and display can all be
 * built before a phone exists.
 *
 * Keyboard-driven, and it emits REAL `POSE` and `SWING` messages over a real
 * WebSocket, so nothing downstream knows it is a mock. That is the rule for
 * everything in this directory.
 *
 *   npm run mock:controller -- --room ABCD --seat 0 --token <t>
 *   npm run mock:controller -- --room ABCD --seat 0 --token <t> --auto
 *
 * Arrow keys aim, space swings, enter serves, q quits.
 */

import WebSocket from 'ws';
import {
  TUNING,
  qFromUnitZTo,
  quantQuat,
  vnorm,
  type Seat,
  type Vec3,
} from '@rally/protocol';

const args = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const url = flag('url', 'ws://localhost:8787/ws');
const room = flag('room', '').toUpperCase();
const seat = Number(flag('seat', '0')) as Seat;
const token = flag('token', '');
const name = flag('name', 'Keys');
const auto = has('auto');

if (!room || !token) {
  console.error(
    'usage: npm run mock:controller -- --room ABCD --seat 0 --token <pairToken>\n' +
      '(the display prints the pair URL under its QR code)',
  );
  process.exit(1);
}

let aimX = 0;
let aimY = 0.28;
let charge = 0;
let seq = 0;
let yourServe = false;
let phase = 'lobby';

const ws = new WebSocket(url);

ws.on('open', () => {
  console.log(`[mock-controller] connected as seat ${seat} in room ${room}`);
  send({ t: 'HELLO', role: 'controller', room, seat, pairToken: token });
  send({ t: 'CALIBRATED', yawOffset: 0 });
  send({ t: 'READY', name });
  setInterval(() => send({ t: 'PING', c0: performance.now() }), TUNING.net.pingIntervalMs);
  setInterval(sendPose, 1000 / TUNING.net.poseHz);
  setInterval(tick, 1000 / 60);
});

ws.on('message', (data: Buffer) => {
  try {
    const msg = JSON.parse(data.toString()) as {
      t: string;
      yourServe?: boolean;
      phase?: string;
      message?: string;
    };
    if (msg.t === 'LITE') {
      yourServe = Boolean(msg.yourServe);
      phase = msg.phase ?? phase;
    } else if (msg.t === 'ERROR') {
      console.error('[mock-controller] server said:', msg.message);
      process.exit(1);
    }
  } catch {
    /* not our message */
  }
});

ws.on('close', () => {
  console.log('[mock-controller] disconnected');
  process.exit(0);
});

function send(msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function aimVector(): Vec3 {
  const horiz = Math.cos(aimY * 0.9);
  return vnorm([aimX * 0.85 * horiz, Math.sin(aimY * 0.9), horiz]);
}

function sendPose(): void {
  send({ t: 'POSE', seq: seq++, ct: performance.now(), q: quantQuat(qFromUnitZTo(aimVector())) });
}

function swing(speed: number): void {
  const aim = aimVector();
  send({
    t: 'SWING',
    seq: seq++,
    ctPeak: performance.now(),
    speed,
    dir: aim,
    q: qFromUnitZTo(aim),
    elev: Math.asin(Math.max(-1, Math.min(1, aim[1]))),
  });
  process.stdout.write(`swing ${speed.toFixed(1)} m/s  aim ${aimX.toFixed(2)}\n`);
}

let frame = 0;
function tick(): void {
  charge = Math.min(1, charge + 1 / 36);
  if (!auto) return;
  // Auto mode plays a loose rhythm on its own: enough to keep a room alive while
  // you work on something else.
  frame++;
  if (phase === 'serve' && yourServe && frame % 90 === 0) send({ t: 'BUTTON', button: 'serve' });
  if (phase === 'rally' && frame % 42 === 0) {
    aimX = (Math.random() * 2 - 1) * 0.6;
    aimY = 0.2 + Math.random() * 0.25;
    swing(3 + Math.random() * 5);
  }
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

const ESC = '\u001b';
const ARROW_UP = `${ESC}[A`;
const ARROW_DOWN = `${ESC}[B`;
const ARROW_RIGHT = `${ESC}[C`;
const ARROW_LEFT = `${ESC}[D`;
const CTRL_C = '\u0003';

if (!auto && process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  console.log('arrows aim | space swings | enter serves | q quits');

  process.stdin.on('data', (key: string) => {
    switch (key) {
      case ARROW_UP:
        aimY = Math.min(0.95, aimY + 0.08);
        break;
      case ARROW_DOWN:
        aimY = Math.max(-0.3, aimY - 0.08);
        break;
      case ARROW_RIGHT:
        aimX = Math.min(1, aimX + 0.12);
        break;
      case ARROW_LEFT:
        aimX = Math.max(-1, aimX - 0.12);
        break;
      case ' ':
        // A terminal reports key-down only, so the charge is how long it has been
        // since the last swing rather than how long the key is held.
        swing(1.6 + charge * (TUNING.motion.speedCeiling - 1.6));
        charge = 0;
        break;
      case '\r':
        send({ t: 'BUTTON', button: 'serve' });
        break;
      case 'q':
      case CTRL_C:
        ws.close();
        process.exit(0);
        break;
      default:
        break;
    }
  });
}
