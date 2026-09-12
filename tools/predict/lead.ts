/**
 * What the pose predictor is worth, in degrees.
 *
 * `predictQ` claims to put the paddle where the hand will be rather than where it
 * was. This measures that claim against a synthetic stroke, so moving
 * `predict.maxLeadMs` is a decision with a number attached rather than a feeling.
 *
 *   npm run bench:predict
 *
 * Read the columns as: how far the pose the server acts on is from the paddle the
 * player is actually holding, in degrees, without prediction and with it.
 *
 * The stroke is synthetic — a bell-shaped rate pulse about an axis that turns as
 * the wrist rolls into the forearm — so treat the ratios as the shape of the
 * result rather than as a measurement of anybody's forehand. What is not
 * synthetic is the pipeline: real sensor rate, real flush interval, real cap.
 */

import { leadTime, predictQ } from '@rally/motion';
import {
  DEG,
  RAD,
  TUNING,
  qAngle,
  qFromRotVec,
  qmul,
  qnorm,
  type Quat,
  type Vec3,
} from '@rally/protocol';

const SENSOR_HZ = 60;
/** Truth resolution, ms. Fine enough that it is not what limits the answer. */
const FINE = 1;

type Rate = (tMs: number) => Vec3;

/** One stroke: a rate pulse about an axis that turns through it. */
const pulse =
  (peakDps: number, durMs: number): Rate =>
  (t) => {
    if (t < 0 || t > durMs) return [0, 0, 0];
    const u = t / durMs;
    const rate = peakDps * Math.sin(Math.PI * u) ** 2;
    const roll = 0.9 * u;
    return [rate * Math.cos(roll), rate * Math.sin(roll) * 0.6, rate * Math.sin(roll) * 0.3];
  };

/**
 * Backswing one way, forward stroke the other. The reversal is where a
 * constant-rate model is provably wrong, so it is measured rather than skipped.
 */
const reversal =
  (turnMs: number): Rate =>
  (t) => {
    const backEnd = 180;
    const fwdStart = backEnd + turnMs;
    if (t < 0) return [0, 0, 0];
    if (t < backEnd) return [-350 * Math.sin((Math.PI * t) / backEnd) ** 2, 0, 0];
    if (t < fwdStart) return [0, 0, 0];
    if (t < fwdStart + 220) {
      return [800 * Math.sin((Math.PI * (t - fwdStart)) / 220) ** 2, 0, 0];
    }
    return [0, 0, 0];
  };

/** Integrate a rate into orientations, and hand back a sampler over time. */
function truth(rate: Rate, endMs: number): (t: number) => { q: Quat; w: Vec3 } {
  const frames: { q: Quat; w: Vec3 }[] = [];
  let q: Quat = [0, 0, 0, 1];
  for (let t = 0; t <= endMs; t += FINE) {
    const w = rate(t);
    frames.push({ q, w });
    const dt = FINE / 1000;
    q = qnorm(qmul(q, qFromRotVec([w[0] * DEG * dt, w[1] * DEG * dt, w[2] * DEG * dt])));
  }
  return (t) => frames[Math.max(0, Math.min(frames.length - 1, Math.round(t / FINE)))];
}

interface Score {
  stale: number;
  led: number;
  staleMax: number;
  ledMax: number;
  /**
   * Worst single frame where predicting landed FURTHER out than not predicting,
   * in degrees. A count of such frames is not the useful statistic — noise on a
   * still paddle trips it constantly and costs a fraction of a degree. How badly
   * prediction can hurt is the number worth knowing.
   */
  harm: number;
}

function score(rate: Rate, endMs: number, rttMs: number, noiseDps: number): Score {
  const at = truth(rate, endMs + 400);
  const lag = TUNING.predict.sensorLagMs;
  const flushMs = 1000 / TUNING.net.poseHz;
  const sampleMs = 1000 / SENSOR_HZ;
  // Deterministic noise: a bench that reads differently every run is not one you
  // can tune against.
  let seed = 7;
  const jitter = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2;

  let stale = 0;
  let led = 0;
  let staleMax = 0;
  let ledMax = 0;
  let harm = 0;
  let n = 0;

  for (let flush = 0; flush <= endMs; flush += flushMs) {
    // The newest sample this flush can see. What it describes is the paddle one
    // sensor lag before the handler ran — that is what the lag IS.
    const sampleT = Math.floor(flush / sampleMs) * sampleMs;
    const src = at(sampleT - lag);
    const w: Vec3 = [
      src.w[0] + jitter() * noiseDps,
      src.w[1] + jitter() * noiseDps,
      src.w[2] + jitter() * noiseDps,
    ];
    // Where the paddle really is when the pose reaches the server.
    const want = at(flush + rttMs / 2).q;

    const eStale = qAngle(src.q, want) * RAD;
    const eLed = qAngle(predictQ(src.q, w, leadTime(flush - sampleT, rttMs)), want) * RAD;
    stale += eStale;
    led += eLed;
    staleMax = Math.max(staleMax, eStale);
    ledMax = Math.max(ledMax, eLed);
    harm = Math.max(harm, eLed - eStale);
    n++;
  }
  return { stale: stale / n, led: led / n, staleMax, ledMax, harm };
}

const pad = (x: number, w: number, places = 1) => x.toFixed(places).padStart(w);

function table(title: string, rate: Rate, endMs: number, noiseDps: number): void {
  console.log(`\n${title}   gyro noise +/-${noiseDps} deg/s`);
  console.log('  rtt  |   stale mean / max  |     led mean / max  | better by | worst harm');
  console.log('  -----+---------------------+---------------------+-----------+-----------');
  for (const rtt of [20, 60, 120, 250]) {
    const s = score(rate, endMs, rtt, noiseDps);
    console.log(
      `  ${String(rtt).padStart(3)}ms |  ${pad(s.stale, 5)} / ${pad(s.staleMax, 5)} deg  |  ` +
        `${pad(s.led, 5)} / ${pad(s.ledMax, 5)} deg  |   ${pad(s.stale / s.led, 4, 2)}x   | ` +
        `${pad(s.harm, 5)} deg`,
    );
  }
}

const p = TUNING.predict;
console.log(
  `pose prediction: lead = sample age + rtt/2 + ${p.sensorLagMs} ms, ` +
    `capped at ${p.maxLeadMs} ms, scale ${p.leadScale}`,
);
console.log(`pose flushed at ${TUNING.net.poseHz} Hz from a ${SENSOR_HZ} Hz sensor`);

table('A 700 deg/s drive, 250 ms', pulse(700, 250), 450, 0);
table('The same, gyro noise turned up well past real hardware', pulse(700, 250), 450, 25);
table('A 1100 deg/s smash, 180 ms', pulse(1100, 180), 400, 25);
table('Backswing reversing into a 800 deg/s forward stroke', reversal(40), 700, 25);

console.log(`
Reading this:

  The gap being closed is sensor lag + flush wait + half a round trip. At 20 ms
  that is about 35 ms and constant-omega covers it almost exactly. By 250 ms the
  ${p.maxLeadMs} ms cap is deliberately refusing to compensate most of the trip, which is
  why the ratio falls off — raising predict.maxLeadMs buys the mean back and
  pays for it in the max column.

  "worst harm" is the honest cost. A constant rate cannot know about a change of
  direction, so at a reversal it leads the wrong way and that one frame ends up
  further out than if nothing had been predicted at all. It is bounded by the cap
  and it is smaller than the error being removed everywhere else, which is the
  trade being made.

  The +/-25 deg/s row is a stress test, not a phone. A real MEMS gyro at rest is
  a couple of degrees a second, which is what predict.minRateDps is set against.
`);
