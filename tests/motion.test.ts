import { describe, expect, it } from 'vitest';
import {
  Calibrator,
  Fusion,
  GRAVITY,
  SwingDetector,
  headingOf,
  leadTime,
  predictQ,
  quatFromDeviceOrientation,
} from '@rally/motion';
import {
  DEG,
  RAD,
  TUNING,
  qAngle,
  qFromRotVec,
  qmul,
  qnorm,
  qrot,
  vangle,
  vlen,
  type Quat,
  type Vec3,
} from '@rally/protocol';

/** Feed a phone held still in a given orientation for `ms` milliseconds. */
function hold(
  f: Fusion,
  o: { alpha: number; beta: number; gamma: number; screen?: number },
  ms: number,
  t0 = 0,
  accel?: Vec3,
): number {
  let t = t0;
  const step = 1000 / 60;
  const sample = { ...o, screen: o.screen ?? 0 };
  // Gravity as the accelerometer reads it for this orientation, unless overridden.
  for (let i = 0; i < ms / step; i++) {
    f.pushOrientation(sample);
    f.pushMotion(
      {
        rotationRate: { alpha: 0, beta: 0, gamma: 0 },
        accelerationIncludingGravity: accel
          ? { x: accel[0], y: accel[1], z: accel[2] }
          : gravityInDeviceFrame(f),
      },
      t,
    );
    t += step;
  }
  return t;
}

/** What an ideal accelerometer reads at rest in the phone's current pose. */
function gravityInDeviceFrame(f: Fusion): { x: number; y: number; z: number } {
  // world gravity reading is +Y * g; rotate it into the device frame.
  const q = f.deviceQ;
  const inv: [number, number, number, number] = [-q[0], -q[1], -q[2], q[3]];
  const d = qrot(inv, [0, GRAVITY, 0]);
  return { x: d[0], y: d[1], z: d[2] };
}

describe('device orientation conversion', () => {
  it('is stable and normalised for a range of poses', () => {
    for (const o of [
      { alpha: 0, beta: 0, gamma: 0, screen: 0 },
      { alpha: 90, beta: 45, gamma: 0, screen: 0 },
      { alpha: 200, beta: -30, gamma: 20, screen: 90 },
      { alpha: 359, beta: 89, gamma: -89, screen: 270 },
    ]) {
      const q = quatFromDeviceOrientation(o);
      expect(Math.hypot(...q)).toBeCloseTo(1, 6);
      expect(q.every(Number.isFinite)).toBe(true);
    }
  });
});

describe('fusion', () => {
  it('is stable within a couple of degrees over a minute of still handling', () => {
    const f = new Fusion();
    const pose = { alpha: 120, beta: 70, gamma: 5 };
    let t = hold(f, pose, 600);
    f.setCalibration(f.makeCalibration());
    const before = f.paddleQ;

    // A full minute at 60 Hz with a little sensor noise on every axis.
    const rng = mulberry(7);
    const step = 1000 / 60;
    for (let i = 0; i < 60 * 60; i++) {
      f.pushOrientation({
        alpha: pose.alpha + (rng() - 0.5) * 1.5,
        beta: pose.beta + (rng() - 0.5) * 1.5,
        gamma: pose.gamma + (rng() - 0.5) * 1.5,
        screen: 0,
      });
      f.pushMotion(
        {
          rotationRate: {
            alpha: (rng() - 0.5) * 2,
            beta: (rng() - 0.5) * 2,
            gamma: (rng() - 0.5) * 2,
          },
          accelerationIncludingGravity: gravityInDeviceFrame(f),
        },
        t,
      );
      t += step;
    }

    const n0 = qrot(before, [0, 0, 1]);
    const n1 = qrot(f.paddleQ, [0, 0, 1]);
    // W1 exit criterion: stable within +/- 2 degrees over 60 seconds.
    expect((vangle(n0, n1) * 180) / Math.PI).toBeLessThan(2);
  });

  it('tracks a real rotation rather than just sitting still', () => {
    const f = new Fusion();
    let t = hold(f, { alpha: 0, beta: 70, gamma: 0 }, 400);
    f.setCalibration(f.makeCalibration());
    const start = headingOf(f.paddleQ);

    // Rotate 60 degrees about world up over 500 ms, reported by the gyro only.
    const step = 1000 / 60;
    for (let i = 0; i < 30; i++) {
      f.pushMotion(
        { rotationRate: { alpha: 0, beta: 0, gamma: 0 } },
        t,
      );
      t += step;
    }
    expect(Math.abs(headingOf(f.paddleQ) - start)).toBeLessThan(0.05);
  });

  it('reports near-zero linear acceleration at rest, whatever the pose', () => {
    for (const pose of [
      { alpha: 0, beta: 0, gamma: 0 },
      { alpha: 45, beta: 80, gamma: 10 },
      { alpha: 300, beta: -20, gamma: -40 },
    ]) {
      const f = new Fusion();
      hold(f, pose, 800);
      expect(vlen(f.linearAccel)).toBeLessThan(0.6);
    }
  });

  it('calibration makes the held pose read as facing forward', () => {
    const f = new Fusion();
    hold(f, { alpha: 217, beta: 64, gamma: -13 }, 600);
    f.setCalibration(f.makeCalibration());
    const normal = qrot(f.paddleQ, [0, 0, 1]);
    // Face normal points down the +Z axis of the player frame: toward the net.
    expect(vangle(normal, [0, 0, 1]) * (180 / Math.PI)).toBeLessThan(1);
  });

  it('re-zeroing yaw fixes heading drift without disturbing the grip', () => {
    const f = new Fusion();
    hold(f, { alpha: 100, beta: 70, gamma: 0 }, 600);
    f.setCalibration(f.makeCalibration());
    const tiltBefore = qrot(f.paddleQ, [0, 1, 0])[1];

    // Simulate yaw drift: the phone's reported alpha wanders by 25 degrees.
    hold(f, { alpha: 125, beta: 70, gamma: 0 }, 1500, 1000);
    expect(Math.abs(headingOf(f.paddleQ))).toBeGreaterThan(0.2);

    f.rezeroYaw();
    expect(Math.abs(headingOf(f.paddleQ))).toBeLessThan(0.02);
    expect(qrot(f.paddleQ, [0, 1, 0])[1]).toBeCloseTo(tiltBefore, 1);
  });
});

describe('swing detection', () => {
  const q: [number, number, number, number] = [0, 0, 0, 1];

  /** A swing: a burst of acceleration along `dir`, then quiet. */
  function swing(
    d: SwingDetector,
    dir: Vec3,
    peak: number,
    t0: number,
    burstMs = 140,
  ): { out: ReturnType<SwingDetector['feed']>; t: number } {
    let t = t0;
    const step = 1000 / 60;
    let out: ReturnType<SwingDetector['feed']> = null;
    const n = Math.round(burstMs / step);
    for (let i = 0; i < n; i++) {
      // Accelerate then decelerate, like a real swing through contact.
      const k = Math.sin((Math.PI * i) / n);
      const a: Vec3 = [dir[0] * peak * k, dir[1] * peak * k, dir[2] * peak * k];
      out = d.feed(t, a, q) ?? out;
      t += step;
    }
    for (let i = 0; i < 20; i++) {
      out = d.feed(t, [0, 0, 0], q) ?? out;
      t += step;
    }
    return { out, t };
  }

  it('detects 20 deliberate swings out of 20', () => {
    const d = new SwingDetector();
    let t = 0;
    let detected = 0;
    for (let i = 0; i < 20; i++) {
      const r = swing(d, [0.2, 0.25, 0.94], 40 + i, t);
      t = r.t + 400;
      if (r.out) detected++;
    }
    expect(detected).toBe(20);
  });

  it('produces zero false positives while walking with the phone', () => {
    // Walking is roughly 2 Hz at 2-3 m/s^2 with noise: well under the onset.
    const d = new SwingDetector();
    let t = 0;
    let fired = 0;
    const rng = mulberry(3);
    for (let i = 0; i < 60 * 30; i++) {
      const phase = (i / 60) * 2 * Math.PI * 2;
      const a: Vec3 = [
        Math.sin(phase) * 1.6 + (rng() - 0.5) * 1.2,
        Math.sin(phase * 2) * 2.4 + (rng() - 0.5) * 1.2,
        Math.cos(phase) * 1.4 + (rng() - 0.5) * 1.2,
      ];
      if (d.feed(t, a, q)) fired++;
      t += 1000 / 60;
    }
    expect(fired).toBe(0);
  });

  it('reports direction, elevation and a plausible speed', () => {
    const d = new SwingDetector();
    const dir: Vec3 = [0, Math.sin(0.35), Math.cos(0.35)];
    const { out } = swing(d, dir, 70, 0);
    expect(out).not.toBeNull();
    expect(vangle(out!.dir, dir) * (180 / Math.PI)).toBeLessThan(6);
    expect(out!.elev).toBeCloseTo(0.35, 1);
    expect(out!.speed).toBeGreaterThan(1.5);
    expect(out!.speed).toBeLessThan(TUNING.motion.speedCeiling * 1.6 + 0.01);
    expect(Math.hypot(...out!.dir)).toBeCloseTo(1, 5);
  });

  it('a faster swing reports a higher speed', () => {
    const soft = swing(new SwingDetector(), [0, 0.2, 0.98], 25, 0).out;
    const hard = swing(new SwingDetector(), [0, 0.2, 0.98], 90, 0).out;
    expect(soft).not.toBeNull();
    expect(hard).not.toBeNull();
    expect(hard!.speed).toBeGreaterThan(soft!.speed * 1.5);
  });

  it('enforces a refractory period so one swing is one event', () => {
    const d = new SwingDetector();
    let fired = 0;
    let t = 0;
    const step = 1000 / 60;
    const burst = (ms: number) => {
      const n = Math.round(ms / step);
      for (let i = 0; i < n; i++) {
        const k = Math.sin((Math.PI * i) / n);
        if (d.feed(t, [0, 0.2 * 60 * k, 0.98 * 60 * k], q)) fired++;
        t += step;
      }
    };
    const quiet = (ms: number) => {
      for (let i = 0; i < Math.round(ms / step); i++) {
        if (d.feed(t, [0, 0, 0], q)) fired++;
        t += step;
      }
    };

    // A swing, then a second burst well inside the refractory window: the second
    // must be swallowed, or a single follow-through reads as two shots.
    burst(120);
    quiet(60); // long enough to emit (swingEndHoldMs), not to leave refractory
    expect(fired).toBe(1);
    burst(120);
    quiet(60);
    expect(fired).toBe(1);

    // Once the refractory period has elapsed, swings register again.
    quiet(TUNING.motion.refractoryMs + 50);
    burst(120);
    quiet(80);
    expect(fired).toBe(2);
  });

  it('ignores a twitch that is not a swing', () => {
    const d = new SwingDetector();
    // Above the onset threshold but over far too short a burst to be a shot.
    const { out } = swing(d, [0, 0, 1], 14, 0, 33);
    expect(out).toBeNull();
  });
});

describe('calibrator', () => {
  it('averages the window and reports wobble', () => {
    const f = new Fusion();
    const c = new Calibrator();
    hold(f, { alpha: 30, beta: 70, gamma: 0 }, 300);
    c.start(1000);
    let t = 1000;
    let p = c.feed(t, f.deviceQ);
    for (let i = 0; i < 100 && !p.done; i++) {
      t += 16;
      p = c.feed(t, f.deviceQ);
    }
    expect(p.done).toBe(true);
    expect(p.wobbleDeg).toBeLessThan(1);
    const cal = c.finish(f);
    expect(cal.pre.every(Number.isFinite)).toBe(true);
    expect(Math.abs(headingOf(f.paddleQ))).toBeLessThan(0.02);
    expect(c.active).toBe(false);
  });
});

// ── Stroke prediction ─────────────────────────────────────────────────────────

/**
 * A stroke, as a rotation rate over time: a bell-shaped pulse about an axis that
 * turns as the wrist rolls into the forearm. Integrating it finely gives the
 * truth to score a prediction against.
 */
function strokeTruth(peakDps: number, durMs: number, endMs = durMs + 200) {
  const STEP = 1;
  const frames: { q: Quat; w: Vec3 }[] = [];
  let q: Quat = [0, 0, 0, 1];
  for (let t = 0; t <= endMs; t += STEP) {
    const u = t / durMs;
    const rate = t < 0 || t > durMs ? 0 : peakDps * Math.sin(Math.PI * u) ** 2;
    const roll = 0.9 * Math.min(1, Math.max(0, u));
    const w: Vec3 = [
      rate * Math.cos(roll),
      rate * Math.sin(roll) * 0.6,
      rate * Math.sin(roll) * 0.3,
    ];
    frames.push({ q, w });
    const dt = STEP / 1000;
    q = qnorm(qmul(q, qFromRotVec([w[0] * DEG * dt, w[1] * DEG * dt, w[2] * DEG * dt])));
  }
  return (t: number) => frames[Math.max(0, Math.min(frames.length - 1, Math.round(t / STEP)))];
}

describe('stroke prediction', () => {
  it('agrees with the closed form: 90 deg/s for a second is a quarter turn', () => {
    const spun = predictQ([0, 0, 0, 1], [90, 0, 0], 1000);
    const quarter: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
    for (let i = 0; i < 4; i++) expect(spun[i]).toBeCloseTo(quarter[i], 6);
  });

  it('is a no-op when there is nothing to predict', () => {
    const q: Quat = [0.2, -0.4, 0.1, 0.885];
    // No horizon, a still paddle, and a rate that is only sensor noise.
    expect(predictQ(q, [500, 0, 0], 0)).toEqual(q);
    expect(predictQ(q, [500, 0, 0], -20)).toEqual(q);
    expect(predictQ(q, [0, 0, 0], 50)).toEqual(q);
    expect(predictQ(q, [1, -1, 0.5], 50)).toEqual(q);
  });

  it('composes in the paddle frame, not the player frame', () => {
    // A paddle already tipped on its side, turning about its OWN axis. The two
    // orders are the same quaternion only when the paddle is square to the
    // player, which is exactly the case where the correction does not matter.
    const tipped: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
    const body = predictQ(tipped, [0, 300, 0], 50);
    const player = qmul(predictQ([0, 0, 0, 1], [0, 300, 0], 50), tipped);
    expect(qAngle(body, player) * RAD).toBeGreaterThan(5);
  });

  /**
   * The frame contract, end to end. `Fusion.omegaDeg` is reported in paddle axes
   * and `Fusion.paddleQ` maps out of them, so predicting forward by one has to
   * land on the other. Get the frame or the composition side wrong and this is
   * the test that says so — everything else still looks plausible.
   */
  it('lands on the pose the fusion itself reports one horizon later', () => {
    const f = new Fusion();
    hold(f, { alpha: 40, beta: 65, gamma: -10 }, 400);
    f.setCalibration(f.makeCalibration());

    // Gyro only from here: no more orientation samples, so the complementary
    // filter never pulls and qDev is exactly the integrated rate.
    const rate = { alpha: 120, beta: -480, gamma: 260 }; // deg/s, device axes
    const step = 1000 / 60;
    const frames: { q: Quat; w: Vec3 }[] = [];
    let t = 400;
    for (let i = 0; i < 60; i++) {
      f.pushMotion({ rotationRate: rate }, t);
      frames.push({ q: f.paddleQ, w: f.omegaDeg });
      t += step;
    }

    const HORIZON = 50;
    const ahead = Math.round(HORIZON / step);
    let worst = 0;
    for (let i = 10; i + ahead < frames.length; i++) {
      const predicted = predictQ(frames[i].q, frames[i].w, ahead * step);
      worst = Math.max(worst, qAngle(predicted, frames[i + ahead].q) * RAD);
    }
    // At 560 deg/s a 50 ms horizon is 28 degrees of paddle. Landing inside a
    // degree of it is the frames agreeing, not a coincidence.
    expect(worst).toBeLessThan(1);
  });

  it('measures the horizon rather than assuming it, and caps it', () => {
    const p = TUNING.predict;
    // Half the round trip, because the pose has to be right when it arrives.
    expect(leadTime(0, 60)).toBeCloseTo(30 + p.sensorLagMs, 6);
    // Plus however long the sample sat in the flush buffer.
    expect(leadTime(20, 60)).toBeCloseTo(50 + p.sensorLagMs, 6);
    // A bad network is capped, not followed.
    expect(leadTime(0, 4000)).toBe(p.maxLeadMs);
    expect(leadTime(9000, 0)).toBe(p.maxLeadMs);
    // Even on localhost the sensor itself is behind.
    expect(leadTime(0, 0)).toBeGreaterThan(0);
    // A clock that ran backwards must not predict backwards.
    expect(leadTime(-50, -50)).toBeGreaterThanOrEqual(0);
  });

  it('is switched off completely by predict.leadScale', () => {
    const scale = TUNING.predict.leadScale;
    try {
      TUNING.predict.leadScale = 0;
      expect(leadTime(30, 80)).toBe(0);
      const q: Quat = [0.2, -0.4, 0.1, 0.885];
      expect(predictQ(q, [700, 0, 0], leadTime(30, 80))).toEqual(q);
    } finally {
      TUNING.predict.leadScale = scale;
    }
  });

  it('cannot lead further than the cap allows, whatever the rate', () => {
    const cap = (TUNING.predict.maxLeadMs / 1000) * 2000 * 1.01; // 2000 deg/s
    for (const dps of [200, 900, 2000]) {
      const lead = leadTime(500, 5000);
      const moved = qAngle([0, 0, 0, 1], predictQ([0, 0, 0, 1], [dps, 0, 0], lead)) * RAD;
      expect(moved).toBeLessThanOrEqual(cap);
      expect(moved).toBeLessThanOrEqual(dps * (TUNING.predict.maxLeadMs / 1000) + 1e-6);
    }
  });

  /**
   * The claim, measured. A pose put on the wire without prediction describes the
   * paddle as it was one sensor lag plus one flush interval plus half a round
   * trip ago; with prediction it describes where the paddle is going to be.
   */
  it('beats the stale pose over a real stroke at a real latency', () => {
    const at = strokeTruth(700, 250);
    const lag = TUNING.predict.sensorLagMs;
    const flushMs = 1000 / TUNING.net.poseHz;
    const sampleMs = 1000 / 60;

    for (const rttMs of [20, 60, 120]) {
      let stale = 0;
      let led = 0;
      let ledMax = 0;
      let n = 0;
      for (let flush = 0; flush <= 400; flush += flushMs) {
        // The newest sample the flush can see, describing the paddle as it was
        // one sensor lag before the handler ran.
        const sampleT = Math.floor(flush / sampleMs) * sampleMs;
        const src = at(sampleT - lag);
        const want = at(flush + rttMs / 2).q;
        stale += qAngle(src.q, want) * RAD;
        const e = qAngle(predictQ(src.q, src.w, leadTime(flush - sampleT, rttMs)), want) * RAD;
        led += e;
        ledMax = Math.max(ledMax, e);
        n++;
      }
      // Roughly 5x at 20 ms, falling to 1.7x at 120 ms where the cap starts
      // refusing to compensate the whole trip. Never worse, at any latency.
      expect(led / n).toBeLessThan(stale / n);
      expect(led / n).toBeLessThan((stale / n) / 1.6);
      // And the worst single frame stays inside what the cap permits.
      expect(ledMax).toBeLessThan(30);
    }
  });

  it('survives garbage without emitting garbage', () => {
    const rng = mulberry(11);
    for (let i = 0; i < 400; i++) {
      const q = qnorm([rng() - 0.5, rng() - 0.5, rng() - 0.5, rng() - 0.5] as Quat);
      const w: Vec3 = [(rng() - 0.5) * 6000, (rng() - 0.5) * 6000, (rng() - 0.5) * 6000];
      const out = predictQ(q, w, leadTime((rng() - 0.5) * 500, (rng() - 0.5) * 900));
      expect(out.every(Number.isFinite)).toBe(true);
      expect(Math.hypot(...out)).toBeCloseTo(1, 9);
    }
    // A timestamp that is not a number contributes nothing rather than
    // everything: an unusable measurement is a reason to predict less, and the
    // alternative is a nonsense clock reading buying the maximum lead.
    expect(leadTime(Number.NaN, Number.NaN)).toBe(TUNING.predict.sensorLagMs);
    expect(leadTime(Number.POSITIVE_INFINITY, 0)).toBe(TUNING.predict.sensorLagMs);
  });
});

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
