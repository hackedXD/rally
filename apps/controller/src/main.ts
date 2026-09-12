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
import { ControllerNet, type LiteState } from './net.js';
import { readPairing, wsUrl } from './url.js';
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

/**
 * Which screen is up.
 *
 * This exists because every lifecycle handler on this page is capable of
 * redrawing, and a redraw that ignores where the player actually is will happily
 * replace the "Tap to play" button with a play screen that has no sensors behind
 * it — leaving the phone stuck on a dead UI with no way forward. `visibilitychange`
 * alone fires on load on a real phone, so this is not a corner case.
 */
type Screen = 'gate' | 'calibrating' | 'playing' | 'fatal';
let screen: Screen = 'gate';

let net: ControllerNet | null = null;
let sensors: SensorStream | null = null;
let lite: LiteState | null = null;
let seat: Seat = pairing?.seat ?? 0;
let opponent: string | null = null;
/**
 * Which sport this room is playing, as of the last PAIRED.
 *
 * The phone only cares for one reason: table tennis runs a different swing
 * detector. Everything else about the controller is sport-agnostic and stays
 * that way.
 */
let sport = 'pickleball';
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
  screen = 'gate';
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
  screen = 'calibrating';
  // During calibration nothing is sent anywhere; the fusion just needs samples.
  sensors = startSensors({ onPose: noop, onSwing: noop });
  sensors.setSport(sport);
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

  const waitingSince = performance.now();
  const tick = (): void => {
    const f = sensors!.fusion;
    if (!f.ready) {
      // A browser can grant motion permission and then never deliver a sample —
      // a desktop with no sensors, or a device that has them switched off. Say so
      // rather than spinning on an empty progress ring forever.
      if (performance.now() - waitingSince > 4000) {
        sensors?.stop();
        renderFatal(
          'No motion from this device',
          'Permission was granted but no sensor readings arrived. This usually means ' +
            'the device has no motion sensors. Use "Play here (mouse)" on the display instead.',
        );
        return;
      }
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

/** Errors that genuinely end the session. Everything else is worth a log line. */
const FATAL_ERRORS = new Set(['NO_ROOM', 'BAD_TOKEN', 'EXPIRED', 'SEAT_TAKEN', 'NO_SEAT']);
const FATAL_TITLES: Record<string, string> = {
  NO_ROOM: 'Room not found',
  BAD_TOKEN: 'Code not valid',
  EXPIRED: 'Code expired',
  SEAT_TAKEN: 'Seat already taken',
  NO_SEAT: 'No such seat',
};

function connect(): void {
  screen = 'playing';
  net = new ControllerNet(wsUrl(), pairing!, {
    onState: (state) => {
      connState = state;
      if (state === 'open' && sensors) {
        net!.calibrated(sensors.fusion.yawOffset);
        net!.ready(playerName);
      }
      renderPlay();
    },
    onPaired: (s, opp, sportId) => {
      seat = s;
      opponent = opp;
      // Which swing detector runs. Table tennis onsets on rotation and reports
      // the wrist rate; everything else onsets on acceleration.
      sport = sportId;
      sensors?.setSport(sportId);
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
      // Only give up on errors that actually end the session. A transient
      // complaint — a message that arrived in the wrong order, say — must not
      // tear down a working connection and strand the player on an error screen.
      if (!FATAL_ERRORS.has(code)) {
        console.warn('[rally] server error:', code, message);
        return;
      }
      renderFatal(FATAL_TITLES[code] ?? 'Cannot join', message);
      net?.close();
      net = null;
    },
  });

  // Re-attach the sensor stream now that there is somewhere to send to. One
  // attachment path, so the pose and swing handlers cannot drift apart.
  sensors?.stop();
  sensors = startSensors({
    onPose: (q, t, reach, hold) => {
      if (!paused) net?.pose(q, t, reach, hold);
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
  // Only the play screen may be drawn by this. Everything else owns its own DOM.
  if (screen !== 'playing') return;
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
  screen = 'fatal';
  app.innerHTML = '';
  const gate = el('div', 'gate');
  gate.append(html(`<h1>${escapeHtml(title)}</h1>`), html(`<p>${escapeHtml(message)}</p>`));
  app.append(gate);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

// Backgrounding Safari suspends the sensor stream, so say so rather than letting
// the paddle silently freeze mid-rally.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') {
    void reacquireWakeLock();
    renderPlay();
    return;
  }
  // Backgrounding Safari suspends the sensor stream. Only meaningful once there
  // is a sensor stream to suspend — before that, going hidden is just the page
  // loading, and treating it as a pause strands the player on a dead screen.
  if (screen !== 'playing') return;
  paused = true;
  net?.paused(true);
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

/**
 * A remembered, speakable name for this player.
 *
 * The word lists live INSIDE the function on purpose. This is called while the
 * module is still evaluating, and module-level `const`s declared further down the
 * file are in the temporal dead zone at that point — reaching one throws, the
 * script dies, and the page renders as a blank screen. It only bites when storage
 * is empty, which is never true in local testing and always true on a phone
 * opening the page for the first time.
 */
function loadName(): string {
  const stored = localStorage.getItem('rally.name');
  if (stored) return sanitizeName(stored);
  const adjectives = ['Swift', 'Lucky', 'Bold', 'Calm', 'Sly', 'Keen', 'Wild'];
  const nouns = ['Otter', 'Falcon', 'Comet', 'Pike', 'Ember', 'Moth', 'Fox'];
  const pick = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)];
  const name = sanitizeName(`${pick(adjectives)} ${pick(nouns)}`);
  try {
    localStorage.setItem('rally.name', name);
  } catch {
    // Private browsing can refuse to store. A name that is not remembered is
    // still a name; it must not take the page down with it.
  }
  return name;
}

function noop(): void {
  /* placeholder until the socket exists */
}
