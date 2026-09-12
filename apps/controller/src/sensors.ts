/**
 * iOS sensor plumbing.
 *
 * The permission calls and the wake lock must all originate from ONE real user
 * gesture, in a secure context. That is why there is a single "Tap to play"
 * button and why this function does three things at once — splitting them across
 * two taps fails on iOS, silently.
 */

import {
  Fusion,
  PP_SWING,
  SwingDetector,
  newPpSwing,
  stepPpSwing,
  stepReach,
  stepSway,
  type MotionSample,
  type OrientationSample,
  type PpSwingState,
} from '@rally/motion';
import { vlen, vnorm, type Quat, type SwingInput, type Vec3 } from '@rally/protocol';

export interface SensorGrant {
  motion: boolean;
  orientation: boolean;
  wakeLock: boolean;
  /** Present when the device exposes no motion sensors at all. */
  reason?: string;
}

type PermissionResult = 'granted' | 'denied' | 'default';
interface RequestableEvent {
  requestPermission?: () => Promise<PermissionResult>;
}

/**
 * Ask for everything, from inside the gesture. Never awaits before the first
 * request: an `await` before `requestPermission()` loses the user-gesture context
 * on iOS and the prompt never appears.
 */
export async function requestSensors(): Promise<SensorGrant> {
  const motionEvent = window.DeviceMotionEvent as unknown as RequestableEvent | undefined;
  const orientEvent = window.DeviceOrientationEvent as unknown as RequestableEvent | undefined;

  if (!motionEvent && !orientEvent) {
    return {
      motion: false,
      orientation: false,
      wakeLock: false,
      reason: 'This device does not report motion. Use the Play here button on the display.',
    };
  }

  const motionPromise = motionEvent?.requestPermission
    ? motionEvent.requestPermission().catch(() => 'denied' as const)
    : Promise.resolve('granted' as const);
  const orientPromise = orientEvent?.requestPermission
    ? orientEvent.requestPermission().catch(() => 'denied' as const)
    : Promise.resolve('granted' as const);
  const lockPromise = requestWakeLock();

  const [motion, orientation, wakeLock] = await Promise.all([
    motionPromise,
    orientPromise,
    lockPromise,
  ]);

  const grant: SensorGrant = {
    motion: motion === 'granted',
    orientation: orientation === 'granted',
    wakeLock,
  };
  if (!grant.motion || !grant.orientation) {
    // `isSecureContext`, not the protocol: localhost over http is secure and will
    // happily grant, so blaming HTTPS there sends people chasing a tunnel they do
    // not need.
    grant.reason = !window.isSecureContext
      ? 'iOS grants motion access only over HTTPS. Open the display through an HTTPS tunnel and rescan the code.'
      : 'Motion access was declined. Reload and allow it, or check Settings > Safari > Motion & Orientation Access. ' +
        'No sensors on this device? Use "Play here (mouse)" on the display instead.';
  }
  return grant;
}

let wakeLockRef: { release: () => Promise<void> } | null = null;

async function requestWakeLock(): Promise<boolean> {
  const nav = navigator as Navigator & {
    wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
  };
  if (!nav.wakeLock) return false;
  try {
    wakeLockRef = await nav.wakeLock.request('screen');
    return true;
  } catch {
    return false;
  }
}

/** Re-acquire the lock after the page comes back from the background. */
export async function reacquireWakeLock(): Promise<void> {
  if (document.visibilityState !== 'visible') return;
  await requestWakeLock();
}

export function releaseWakeLock(): void {
  void wakeLockRef?.release().catch(() => undefined);
  wakeLockRef = null;
}

export interface SensorStream {
  fusion: Fusion;
  swings: SwingDetector;
  stop(): void;
  /** Samples seen so far — used to detect a stalled sensor. */
  sampleCount(): number;
  /**
   * Sensor rate over the last second, Hz. Counted, never assumed.
   *
   * A phone that has quietly dropped to 30 Hz — thermal throttling, low power
   * mode, a backgrounded tab coming back — feels exactly like network lag and
   * looks like nothing at all. This is the one number that tells the two apart,
   * and it costs a counter.
   */
  sampleHz(): number;
  /**
   * Switch swing detection to the sport being played.
   *
   * Table tennis onsets a swing on ROTATION and reports the wrist rate and the
   * hand's velocity; everything else onsets on acceleration and reports a peak
   * speed and a direction. That is a different detector, not a different
   * threshold — see `PP_SWING`.
   */
  setSport(id: string): void;
}

export interface SensorHandlers {
  /**
   * Fires on every motion sample with the current paddle pose.
   *
   * `omegaDeg` is the paddle's rotation rate in its own axes, deg/s. Every sport
   * gets it, because it is what rotates the pose forward to cover the trip to the
   * server — see `@rally/motion/predict`. Table tennis also uses it for spin.
   *
   * `reach`, `sway` and `hold` are table tennis only, and zero/false everywhere
   * else: how far forward the hand is leaning, how far sideways it has travelled
   * since this stroke armed, and whether a stroke is in progress.
   */
  onPose(q: Quat, t: number, omegaDeg: Vec3, reach: number, sway: number, hold: boolean): void;
  /** Fires when a swing completes. Must not block: this is the sensor callback. */
  onSwing(swing: SwingInput, t: number): void;
}

/**
 * Attach to the device events and run the fusion.
 *
 * Both handlers fire on the sensor callback, so neither may block. The swing
 * handler in particular hands its payload straight to the socket and returns:
 * SWING is the one latency-critical message in the protocol.
 */
export function startSensors(handlers: SensorHandlers): SensorStream {
  const fusion = new Fusion();
  const swings = new SwingDetector();
  const pp = new PingPongSwings();
  let samples = 0;
  let tableTennis = false;
  let hz = 0;
  let hzTicks = 0;
  let hzAt = 0;

  const onOrientation = (ev: DeviceOrientationEvent) => {
    if (ev.alpha === null || ev.beta === null || ev.gamma === null) return;
    const sample: OrientationSample = {
      alpha: ev.alpha,
      beta: ev.beta,
      gamma: ev.gamma,
      screen: screenAngle(),
    };
    fusion.pushOrientation(sample);
  };

  const onMotion = (ev: DeviceMotionEvent) => {
    samples++;
    // performance.now(), NOT event.timeStamp: that field's epoch is inconsistent
    // across browsers and the server does arithmetic on this number.
    const t = performance.now();
    hzTicks++;
    if (t - hzAt > 1000) {
      // First sample sets the window rather than reporting a rate measured from
      // an epoch of zero, which would read as thousands of Hz for one second.
      if (hzAt > 0) hz = Math.round((hzTicks * 1000) / (t - hzAt));
      hzTicks = 0;
      hzAt = t;
    }
    const sample: MotionSample = {
      rotationRate: ev.rotationRate
        ? {
            alpha: ev.rotationRate.alpha ?? 0,
            beta: ev.rotationRate.beta ?? 0,
            gamma: ev.rotationRate.gamma ?? 0,
          }
        : null,
      accelerationIncludingGravity: ev.accelerationIncludingGravity
        ? {
            x: ev.accelerationIncludingGravity.x ?? 0,
            y: ev.accelerationIncludingGravity.y ?? 0,
            z: ev.accelerationIncludingGravity.z ?? 0,
          }
        : null,
    };
    fusion.pushMotion(sample, t);
    if (tableTennis) {
      const swing = pp.feed(t, fusion);
      handlers.onPose(fusion.paddleQ, t, fusion.omegaDeg, pp.reach, pp.sway, pp.armed);
      if (swing) handlers.onSwing(swing, t);
      return;
    }
    handlers.onPose(fusion.paddleQ, t, fusion.omegaDeg, 0, 0, false);
    const swing = swings.feed(t, fusion.linearAccel, fusion.paddleQ);
    if (swing) handlers.onSwing(swing, t);
  };

  window.addEventListener('deviceorientation', onOrientation);
  window.addEventListener('devicemotion', onMotion);

  return {
    fusion,
    swings,
    sampleCount: () => samples,
    sampleHz: () => hz,
    setSport(id: string) {
      const next = id === 'tabletennis';
      if (next === tableTennis) return;
      tableTennis = next;
      pp.reset();
      swings.reset();
    },
    stop() {
      window.removeEventListener('deviceorientation', onOrientation);
      window.removeEventListener('devicemotion', onMotion);
    },
  };
}

/**
 * The table tennis swing path.
 *
 * Different from `SwingDetector` in what it watches and what it reports: it
 * onsets on rotation rather than acceleration (see `PP_SWING` for why), and it
 * reports the wrist's rotation rate and the hand's velocity in the player's own
 * frame — the two things that engine's contact model is built from.
 *
 * It also keeps the forward lean, because that is integrated from the same
 * samples and has nowhere else to live.
 */
class PingPongSwings {
  private state: PpSwingState<PpCapture> = newPpSwing<PpCapture>();
  private lean = { reach: 0, vel: 0 };
  private vel: Vec3 = [0, 0, 0];
  private swayM = 0;
  private lastT: number | null = null;

  /** Metres of forward lean. Sent with the pose. */
  get reach(): number {
    return this.lean.reach;
  }

  /**
   * Metres the hand has travelled sideways since this stroke armed, positive to
   * the player's right. Zero outside a stroke.
   *
   * This is the one thing the server's position freeze must let through:
   * changing wings IS the hand crossing the body, and the freeze is only right
   * about rotation. See `REACH_X`.
   */
  get sway(): number {
    return this.swayM;
  }

  /** True mid-stroke, so the server freezes the bat's position. */
  get armed(): boolean {
    return this.state.phase === 'armed';
  }

  reset(): void {
    this.state = newPpSwing<PpCapture>();
    this.lean = { reach: 0, vel: 0 };
    this.vel = [0, 0, 0];
    this.swayM = 0;
    this.lastT = null;
  }

  feed(t: number, fusion: Fusion): SwingInput | null {
    const dt = this.lastT === null ? 0 : Math.min(0.05, (t - this.lastT) / 1000);
    this.lastT = t;

    const a = fusion.linearAccel;
    const omega = fusion.omegaDeg;
    const dps = vlen(omega);
    const accelMag = vlen(a);

    if (dt > 0) {
      // Integrate for the duration of the swing ONLY. Over seconds this drifts
      // into nonsense; over the ~200 ms of a stroke it is the difference between
      // pushing the ball and brushing it, which is the difference between having
      // spin and not.
      if (this.state.phase === 'armed') {
        this.vel = [
          clampAbs(this.vel[0] + a[0] * dt, MAX_VLIN),
          clampAbs(this.vel[1] + a[1] * dt, MAX_VLIN),
          clampAbs(this.vel[2] + a[2] * dt, MAX_VLIN),
        ];
        // +X is the player's right, so this integral is exactly the cross-body
        // travel the freeze has to let through. Same window as `vel`, discarded
        // with it, so it has no time to drift.
        this.swayM = stepSway(this.swayM, this.vel[0], dt);
      } else {
        this.vel = [0, 0, 0];
        this.swayM = 0;
      }
      // +Z is the direction the player faces, so forward acceleration is +a[2].
      this.lean = stepReach(this.lean, a[2], accelMag, dps, dt);
    }

    const [next, fired] = stepPpSwing<PpCapture>(
      this.state,
      {
        t,
        dps,
        handSpeed: vlen(this.vel),
        // Captured at PEAK rate, which is contact. By the end of the
        // follow-through the phone points somewhere meaningless.
        sample: { q: fusion.paddleQ, omega, vel: [...this.vel] as Vec3, t },
      },
      PP_SWING,
    );
    this.state = next;
    if (!fired) return null;

    const speed = vlen(fired.vel);
    const dir = speed > 0.01 ? vnorm(fired.vel) : [0, 0, 1] as Vec3;
    return {
      speed,
      dir,
      q: fired.q,
      elev: Math.atan2(dir[1], Math.hypot(dir[0], dir[2])),
      ctPeak: fired.t,
      // Both in this project's own player frame, like `dir`. The table tennis
      // engine's frame differs by one axis and it converts at its own boundary —
      // see `toPpPose` — so the phone never has to know which sport it is
      // feeding.
      omega: fired.omega,
      vsw: [...fired.vel] as Vec3,
    };
  }
}

interface PpCapture {
  q: Quat;
  omega: Vec3;
  vel: Vec3;
  t: number;
}

/** m/s. A real swing is well under this; more is drift. */
const MAX_VLIN = 8;

const clampAbs = (v: number, m: number): number => (v > m ? m : v < -m ? -m : v);

function screenAngle(): number {
  const orientation = screen.orientation as ScreenOrientation | undefined;
  if (orientation && typeof orientation.angle === 'number') return orientation.angle;
  return (window as unknown as { orientation?: number }).orientation ?? 0;
}

/**
 * Verify the accelerometer's sign convention, which differs across iOS versions.
 *
 * At rest the raw magnitude should be about 9.8 and the gravity-removed linear
 * acceleration should be near zero. If it reads roughly 2g instead, the sign is
 * inverted and every swing direction would come out backwards.
 */
export function detectAccelSign(fusion: Fusion): number {
  const a = fusion.linearAccel;
  const mag = Math.hypot(a[0], a[1], a[2]);
  return mag > 14 ? -1 : 1;
}
