/**
 * The timing ring: a circle closing on a fixed target, meeting it at contact.
 * Transplanted from `pickle`.
 *
 * Time to contact is the one thing a player on a phone cannot see — the ball is
 * on someone else's screen and their own hand is not in the picture. The other
 * sports draw this as a ring on the court under the predicted contact point,
 * because there the player is auto-positioned onto that spot and the question is
 * only "when". Here the player puts the bat where they like, so the ring is not
 * about a place at all: it is a clock, and it belongs on the screen rather than
 * in the world.
 *
 * Predicted in the browser rather than sent. The screen already has the ball's
 * position and velocity, and the prediction only has to be good for the next
 * second — sending it would spend a message per frame to say something the
 * client can work out.
 */

import { useEffect, useRef } from 'react';
import { lane, type Seat } from '@rally/protocol';
import type { RallyClient } from '../net/client.js';
import { dirOf, homeZ } from '../scene/pingpong.js';

interface Props {
  client: RallyClient;
  ownSeat: Seat;
}

/** How far ahead the ring starts closing, and how close to contact counts as now. */
const LEAD = 0.85;
const NOW = 0.13;

export function TimingRing({ client, ownSeat }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const seat = lane(ownSeat);

  useEffect(() => {
    let raf = 0;
    const frame = (): void => {
      raf = requestAnimationFrame(frame);
      const node = el.current;
      if (!node) return;
      const render = client.snapshots.sample(client.serverNow());
      const ball = render?.ball;
      const live = render?.phase === 'rally' || render?.phase === 'serve';
      if (!ball || !live) {
        node.hidden = true;
        return;
      }
      const d = dirOf(seat);
      const closing = ball.v[2] * d < -0.15; // coming toward this end
      const t = closing ? (homeZ(seat) - ball.p[2]) / ball.v[2] : -1;
      if (t < 0 || t > LEAD) {
        node.hidden = true;
        return;
      }
      node.hidden = false;
      node.style.setProperty('--k', (t / LEAD).toFixed(3));
      node.classList.toggle('now', t < NOW);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, [client, seat]);

  return (
    <div className="timing-ring" ref={el} hidden>
      <i />
    </div>
  );
}
