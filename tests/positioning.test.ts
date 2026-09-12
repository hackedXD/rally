/**
 * The positioning oracle, ported from the pickle project's own self-checks.
 *
 * These are that project's assertions, run against this engine, because "the
 * paddle goes where my hand goes" is the one thing a port can get subtly wrong
 * and still look like it works. Every one of them is about a sign: reach right
 * and the bat goes right, turn the phone over and the bat does not move, play
 * the ball on your right with a stroke that came from your right.
 *
 * The fixtures are in this engine's own frame — the same frame `toPpPose` hands
 * it — so a failure here is the engine, and a failure only on a real phone is
 * the controller.
 */
import { describe, expect, it } from 'vitest';
import { pingpong } from '@rally/sim';
import { qmul, qrot, type Quat } from '@rally/protocol';

const {
  AIM,
  TABLE,
  aimFromPose,
  canHit,
  dirOf,
  makeBall,
  newMatch,
  rightOf,
  setHand,
  swingCheck,
} = pingpong;

const NEUTRAL: [number, number] = [0, TABLE.TOP + 0.25];
const yawBy = (a: number): Quat => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const SEATS = [0, 1] as const;

describe('where the bat goes', () => {
  it('puts the bat on screen-right when the player reaches right', () => {
    for (const p of SEATS) {
      const pose = yawBy(-0.3);
      // The fixture itself has to be right, or the assertion below proves nothing.
      expect(qrot(pose, [0, 0, -1])[0], 'fixture aims to the player右 right').toBeGreaterThan(0);
      const aimed = aimFromPose(p, pose, NEUTRAL);
      expect(Math.sign(aimed.x), `seat ${p}: reaching right must put the bat on world x ${rightOf(p)}`)
        .toBe(rightOf(p));
    }
  });

  it('raises the bat when the face tilts up, for both seats', () => {
    for (const p of SEATS) {
      const lifted = aimFromPose(p, [Math.sin(0.15), 0, 0, Math.cos(0.15)], NEUTRAL);
      expect(lifted.y, `seat ${p}`).toBeGreaterThan(NEUTRAL[1]);
    }
  });

  /**
   * THE FOREHAND TEST. Turning the phone over about its own long axis is what
   * your hand does to play a forehand, and it must change nothing about where
   * the bat is — only which side of it meets the ball.
   */
  it('does not move the bat when the phone turns over for a forehand', () => {
    const overTheTop: Quat = [0, 1, 0, 0];
    const held: [string, Quat][] = [
      ['square', [0, 0, 0, 1]],
      ['reaching wide', yawBy(-0.4)],
      ['face open', [Math.sin(0.2), 0, 0, Math.cos(0.2)]],
      ['wide and open', qmul(yawBy(-0.4), [Math.sin(0.2), 0, 0, Math.cos(0.2)])],
    ];
    for (const p of SEATS) {
      for (const [name, q] of held) {
        const back = aimFromPose(p, q, NEUTRAL);
        const front = aimFromPose(p, qmul(q, overTheTop), NEUTRAL);
        expect(back.x, `seat ${p} ${name}: sideways`).toBeCloseTo(front.x, 9);
        expect(back.y, `seat ${p} ${name}: up and down`).toBeCloseTo(front.y, 9);
        expect(back.face, `seat ${p} ${name}: but it IS the other face`).toBe(-front.face);
      }
    }
  });
});

describe('forehand and backhand', () => {
  /**
   * The stroke has to suit the side, and it is told from the direction the hand
   * came FROM — so it holds for a left-hander and a right-hander identically.
   */
  it('asks for the stroke that matches the side, on both seats', () => {
    for (const p of SEATS) {
      const side = rightOf(p);
      const ballOn = (rel: number) => ({
        ...newMatch(p),
        phase: 'rally' as const,
        lastHit: (1 - p) as 0 | 1,
        bouncesSinceHit: 1,
        ball: makeBall([0.6 * rel * side, TABLE.TOP + 0.25, -dirOf(p) * 1.5], [0, 0, 0]),
      });
      const bat = (m: ReturnType<typeof ballOn>, rel: number) =>
        setHand(m, p, { x: 0.6 * rel * side, y: TABLE.TOP + 0.25, z: 0 });

      // Only `vsw` is read by the wing check; the rest of a PpSwing is not part
      // of this question, and inventing values for it would only obscure that.
      const toRight = { vsw: [2.0, 0, -2.0] } as never;
      const toLeft = { vsw: [-2.0, 0, -2.0] } as never;
      const straight = { vsw: [0, 0, -2.4] } as never;

      const onRight = bat(ballOn(+1), +1);
      expect(swingCheck(onRight, p, toLeft), `seat ${p}: right ball, stroke from the right`).toBe(null);
      expect(swingCheck(onRight, p, toRight), `seat ${p}: right ball, other wing`).toBe('wrong wing');

      const onLeft = bat(ballOn(-1), -1);
      expect(swingCheck(onLeft, p, toRight), `seat ${p}: left ball, stroke from the left`).toBe(null);
      expect(swingCheck(onLeft, p, toLeft), `seat ${p}: left ball, other wing`).toBe('wrong wing');

      // A drive straight through belongs to neither wing.
      expect(swingCheck(onRight, p, straight)).toBe(null);
      expect(swingCheck(onLeft, p, straight)).toBe(null);

      // A stroke we cannot measure is never punished.
      expect(swingCheck(onRight, p, {} as never)).toBe(null);
    }
  });

  it('takes either wing on a ball down the middle', () => {
    for (const p of SEATS) {
      const mid = setHand(
        {
          ...newMatch(p),
          phase: 'rally' as const,
          lastHit: (1 - p) as 0 | 1,
          bouncesSinceHit: 1,
          ball: makeBall([0, TABLE.TOP + 0.25, -dirOf(p) * 1.5], [0, 0, 0]),
        },
        p,
        { x: 0, y: TABLE.TOP + 0.25, z: 0 },
      );
      expect(swingCheck(mid, p, { vsw: [-2, 0, -2] } as never)).toBe(null);
      expect(swingCheck(mid, p, { vsw: [2, 0, -2] } as never)).toBe(null);
    }
  });
});

describe('reach', () => {
  const wide = {
    ...newMatch(0),
    phase: 'rally' as const,
    lastHit: 1 as 0 | 1,
    bouncesSinceHit: 1,
    ball: makeBall([0.62, TABLE.TOP + 0.25, -1.5], [0, 0, 0]),
  };

  it('reaches a wide ball when the bat is out there, and misses when it is not', () => {
    expect(canHit(setHand(wide, 0, { x: 0.62, y: TABLE.TOP + 0.25 }), 0)).toBe(true);
    const flatfooted = setHand(wide, 0, { x: -0.55, y: TABLE.TOP + 0.25 });
    expect(canHit(flatfooted, 0)).toBe(false);
    expect(swingCheck(flatfooted, 0), 'and the whiff must say why').toBe('reach');
  });

  it('still connects when reaching wide turns the face off axis', () => {
    // Aim IS the face normal here, so stretching for a ball tilts the face.
    // Every one of these must connect, or stretching becomes self-defeating.
    const square = setHand(wide, 0, { x: 0.62, y: TABLE.TOP + 0.25 });
    for (const yaw of [0, 0.35, 0.7, 1.0]) {
      const turned: Quat = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
      expect(swingCheck(square, 0, { q: turned } as never), `${(yaw * 57).toFixed(0)} degrees wide`).toBe(null);
    }
  });

  it('does not treat height as a zone', () => {
    const low = { ...wide, ball: makeBall([0.62, TABLE.TOP + 0.02, -1.5], [0, 0, 0]) };
    expect(canHit(setHand(low, 0, { x: 0.62, y: TABLE.TOP + 0.85 }), 0)).toBe(true);
  });
});

describe('the bat as it is drawn', () => {
  /**
   * The display draws a bat straight from `paddleFrame(...).worldQ`, for both
   * seats, from the same snapshot. So the seat mapping has to be symmetric: the
   * opponent's bat is the one nobody can sanity-check by waving their own phone,
   * and a mirror there is invisible until somebody plays a real match.
   */
  it('points both seats\' bats across the net, not along it', () => {
    for (const p of SEATS) {
      const { normal } = pingpong.paddleFrame(p, [0, 0, 0, 1]);
      // dirOf is the way this seat plays. The face has to be looking that way.
      expect(Math.sign(normal[2]), `seat ${p} faces its own end`).toBe(Math.sign(dirOf(p)));
    }
  });

  it('mirrors the two seats and nothing else', () => {
    // A pose aimed to the player's own right, for each seat. The drawn bat must
    // end up on that seat's own right in WORLD terms — which is rightOf, and is
    // opposite for the two seats. Equal magnitudes, opposite signs: a mirror of
    // each other and nothing more.
    const aimRight = yawBy(-0.3);
    const x = SEATS.map((p) => pingpong.paddleFrame(p, aimRight).normal[0]);
    expect(Math.sign(x[0]), 'seat 0 right is world -x').toBe(rightOf(0));
    expect(Math.sign(x[1]), 'seat 1 right is world +x').toBe(rightOf(1));
    expect(Math.abs(x[0])).toBeCloseTo(Math.abs(x[1]), 9);
  });
});

describe('AIM spans', () => {
  it('keeps the pickle spans, which is what makes the reach feel the same', () => {
    expect(AIM.SPAN_X).toBe(1.35);
    expect(AIM.SPAN_Y).toBe(1.05);
    expect(AIM.SMOOTH).toBe(0.18);
  });
});
