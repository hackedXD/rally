/**
 * The table tennis scene.
 *
 * A second renderer, sitting beside `Scene.tsx` for the same reason table tennis
 * has a second simulation: this one is not the shared scene with different
 * numbers. There is no player to draw — you are standing at the table holding
 * the bat, and the bat is the only thing on your side of it. The camera sits at
 * eye height half a metre behind your own edge rather than up in a broadcast
 * position, because a 2.74 m table framed from up there is a postage stamp.
 *
 * Transplanted from `pickle`, whose `game.js` this is the render loop of.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { lane, type Seat, type Vec3 } from '@rally/protocol';
import type { RallyClient } from '../net/client.js';
import type { RenderState } from '../net/snapshots.js';
import { feel } from '../store/feel.js';
import { PALETTE } from '../theme.js';
import {
  BAT_DROP,
  PP,
  buildTable,
  dirOf,
  makeBat,
  ppCamera,
  restPos,
  restQuat,
  type PpViewName,
} from './pingpong.js';

interface Props {
  client: RallyClient;
  ownSeat: Seat;
  view: PpViewName;
}

const TRAIL = 26;
/** How long the procedural stroke takes to play out. */
const SWING_MS = 240;
/** Metres above the table at which the ball's shadow vanishes. */
const SHADOW_FADE = 1.3;
const REST_EASE = 0.1;
/**
 * How far the bat may travel sideways in first person before the framing clamp
 * bites. At 0.6 m from the eye with a 62 degree lens this is still well inside
 * the frame; 0.22 squashed the whole 1.35 m of aim into a third of its travel,
 * which reads as a bat that barely follows your hand.
 */
const FP_REACH = 0.55;

/**
 * The band your own bat is drawn in, in first person, as heights above the table.
 *
 * Both ends were wrong. The floor used to be 0.02 — two centimetres above the
 * surface — which is where the BLADE sits, and the blade is not the lowest part
 * of a bat: the grip hangs `BAT_DROP` below it and went through the table
 * whenever the player leaned forward. It is set to that same drop now, even
 * though a bat at rest sits behind the table edge where nothing could clip:
 * matching the clearance floor below means leaning forward does not snap the bat
 * upward as it crosses the edge. One height, two reasons, no jump.
 *
 * The ceiling used to be 0.42, which put the whole band under the middle of the
 * frame, so the thing you are aiming with spent most of the rally at the bottom
 * edge of the screen or off it.
 *
 * Standing at the table the camera sits at 1.45 m looking 15 degrees down, and
 * the bat is about 0.6 m from the eye — so the visible band at that depth runs
 * from roughly 0.93 to 1.65, and 0.24 m of world travel sweeps a third of the
 * screen. This band sits in the lower part of it: the whole blade is on screen
 * across the entire range of the aim, the top of the range just reaches the net
 * line rather than covering the far court, and the bottom clears the table by
 * the length of the bat's own handle.
 */
const FP_LOW = BAT_DROP + 0.03;
const FP_HIGH = 0.46;

const clampTo = (v: number, m: number): number => Math.max(-m, Math.min(m, v));

const tmpQ = new THREE.Quaternion();
const swingQ = new THREE.Quaternion();
const AXIS_X = new THREE.Vector3(1, 0, 0);

export function PingPongScene({ client, ownSeat, view }: Props) {
  const seat = lane(ownSeat);
  const { camera } = useThree();

  const table = useMemo(() => buildTable(), []);
  const bats = useMemo(() => [makeBat(0, seat === 0), makeBat(1, seat === 1)], [seat]);
  useEffect(
    () => () => {
      table.dispose();
      for (const b of bats) b.dispose();
    },
    [table, bats],
  );

  const ball = useRef<THREE.Mesh>(null);
  const shadow = useRef<THREE.Mesh>(null);
  const trailBuf = useRef<Vec3[]>([]);
  /** When each seat's swing animation started, and where the ball was. */
  const swingAt = useRef<number[]>([-1e9, -1e9]);
  const swingSpeed = useRef<number[]>([0, 0]);
  const meetAt = useRef<(Vec3 | null)[]>([null, null]);
  const wasSwinging = useRef<boolean[]>([false, false]);
  const shown = useRef<Vec3 | null>(null);

  /**
   * The streak behind the ball: `TRAIL` positions, rewritten every frame.
   *
   * Built imperatively rather than as JSX because `<line>` is an SVG element in
   * the JSX namespace, so the three.js one cannot be written that way without
   * fighting the type system for no gain.
   */
  const trail = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0x7fd4ff,
      transparent: true,
      opacity: 0.45,
    });
    return new THREE.Line(geo, mat);
  }, []);
  useEffect(
    () => () => {
      trail.geometry.dispose();
      (trail.material as THREE.Material).dispose();
    },
    [trail],
  );

  const cam = useMemo(() => ppCamera(view, seat), [view, seat]);
  useEffect(() => {
    camera.position.set(...cam.position);
    camera.lookAt(...cam.target);
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      (camera as THREE.PerspectiveCamera).fov = cam.fov;
      (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
    }
  }, [camera, cam]);

  useFrame(() => {
    const now = performance.now();
    const render: RenderState | null = client.snapshots.sample(client.serverNow());

    // ── Camera ──────────────────────────────────────────────────────────────
    // A slow orbit that ends looking down the table, and a dolly in. The ball
    // history already exists, so a replay costs a camera path and nothing else.
    const replay = feel.replayBall(now);
    const [sx, sy] = feel.shakeOffset(now);
    if (replay) {
      const facing = seat === 0 ? 1 : -1;
      const a0 = -0.575;
      const ang = a0 + replay.progress * 1.15;
      const dist = PP.TABLE.LEN / 2 + 1.5 - replay.progress * 0.55;
      camera.position.set(
        Math.sin(ang) * dist * 0.75,
        1.15 + Math.sin(replay.progress * Math.PI) * 0.5,
        -facing * Math.cos(ang) * dist,
      );
      camera.lookAt(replay.p[0] * 0.6, replay.p[1], replay.p[2] * 0.6);
    } else {
      camera.position.set(cam.position[0] + sx, cam.position[1] + sy, cam.position[2]);
      camera.lookAt(...cam.target);
    }

    if (!render) {
      if (ball.current) ball.current.visible = false;
      if (shadow.current) shadow.current.visible = false;
      trail.visible = false;
      return;
    }

    // ── Ball, shadow and trail ──────────────────────────────────────────────
    const bp: Vec3 | null = replay ? replay.p : (render.ball?.p ?? null);
    shown.current = bp;
    if (ball.current) {
      ball.current.visible = bp !== null;
      if (bp) {
        ball.current.position.set(bp[0], bp[1], bp[2]);
        const punch = now < feel.flashUntil ? 1.8 : 1;
        ball.current.scale.setScalar(PP.BALL.R * punch);
        const mat = ball.current.material as THREE.MeshStandardMaterial;
        mat.emissiveIntensity = now < feel.flashUntil ? 2.2 : 0.45;
      }
    }

    /*
     * Standing at the table you judge height off the shadow, not the ball —
     * without this a near-first-person view is genuinely unplayable, because you
     * cannot tell a ball that will land from one sailing a foot long.
     */
    if (shadow.current && bp) {
      const h = Math.max(0, bp[1] - PP.TABLE.TOP);
      const overTable =
        Math.abs(bp[0]) < PP.TABLE.WIDTH / 2 + 0.25 &&
        Math.abs(bp[2]) < PP.TABLE.LEN / 2 + 0.25;
      shadow.current.visible = overTable && h < SHADOW_FADE;
      if (shadow.current.visible) {
        shadow.current.position.set(bp[0], PP.TABLE.TOP + 0.0016, bp[2]);
        const spread = PP.BALL.R * (1 + (h / SHADOW_FADE) * 2.4);
        shadow.current.scale.set(spread, spread, 1);
        (shadow.current.material as THREE.MeshBasicMaterial).opacity =
          0.55 * (1 - h / SHADOW_FADE);
      }
    } else if (shadow.current) {
      shadow.current.visible = false;
    }

    if (bp && !replay) {
      trailBuf.current.push([...bp]);
      while (trailBuf.current.length > TRAIL) trailBuf.current.shift();
    }
    {
      const arr = trail.geometry.attributes.position.array as Float32Array;
      const buf = trailBuf.current;
      for (let i = 0; i < TRAIL; i++) {
        const s = buf[Math.min(i, buf.length - 1)] ?? bp ?? [0, 0, 0];
        arr[i * 3] = s[0];
        arr[i * 3 + 1] = s[1];
        arr[i * 3 + 2] = s[2];
      }
      trail.geometry.attributes.position.needsUpdate = true;
      trail.visible = buf.length > 3;
    }

    // ── Bats ────────────────────────────────────────────────────────────────
    for (const p of render.players) {
      const i = lane(p.seat);
      const g = bats[i].group;

      const swinging = p.anim === 'swing';
      if (swinging && !wasSwinging.current[i]) {
        swingAt.current[i] = now;
        // Where the ball actually was. The hit is decided by WHEN you swung, not
        // by the bat having been on the ball — so remember where the ball was and
        // carry the bat through it, or the player watches their bat swing through
        // empty air and score a point.
        meetAt.current[i] = bp ? [...bp] : null;
        // How far the bat carries through scales with how hard the shot was, and
        // the shot's speed is already on screen: the ball left the bat this
        // frame, so its velocity IS the swing's result.
        const v = render.ball?.v;
        swingSpeed.current[i] = v ? Math.hypot(v[0], v[1], v[2]) : 4;
      }
      wasSwinging.current[i] = swinging;

      // Not picked up: the bat lies on the table, because that is where a bat is
      // when nobody has picked it up. Before this it hovered in mid-air chasing
      // the ball around, which reads as the bat bouncing along WITH the ball
      // rather than being swung at it.
      //
      // Per SEAT and every rally, not just between matches. Readiness clears the
      // moment a rally ends, so both bats go down on the table and come back up
      // one tap at a time — which is what makes the ready-up visible from across
      // the room, and makes the tap on the phone visibly do something at the end
      // of the room the player is looking at. The lift is the pick-up: REST_EASE
      // is a lerp, so the bat rises into the hand rather than snapping there.
      if (!render.ready[i] || render.phase === 'lobby' || render.phase === 'gameover') {
        const rest = restPos(i);
        g.position.x += (rest[0] - g.position.x) * REST_EASE;
        g.position.y += (rest[1] - g.position.y) * REST_EASE;
        g.position.z += (rest[2] - g.position.z) * REST_EASE;
        g.quaternion.slerp(restQuat(i), REST_EASE);
        continue;
      }

      // Tracked — a phone is driving it — the bat is drawn exactly where the sim
      // says the player's hand is.
      //
      // Untracked means a bot, or a seat whose phone has dropped. There the sim
      // auto-positions the bat onto the ball, and it does that wherever the ball
      // is — so drawn literally, such a bat chases the ball into the opponent's
      // half. It only reaches for balls on its own side.
      const onMySide = bp ? (i === 0 ? bp[2] < 0 : bp[2] > 0) : false;
      const tracked = !p.bot && p.connected;
      let wantX = tracked ? p.p[0] : onMySide ? clampTo(p.p[0], 0.8) : 0;
      let wantY = tracked
        ? p.p[1]
        : onMySide
          ? Math.max(PP.TABLE.TOP + 0.1, Math.min(1.5, p.p[1]))
          : PP.TABLE.TOP + 0.22;
      let wantZ = p.p[2];

      /*
       * Render-only framing clamp. Standing at the table your own bat is barely
       * half a metre from the eye, so the true hit position often sits below the
       * frame. Hit logic uses the real position; this only keeps the thing you
       * are aiming with on screen.
       */
      if (i === seat && view === 'first') {
        wantX = Math.max(-FP_REACH, Math.min(FP_REACH, wantX));
        wantY = Math.max(PP.TABLE.TOP + FP_LOW, Math.min(PP.TABLE.TOP + FP_HIGH, wantY));
      }

      /*
       * ...and a floor that applies to every bat in every view, not just your
       * own in first person.
       *
       * The simulation reports where the blade is, and is right to: that is what
       * the ball meets. But the handle hangs below it, so a bat held at a height
       * the sim considers perfectly comfortable is one whose grip is inside the
       * table — and the forward lean and the swing follow-through both carry it
       * over the surface, where that is visible. Render-only: the contact point
       * is untouched, and this never moves a bat that was not about to clip.
       */
      const overTable =
        Math.abs(wantX) <= PP.TABLE.WIDTH / 2 + BAT_DROP &&
        Math.abs(wantZ) <= PP.TABLE.LEN / 2 + BAT_DROP;
      if (overTable) wantY = Math.max(wantY, PP.TABLE.TOP + BAT_DROP);

      // Through the contact, drive the bat to where the ball really was. Physics
      // and animation are separate; this is what keeps them from looking separate.
      const meet = meetAt.current[i];
      const age = now - swingAt.current[i];
      if (meet && age < SWING_MS) {
        const k = 1 - age / SWING_MS;
        wantX += (meet[0] - wantX) * k;
        wantY += (meet[1] - wantY) * k;
        wantZ += (meet[2] - wantZ) * k;
      }

      const ease = tracked ? 0.75 : 0.25;
      g.position.x += (wantX - g.position.x) * ease;
      g.position.y += (wantY - g.position.y) * ease;
      g.position.z += (wantZ - g.position.z) * ease;
      tmpQ.set(p.paddleQ[0], p.paddleQ[1], p.paddleQ[2], p.paddleQ[3]);
      g.quaternion.slerp(tmpQ, tracked ? 0.8 : 0.35);

      // A bat that teleports to the ball never looks like it hit anything. On
      // every contact play a short procedural stroke — out along the shot and
      // back — so the swing you feel on the phone is a swing you see on screen.
      if (age < SWING_MS) {
        const t = age / SWING_MS;
        const dir = dirOf(i);
        // out and back, weighted so the strike is quick and the recovery slow
        const arc = Math.sin(Math.pow(t, 0.7) * Math.PI);
        const reach = 0.2 + Math.min(0.18, swingSpeed.current[i] * 0.014);
        g.position.z += dir * arc * reach;
        g.position.y += arc * 0.09;
        g.position.x -= dir * arc * 0.05;
        swingQ.setFromAxisAngle(AXIS_X, -dir * arc * 0.95);
        g.quaternion.multiply(swingQ);
      }

      // The same floor, applied once more to where the bat actually ended up.
      // The stroke above carries it up to 0.38 m further forward than the target
      // the floor was computed from, which is enough to take a bat that was
      // safely behind the edge and put it over the table mid-follow-through.
      if (
        Math.abs(g.position.x) <= PP.TABLE.WIDTH / 2 + BAT_DROP &&
        Math.abs(g.position.z) <= PP.TABLE.LEN / 2 + BAT_DROP
      ) {
        g.position.y = Math.max(g.position.y, PP.TABLE.TOP + BAT_DROP);
      }
    }
  });

  return (
    <>
      <color attach="background" args={[PALETTE.apronDeep]} />
      <fog attach="fog" args={[PALETTE.apronDeep, 8, 20]} />

      <hemisphereLight args={[PALETTE.chalk, PALETTE.apronDeep, 1.45]} />
      <directionalLight position={[2.5, 5, 1.5]} intensity={1.25} castShadow>
        <orthographicCamera attach="shadow-camera" args={[-3, 3, 3, -3, 0.5, 14]} />
      </directionalLight>
      <directionalLight position={[-2, 3, -3]} intensity={0.5} color={PALETTE.chalk} />
      {/* a low rim light picks the ball and the net tape out against the dark end */}
      <directionalLight position={[0, 1.2, -4]} intensity={0.5} color={PALETTE.chalk} />

      <primitive object={table.group} />
      {bats.map((b, i) => (
        <primitive key={i} object={b.group} />
      ))}

      <mesh ref={ball} castShadow>
        <sphereGeometry args={[1, 32, 20]} />
        <meshStandardMaterial color={PALETTE.optic} emissive={PALETTE.optic} emissiveIntensity={0.3} roughness={0.5} />
      </mesh>
      <mesh ref={shadow} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1, 24]} />
        <meshBasicMaterial color={PALETTE.ink} transparent opacity={0.38} depthWrite={false} />
      </mesh>
      <primitive object={trail} />
    </>
  );
}
