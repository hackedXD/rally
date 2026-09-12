import { afterEach, describe, expect, it } from 'vitest';
import {
  ClockSync,
  NAME_KEY,
  NAME_MAX,
  QUAT_IDENTITY,
  c2sSchema,
  d2sSchema,
  dequantQuat,
  filterName,
  loadName,
  median,
  parseMessage,
  qFromUnitZTo,
  qmul,
  qnorm,
  qrot,
  quantQuat,
  safeParse,
  sanitizeName,
  saveName,
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

/**
 * The remembered name.
 *
 * Worth testing in Node specifically. This module is compiled into the two
 * browser apps but lives in the package the SERVER imports, so the no-storage
 * path is not a hypothetical — it is what every test run and every server
 * process takes, and a throw there is a blank page or a dead process.
 */
describe('the remembered player name', () => {
  const fake = (): Map<string, string> => {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    return store;
  };

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it('survives having nowhere to store anything', () => {
    // Node, a private window, a browser told to refuse site data.
    expect(() => saveName('Ada')).not.toThrow();
    expect(saveName('Ada')).toBe('Ada');
    expect(loadName().length).toBeGreaterThan(0);
  });

  it('remembers what was set, under the key both surfaces read', () => {
    const store = fake();
    expect(saveName('Ada')).toBe('Ada');
    // The phone and the screen agree on this string or they remember two
    // different people.
    expect(store.get(NAME_KEY)).toBe('Ada');
    expect(loadName()).toBe('Ada');
  });

  it('sanitises on the way out as well as in', () => {
    const store = fake();
    // A name stored before the field existed, or typed into devtools, is still
    // user input by the time the commentator reads it aloud.
    store.set(NAME_KEY, '<b>Ada</b>');
    expect(loadName()).toBe('bAdab');
    expect(saveName('  Ada   Lovelace  ')).toBe('Ada Lovelace');
    expect(saveName('💀')).toBe('Player');
  });

  it('invents one, once, when there is nothing to remember', () => {
    const store = fake();
    const first = loadName();
    expect(first).toMatch(/^[A-Za-z]+ [A-Za-z]+$/);
    // Kept, so a rematch does not rename somebody mid-session.
    expect(store.get(NAME_KEY)).toBe(first);
    expect(loadName()).toBe(first);
    // Whitespace is not a name to be preserved.
    store.set(NAME_KEY, '   ');
    expect(loadName()).not.toBe('   ');
  });

  it('keeps a half-typed name typeable', () => {
    // What the text boxes run on every keystroke. It must leave alone everything
    // that could still become a real name — including the trailing space of
    // "Ada ", without which the surname is unreachable, and the empty box you
    // get from select-all-delete.
    expect(filterName('Ada ')).toBe('Ada ');
    expect(filterName('')).toBe('');
    expect(filterName("O'Neil-Smith")).toBe("O'Neil-Smith");
    // ...and it strips rather than rejects, so one stray character in a pasted
    // name costs that character instead of the whole paste.
    expect(filterName('Ada <3')).toBe('Ada 3');
    expect(filterName('<script>')).toBe('script');
    expect(filterName('💀')).toBe('');
    expect(filterName('a'.repeat(NAME_MAX + 20)).length).toBe(NAME_MAX);
  });

  it('carries a name from the screen as well as the phone', () => {
    // The screen had no way to name its own seat before: the only message with
    // a name on it was the controller's READY.
    const set = safeParse(d2sSchema, { t: 'SET_NAME', name: '  Ada<>  ' });
    expect(set.ok && set.value.t === 'SET_NAME' && set.value.name).toBe('Ada');
    // And it is sanitised at the boundary, not trusted from the client.
    const long = safeParse(d2sSchema, { t: 'SET_NAME', name: 'a'.repeat(40) });
    expect(long.ok && long.value.t === 'SET_NAME' && long.value.name.length).toBe(NAME_MAX);
    // Past the field's own ceiling it is dropped rather than trimmed, exactly as
    // READY is: a client sending sixty-four characters is not one to negotiate
    // with.
    expect(safeParse(d2sSchema, { t: 'SET_NAME', name: 'a'.repeat(200) }).ok).toBe(false);
  });
});
