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
import {
  NAME_MAX,
  TUNING,
  lane,
  filterName,
  loadName,
  saveName,
  type CueKind,
  type Seat,
} from '@rally/protocol';
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
 * The two icons this screen needs, drawn rather than borrowed.
 *
 * One stroke weight, square caps, sitting on the same grid as the tape — an
 * emoji here renders in somebody else's typeface at somebody else's weight and
 * reads as a sticker left on the screen.
 */
const ICON = (paths: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
        stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${paths}</svg>`;
const SPEAKER = '<path d="M4 9h4l5-4v14l-5-4H4z"/>';
const ICON_MUTED = ICON(`${SPEAKER}<path d="M17 9.5l4 5M21 9.5l-4 5"/>`);
const ICON_SOUND = ICON(`${SPEAKER}<path d="M17 8.5a5 5 0 0 1 0 7"/>`);
/** A door with an arrow leaving it. The way out of a match. */
const ICON_EXIT = ICON('<path d="M14 4H5v16h9"/><path d="M18 12H10M15 8l4 4-4 4"/>');

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
/**
 * Have I readied up for this point?
 *
 * Optimistic, then overwritten by whatever the server says a frame later — a
 * lamp that waits for a round trip feels like a button that missed. Readiness
 * itself belongs to the SERVER: it clears at the end of every point, and a phone
 * that decided for itself when to re-arm would drift out of step with the screen
 * the player is actually looking at.
 */
let localReady = false;

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
      <circle cx="95" cy="95" r="84" fill="none" stroke="rgba(255,255,255,0.26)" stroke-width="10"/>
      <circle id="arc" cx="95" cy="95" r="84" fill="none" stroke="#e3ff33" stroke-width="10"
              stroke-linecap="butt" stroke-dasharray="528" stroke-dashoffset="528"/>
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
      lite = l;
      if (l.yourServe && !wasServe) haptics.play('serve');
      // The server owns readiness; this is where the optimistic lamp is
      // corrected. Yaw is re-zeroed by the READY tap rather than on the serve
      // transition: re-centring on a phone that happens to be pointing at the
      // floor teaches the game that the floor is the far end of the court, and
      // that is drift you can feel arriving.
      localReady = l.ready[lane(seat)];
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
    onPose: (q, t, omegaDeg, reach, sway, hold) => {
      if (!paused) net?.pose(q, t, omegaDeg, reach, sway, hold);
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
  // Seats are numbered for doubles; the two-element wire tuples are indexed by
  // LANE, which is the side of the net. Everything below reads one of those.
  const me = lane(seat);
  const them = me === 0 ? 1 : 0;
  const iAmReady = localReady || (lite?.ready[me] ?? false);
  const theyReady = lite?.ready[them] ?? false;
  // Between points, and at the start of one. Both are the same beat to a player:
  // the ball is dead, put the bat up.
  const readyBeat = phase === 'serve' || phase === 'point';
  const bothReady = iAmReady && theyReady;
  // Nobody is standing there yet, which needs different words from "has not
  // tapped": one is waiting for a tap, the other for a QR scan.
  const theySeated = lite?.seated[them] ?? false;

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
      <button class="name" id="rename" aria-label="Change your name">
        ${escapeHtml(playerName)}
      </button>
      <span class="spacer"></span>
      <button class="icon-btn" id="exit" aria-label="Leave this match"
              ${phase === 'lobby' || phase === 'gameover' ? 'hidden' : ''}>
        ${ICON_EXIT}
      </button>
      <button class="icon-btn ${muted ? 'on' : ''}" id="mute"
              aria-label="${muted ? 'Unmute commentary' : 'Mute commentary'}"
              aria-pressed="${muted}">
        ${muted ? ICON_MUTED : ICON_SOUND}
      </button>
    </div>

    <div class="score">
      <div class="s me">
        <div class="l">You</div>
        <div class="v">${mine}</div>
      </div>
      <div class="sep"></div>
      <div class="s">
        <div class="l">${escapeHtml(lite?.opponent ?? opponent ?? 'Them')}</div>
        <div class="v">${theirs}</div>
      </div>
    </div>

    <div class="status ${statusClass(phase, yourServe, lite?.gamePoint ?? false)}">
      ${statusText(phase, yourServe, lite)}
    </div>

    <div class="swing-area ${cueClass}">
      <div class="hint">${swingHint(phase, yourServe)}</div>
    </div>

    ${readyBeat ? lampsHtml(iAmReady, theyReady, theySeated) : ''}

    ${primaryHtml(phase, yourServe, readyBeat, iAmReady, theyReady, bothReady, theySeated)}

    <div class="foot">
      <span>${swingCount} swings</span>
      <span>${lastSwingSpeed ? lastSwingSpeed.toFixed(1) + ' m/s' : '—'}</span>
      <span>${net ? Math.round(net.rtt) : 0} ms</span>
      <span>${net && net.leadMs >= 1 ? '+' + Math.round(net.leadMs) + ' ms lead' : '—'}</span>
      <span>${sensors?.sampleHz() ? sensors.sampleHz() + ' Hz' : '—'}</span>
    </div>
  `;

  app.querySelector('#rename')?.addEventListener('click', () => renderNameEditor());
  app.querySelector('#serve')?.addEventListener('click', () => {
    net?.serve();
    haptics.play('serve');
  });
  app.querySelector('#ready')?.addEventListener('click', readyUp);
  app.querySelector('#exit')?.addEventListener('click', () => {
    // Confirmed, because it ends the match for the other player too and a phone
    // is a pocketful of accidental taps.
    if (!confirm('Leave this match? It ends for both players.')) return;
    net?.abort();
    localReady = false;
    haptics.play('serve');
    renderPlay();
  });
  app.querySelector('#rematch')?.addEventListener('click', () => {
    net?.rematch();
    localReady = false;
    haptics.play('serve');
    renderPlay();
  });
  app.querySelector('#mute')?.addEventListener('click', () => {
    muted = !muted;
    haptics.enabled = !muted;
    net?.mute();
    renderPlay();
  });

  if (paused) renderPausedOverlay();
}

/**
 * Ready up: you tell it where the court is, holding the phone at it.
 *
 * Two jobs on one tap, and they are bolted together on purpose. The handshake —
 * nobody serves until both bats are up — is a beat players already expect from
 * every racket sport. The re-centring is a thing they should never have to think
 * about. Putting the second inside the first means the yaw drift is overwritten
 * at the start of every single point by somebody doing something they were going
 * to do anyway.
 */
function readyUp(): void {
  if (localReady) return;
  if (sensors) {
    calibration = sensors.fusion.rezeroYaw();
    net?.calibrated(sensors.fusion.yawOffset);
  }
  localReady = true;
  net?.readyPoint();
  haptics.play('serve');
  renderPlay();
}

/**
 * Two lamps, mine on the left.
 *
 * A circle is allowed here because a status light is literally round; nothing
 * else on this screen is. Unlit is the apron-deep of a seat nobody has taken,
 * which is the same empty state the display draws for an unclaimed half.
 */
function lampsHtml(mine: boolean, theirs: boolean, theySeated: boolean): string {
  return `
    <div class="lamps">
      <div class="lamp ${mine ? 'on' : ''}"><i></i>You</div>
      <div class="lamp ${theirs ? 'on' : ''}">
        <i></i>${theySeated || theirs ? 'Them' : 'No phone'}
      </div>
    </div>`;
}

/**
 * The one action on this screen.
 *
 * Exactly one optic field per screen is the rule, and optic is reserved for the
 * live signal — which includes the action that starts play. READY, SERVE and
 * REMATCH are all that action at different moments, so they are the same button
 * in the same place, never two at once. A seat that has readied and is waiting on
 * the other one drops to court green: it is no longer the pending action, and
 * leaving it optic would spend the signal colour on a thing that is done.
 */
function primaryHtml(
  phase: string,
  yourServe: boolean,
  readyBeat: boolean,
  iAmReady: boolean,
  theyReady: boolean,
  bothReady: boolean,
  theySeated: boolean,
): string {
  if (phase === 'gameover') {
    return `<button class="act" id="rematch">REMATCH</button>`;
  }
  if (readyBeat && !iAmReady) {
    return `<button class="act" id="ready">READY<small>Hold the phone up at the screen</small></button>`;
  }
  if (readyBeat && !theyReady) {
    return `<button class="act set" id="waiting" disabled>
      READY<small>${theySeated ? 'Waiting for them' : 'Waiting for a phone on the other seat'}</small>
    </button>`;
  }
  if (yourServe && phase === 'serve' && bothReady) {
    return `<button class="act" id="serve">SERVE</button>`;
  }
  return '';
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

/**
 * Change your name, on the phone.
 *
 * Appended to the BODY rather than to `app`, and that is the whole reason this
 * is an overlay instead of an input in the header. The play screen re-renders by
 * replacing `app.innerHTML` wholesale on every cue, score and snapshot — a text
 * field living inside it would be destroyed and rebuilt under the player's
 * thumb, losing focus and caret mid-word, several times a second.
 *
 * Renaming re-sends READY, which is the message that already carries a name.
 * The seat is ready by the time this button is reachable, so saying so again
 * changes nothing else.
 */
function renderNameEditor(): void {
  if (document.getElementById('name-overlay')) return;
  const overlay = el('div', 'overlay');
  overlay.id = 'name-overlay';
  overlay.innerHTML = `
    <div>
      <h2>Your name</h2>
      <p>The commentator says this out loud.</p>
      <input id="name-input" maxlength="${NAME_MAX}" autocomplete="off"
             spellcheck="false" enterkeyhint="done" aria-label="Your name" />
      <button id="name-save">Save</button>
    </div>`;
  document.body.append(overlay);

  const input = overlay.querySelector('#name-input') as HTMLInputElement;
  input.value = playerName;
  // Clean as they type, so the cap and the allowed characters are visible facts
  // about the box rather than a rewrite that happens after Save. Written back
  // only when it actually changed: assigning `value` puts the caret at the end,
  // and a typist who never types anything odd should never feel that.
  input.addEventListener('input', () => {
    const clean = filterName(input.value);
    if (clean !== input.value) input.value = clean;
  });
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') commit();
  });
  overlay.querySelector('#name-save')?.addEventListener('click', () => commit());
  // Tapping the backdrop is how every other sheet on a phone is dismissed.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  input.focus();
  input.select();

  function commit(): void {
    // A field emptied and left empty is not a request to be called "".
    if (input.value.trim()) {
      playerName = saveName(input.value);
      net?.ready(playerName);
    }
    overlay.remove();
    renderPlay();
  }
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

function noop(): void {
  /* placeholder until the socket exists */
}
