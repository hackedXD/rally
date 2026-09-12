/**
 * The phone.
 *
 * One screen: your name, the score, a large SERVE button when it is your turn, a
 * connection dot, and a mute button. Nothing else — the player is looking at the
 * display, not at this.
 *
 * The whole flow is four states:
 *
 *   gate     one tap, which grants motion, orientation and the wake lock at once
 *   calib    1.5 seconds of "hold it like a paddle, pointing at your screen"
 *   play     pose at 30 Hz, swings immediately
 *   paused   backgrounding Safari suspends the sensors; say so and offer resume
 */

import { Calibrator } from '@rally/motion';
import { TUNING, sanitizeName, type CueKind, type Seat } from '@rally/protocol';
import { haptics } from './haptics.js';
import { ControllerNet, readPairing, wsUrl, type LiteState } from './net.js';
import {
  detectAccelSign,
  reacquireWakeLock,
  releaseWakeLock,
  requestSensors,
  startSensors,
  type SensorStream,
} from './sensors.js';
import './style.css';

const app = document.getElementById('app')!;
const pairing = readPairing();

let net: ControllerNet | null = null;
let sensors: SensorStream | null = null;
let lite: LiteState | null = null;
let seat: Seat = pairing?.seat ?? 0;
let opponent: string | null = null;
let connState: 'connecting' | 'open' | 'closed' = 'connecting';
let playerName = loadName();
let muted = false;
let lastCue: { kind: CueKind; at: number } | null = null;
let paused = false;
let swingCount = 0;
let lastSwingSpeed = 0;
let calibration: ReturnType<Calibrator['finish']> | null = null;

// ── Entry ─────────────────────────────────────────────────────────────────────

if (!pairing) {
  renderFatal(
    'Scan the QR code',
    'Open the Rally display on a laptop or iPad and scan the code it shows. This page needs the pairing details from that code.',
  );
} else {
  renderGate();
}

// ── Gate ──────────────────────────────────────────────────────────────────────

function renderGate(message?: string): void {
  app.innerHTML = '';
  const gate = el('div', 'gate');
  gate.append(
    html(`<h1>Rally<span>.</span></h1>`),
    html(`<div class="room">${pairing!.room} · seat ${pairing!.seat + 1}</div>`),
    html(
      `<p>${
        message ??
        'Hold your phone like a paddle. One tap turns on the sensors and keeps the screen awake.'
      }</p>`,
    ),
  );

  const button = el('button', message ? 'tap err' : 'tap');
  button.textContent = message ? 'Try again' : 'Tap to play';
  // Everything below must happen inside this one gesture. iOS grants motion
  // permission only from a real user gesture, and only once per gesture.
  button.addEventListener('click', () => void onTap(button));
  gate.append(button);
  app.append(gate);
}

async function onTap(button: HTMLElement): Promise<void> {
  button.textContent = 'Starting…';
  haptics.unlock();
  const grant = await requestSensors();
  if (!grant.motion || !grant.orientation) {
    renderGate(grant.reason ?? 'Motion access was declined.');
    return;
  }
  startCalibration();
}

// ── Calibration ───────────────────────────────────────────────────────────────

function startCalibration(): void {
  // During calibration nothing is sent anywhere; the fusion just needs samples.
  sensors = startSensors({ onPose: noop, onSwing: noop });
  const calibrator = new Calibrator();
  let started = false;
  let signChecked = false;

  app.innerHTML = '';
  const wrap = el('div', 'calib');
  wrap.append(
    html('<h2>Hold it like a paddle</h2>'),
    html('<p>Point the screen of your phone at your display, and hold still.</p>'),
  );
  const ring = el('div', 'ring');
  ring.innerHTML = `
    <svg width="190" height="190" viewBox="0 0 190 190">
      <circle cx="95" cy="95" r="84" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="10"/>
      <circle id="arc" cx="95" cy="95" r="84" fill="none" stroke="#4ade80" stroke-width="10"
              stroke-linecap="round" stroke-dasharray="528" stroke-dashoffset="528"/>
    </svg>
    <div class="pct">0%</div>`;
  wrap.append(ring);
  app.append(wrap);

  const arc = ring.querySelector('#arc') as SVGCircleElement;
  const pct = ring.querySelector('.pct') as HTMLElement;

  const tick = (): void => {
    const f = sensors!.fusion;
    if (!f.ready) {
      requestAnimationFrame(tick);
      return;
    }
    // Verify the accelerometer's sign on device before it matters (§8.1.1).
    if (!signChecked && sensors!.sampleCount() > 20) {
      signChecked = true;
      const sign = detectAccelSign(f);
      if (sign !== TUNING.motion.accelSign) {
        TUNING.motion.accelSign = sign;
        console.info('[rally] accelerometer sign detected as', sign);
      }
    }
    if (!started) {
      started = true;
      calibrator.start(performance.now());
    }
    const progress = calibrator.feed(performance.now(), f.deviceQ);
    arc.style.strokeDashoffset = String(528 * (1 - progress.progress));
    pct.textContent = `${Math.round(progress.progress * 100)}%`;

    if (!progress.done) {
      requestAnimationFrame(tick);
      return;
    }
    calibration = calibrator.finish(f);
    haptics.play('serve');
    connect();
  };
  requestAnimationFrame(tick);
}

// ── Connect and play ──────────────────────────────────────────────────────────

function connect(): void {
  net = new ControllerNet(wsUrl(), pairing!, {
    onState: (state) => {
      connState = state;
      if (state === 'open' && sensors) {
        net!.calibrated(sensors.fusion.yawOffset);
        net!.ready(playerName);
      }
      renderPlay();
    },
    onPaired: (s, opp) => {
      seat = s;
      opponent = opp;
      renderPlay();
    },
    onCue: (kind) => {
      lastCue = { kind, at: performance.now() };
      haptics.play(cueToClick(kind));
      renderPlay();
    },
    onLite: (l) => {
      const wasServe = lite?.yourServe;
      const wasPhase = lite?.phase;
      lite = l;
      if (l.yourServe && !wasServe) haptics.play('serve');
      // Re-zero yaw at every serve. Gyro yaw drifts and iOS `alpha` has no
      // absolute reference to pull it back, so without this the paddle slowly
      // stops aiming where the player is pointing — the single most common
      // complaint, and it costs nothing to fix here.
      if (l.phase === 'serve' && wasPhase !== 'serve' && sensors) {
        calibration = sensors.fusion.rezeroYaw();
        net?.calibrated(sensors.fusion.yawOffset);
      }
      renderPlay();
    },
    onError: (code, message) => {
      renderFatal(code === 'SEAT_TAKEN' ? 'Seat already taken' : 'Cannot join', message);
      net?.close();
      net = null;
    },
  });

  // Re-attach the sensor stream now that there is somewhere to send to. One
  // attachment path, so the pose and swing handlers cannot drift apart.
  sensors?.stop();
  sensors = startSensors({
    onPose: (q, t) => {
      if (!paused) net?.pose(q, t);
    },
    onSwing: (swing) => {
      if (paused) return;
      net?.swing(swing);
      swingCount++;
      lastSwingSpeed = swing.speed;
      haptics.play('hit');
      renderPlay();
    },
  });
  // The calibration is carried across: the new Fusion starts from scratch, so
  // re-apply the pose the player was holding when they calibrated.
  if (calibration) sensors.fusion.setCalibration(calibration);

  net.connect();
  renderPlay();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

let renderQueued = false;
function renderPlay(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    draw();
  });
}

function draw(): void {
  const mine = lite ? lite.points[seat === 0 ? 0 : 1] : 0;
  const theirs = lite ? lite.points[seat === 0 ? 1 : 0] : 0;
  const yourServe = lite?.yourServe ?? false;
  const phase = lite?.phase ?? 'lobby';

  const cueAge = lastCue ? performance.now() - lastCue.at : 1e9;
  const cueClass =
    cueAge < 380 && lastCue
      ? lastCue.kind === 'hit'
        ? 'hit'
        : lastCue.kind === 'whiff'
          ? 'whiff'
          : lastCue.kind === 'incoming'
            ? 'incoming'
            : ''
      : '';

  app.innerHTML = `
    <div class="bar">
      <span class="dot ${connState === 'open' ? '' : connState === 'connecting' ? 'warn' : 'bad'}"></span>
      <span class="name">${escapeHtml(playerName)}</span>
      <button class="icon-btn ${muted ? 'on' : ''}" id="mute" aria-label="Mute commentary">
        ${muted ? '🔇' : '🔊'}
      </button>
    </div>

    <div class="score">
      <div class="s me">
        <div class="l">You</div>
        <div class="v">${mine}</div>
      </div>
      <div class="sep"></div>
      <div class="s">
        <div class="l">${escapeHtml(opponent ?? lite?.opponent ?? 'Them')}</div>
        <div class="v">${theirs}</div>
      </div>
    </div>

    <div class="status ${statusClass(phase, yourServe, lite?.gamePoint ?? false)}">
      ${statusText(phase, yourServe, lite)}
    </div>

    <div class="swing-area ${cueClass}">
      <div class="hint">${swingHint(phase, yourServe)}</div>
    </div>

    <button class="serve-btn" id="serve" ${yourServe && phase === 'serve' ? '' : 'hidden'}>
      SERVE
    </button>

    <div class="foot">
      <span>${swingCount} swings</span>
      <span>${lastSwingSpeed ? lastSwingSpeed.toFixed(1) + ' m/s' : '—'}</span>
      <span>${net ? Math.round(net.rtt) : 0} ms</span>
    </div>
  `;

  app.querySelector('#serve')?.addEventListener('click', () => {
    net?.serve();
    haptics.play('serve');
  });
  app.querySelector('#mute')?.addEventListener('click', () => {
    muted = !muted;
    haptics.enabled = !muted;
    net?.mute();
    renderPlay();
  });

  if (paused) renderPausedOverlay();
}

function statusText(phase: string, yourServe: boolean, l: LiteState | null): string {
  if (connState !== 'open') return connState === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  if (l?.gamePoint) return 'MATCH POINT';
  switch (phase) {
    case 'lobby':
      return 'Waiting for the match to start';
    case 'serve':
      return yourServe ? 'Your serve' : 'Their serve';
    case 'rally':
      return `Rally · ${l?.rally ?? 0} shots`;
    case 'point':
      return 'Point over';
    case 'paused':
      return 'Paused';
    case 'gameover':
      return 'Match over';
    default:
      return '';
  }
}

function statusClass(phase: string, yourServe: boolean, gamePoint: boolean): string {
  if (gamePoint) return 'hot';
  if (phase === 'serve' && yourServe) return 'good';
  return '';
}

function swingHint(phase: string, yourServe: boolean): string {
  if (phase === 'serve' && yourServe) return 'Tap SERVE, or just swing';
  if (phase === 'rally') return 'Swing when the ring closes';
  if (phase === 'lobby') return 'Hold the phone like a paddle';
  return 'Get ready';
}

function renderPausedOverlay(): void {
  const overlay = el('div', 'overlay');
  overlay.innerHTML = `
    <div>
      <h2>Paused</h2>
      <p>Safari stops the motion sensors when the page is in the background.</p>
      <button id="resume">Tap to resume</button>
    </div>`;
  overlay.querySelector('#resume')?.addEventListener('click', () => {
    paused = false;
    net?.paused(false);
    void reacquireWakeLock();
    renderPlay();
  });
  app.append(overlay);
}

function renderFatal(title: string, message: string): void {
  app.innerHTML = '';
  const gate = el('div', 'gate');
  gate.append(html(`<h1>${escapeHtml(title)}</h1>`), html(`<p>${escapeHtml(message)}</p>`));
  app.append(gate);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

// Backgrounding Safari suspends the sensor stream, so say so rather than letting
// the paddle silently freeze mid-rally.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    paused = true;
    net?.paused(true);
  } else {
    void reacquireWakeLock();
  }
  renderPlay();
});

window.addEventListener('pagehide', () => {
  releaseWakeLock();
  net?.close();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function el(tag: string, className = ''): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function html(markup: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as HTMLElement;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function cueToClick(kind: CueKind): Parameters<typeof haptics.play>[0] {
  switch (kind) {
    case 'hit':
      return 'hit';
    case 'whiff':
      return 'whiff';
    case 'incoming':
      return 'incoming';
    case 'point_won':
      return 'won';
    case 'point_lost':
      return 'lost';
    default:
      return 'serve';
  }
}

function loadName(): string {
  const stored = localStorage.getItem('rally.name');
  if (stored) return sanitizeName(stored);
  const generated = pick(ADJECTIVES) + ' ' + pick(NOUNS);
  const name = sanitizeName(generated);
  localStorage.setItem('rally.name', name);
  return name;
}

const ADJECTIVES = ['Swift', 'Lucky', 'Bold', 'Calm', 'Sly', 'Keen', 'Wild'];
const NOUNS = ['Otter', 'Falcon', 'Comet', 'Pike', 'Ember', 'Moth', 'Fox'];
const pick = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)];

function noop(): void {
  /* placeholder until the socket exists */
}
