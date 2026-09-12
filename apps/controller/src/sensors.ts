/**
 * iOS sensor plumbing.
 *
 * The permission calls and the wake lock must all originate from ONE real user
 * gesture, in a secure context. That is why there is a single "Tap to play"
 * button and why this function does three things at once — splitting them across
 * two taps fails on iOS, silently.
 */

import { Fusion, SwingDetector, type MotionSample, type OrientationSample } from '@rally/motion';
import type { Quat, SwingInput } from '@rally/protocol';

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
}

export interface SensorHandlers {
  /** Fires on every motion sample with the current paddle pose. */
  onPose(q: Quat, t: number): void;
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
  let samples = 0;

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
    handlers.onPose(fusion.paddleQ, t);
    const swing = swings.feed(t, fusion.linearAccel, fusion.paddleQ);
    if (swing) handlers.onSwing(swing, t);
  };

  window.addEventListener('deviceorientation', onOrientation);
  window.addEventListener('devicemotion', onMotion);

  return {
    fusion,
    swings,
    sampleCount: () => samples,
    stop() {
      window.removeEventListener('deviceorientation', onOrientation);
      window.removeEventListener('devicemotion', onMotion);
    },
  };
}

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
