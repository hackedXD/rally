import { describe, expect, it } from 'vitest';
import {
  ClockSync,
  QUAT_IDENTITY,
  c2sSchema,
  dequantQuat,
  median,
  parseMessage,
  qFromUnitZTo,
  qmul,
  qnorm,
  qrot,
  quantQuat,
  safeParse,
  sanitizeName,
  slerpDir,
  vangle,
  vnorm,
  yawOf,
  type Quat,
} from '@rally/protocol';

describe('quaternion maths', () => {
  it('rotates a vector by identity unchanged', () => {
    expect(qrot(QUAT_IDENTITY, [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('composes rotations the same way as applying them in order', () => {
    const a = qFromUnitZTo([1, 0, 0]);
    const b = qFromUnitZTo([0, 1, 0]);
    const v: [number, number, number] = [0.3, -0.2, 0.9];
    const viaCompose = qrot(qmul(a, b), v);
    const viaSequence = qrot(a, qrot(b, v));
    for (let i = 0; i < 3; i++) expect(viaCompose[i]).toBeCloseTo(viaSequence[i], 10);
  });

  it('qFromUnitZTo maps local +Z onto the requested direction', () => {
    for (const dir of [
      [0, 0, 1],
      [0, 0, -1],
      [1, 0, 0],
      [0, 1, 0],
      [0.3, 0.5, -0.8],
    ] as [number, number, number][]) {
      const want = vnorm(dir);
      const got = qrot(qFromUnitZTo(dir), [0, 0, 1]);
      expect(vangle(got, want)).toBeLessThan(1e-6);
    }
  });

  it('survives an int16 quantisation round trip to under a tenth of a degree', () => {
    const qs: Quat[] = [
      QUAT_IDENTITY,
      qnorm([0.1, -0.7, 0.2, 0.6]),
      qFromUnitZTo([0.4, 0.9, -0.2]),
    ];
    for (const q of qs) {
      const back = dequantQuat(quantQuat(q));
      const v = qrot(q, [0, 0, 1]);
      const v2 = qrot(back, [0, 0, 1]);
      expect(vangle(v, v2)).toBeLessThan(0.002);
    }
  });

  it('extracts yaw consistently', () => {
    expect(yawOf(QUAT_IDENTITY)).toBeCloseTo(0, 6);
  });

  it('slerps directions without NaN through the antipodal case', () => {
    const out = slerpDir([0, 0, 1], [0, 0, -1], 0.5);
    expect(out.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(...out)).toBeCloseTo(1, 6);
  });
});

describe('clock synchronisation', () => {
  it('takes the median offset, not the mean, so one hiccup cannot shift the clock', () => {
    let now = 0;
    const cs = new ClockSync(() => now);
    // Eight clean samples: rtt 20 ms, true offset 1000 ms.
    for (let i = 0; i < 8; i++) {
      const c0 = now;
      now += 20;
      cs.accept(c0, c0 + 10 + 1000);
    }
    expect(cs.offset).toBeCloseTo(1000, 3);
    expect(cs.isSynced).toBe(true);

    // A single 900 ms stall must be rejected as an outlier.
    const c0 = now;
    now += 900;
    cs.accept(c0, c0 + 450 + 1000);
    expect(cs.offset).toBeCloseTo(1000, 3);
  });

  it('median handles even and odd windows', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('network boundary validation', () => {
  it('accepts a well-formed message', () => {
    const r = safeParse(c2sSchema, {
      t: 'SWING',
      seq: 3,
      ctPeak: 1234.5,
      speed: 7.2,
      dir: [0, 0.2, 0.98],
      q: [0, 0, 0, 1],
      elev: 0.2,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects junk without throwing', () => {
    for (const bad of [
      {},
      { t: 'NOPE' },
      { t: 'SWING' },
      { t: 'POSE', seq: 1, ct: 1, q: [1, 2] },
      { t: 'SWING', seq: 1, ctPeak: 1, speed: Number.NaN, dir: [0, 0, 1], q: [0, 0, 0, 1], elev: 0 },
      { t: 'HELLO', role: 'controller', room: 'AB', seat: 0, pairToken: 'x' },
    ]) {
      const r = safeParse(c2sSchema, bad);
      expect(r.ok).toBe(false);
    }
  });

  it('parseMessage handles non-JSON input', () => {
    expect(parseMessage(c2sSchema, 'not json at all').ok).toBe(false);
  });

  it('rejects room codes using ambiguous characters', () => {
    const r = safeParse(c2sSchema, {
      t: 'HELLO',
      role: 'controller',
      room: 'AB0O',
      seat: 0,
      pairToken: 'abcdefgh',
    });
    expect(r.ok).toBe(false);
  });
});

describe('player name sanitisation', () => {
  it('strips anything that should never reach a text-to-speech engine', () => {
    expect(sanitizeName('  Ro<script>bot  ')).toBe('Roscriptbot');
    expect(sanitizeName("Mary-Jane O'Neil")).toBe("Mary-Jane O'Neil");
    expect(sanitizeName('💀💀💀')).toBe('Player');
    expect(sanitizeName('')).toBe('Player');
    expect(sanitizeName(null)).toBe('Player');
    expect(sanitizeName('a'.repeat(80)).length).toBe(16);
  });
});
