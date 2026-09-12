/**
 * The scene.
 *
 * One directional light with soft shadows, a gradient sky, primitives for
 * everything, and the feel checklist from §8.4.3 in priority order: trail,
 * contact flash and hitstop, screen shake, ball shadow, strike telegraph,
 * winning-shot replay.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  TUNING,
  lane,
  seatSign,
  type CourtSpec,
  type Seat,
  type SportId,
  type Vec3,
} from '@rally/protocol';
import type { RallyClient } from '../net/client.js';
import type { RenderState } from '../net/snapshots.js';
import { feel } from '../store/feel.js';
import {
  BALL_RADIUS,
  LOOKS,
  RACKETS,
  cameraFor,
  makeCourtTexture,
  makeNetTexture,
  makePaddleGeometry,
} from './court.js';

interface Props {
  client: RallyClient;
  court: CourtSpec;
  sport: SportId;
  ownSeat: Seat;
}

const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

export function Scene({ client, court, sport, ownSeat }: Props) {
  const look = LOOKS[sport];
  const ballRadius = BALL_RADIUS[sport];
  const racket = RACKETS[sport];
  const courtTex = useMemo(() => makeCourtTexture(court, look, sport), [court, look, sport]);
  const netTex = useMemo(() => makeNetTexture(), []);
  // Built once per sport and shared by both seats' paddles, which is the whole
  // reason it is not inline JSX: an extruded outline is not free, and there are
  // two of them on screen.
  const paddleGeo = useMemo(
    () => (racket.shape === 'paddle' ? makePaddleGeometry(racket) : null),
    [racket],
  );
  useEffect(() => () => paddleGeo?.dispose(), [paddleGeo]);
  useEffect(() => () => {
    courtTex.dispose();
    netTex.dispose();
  }, [courtTex, netTex]);

  const ball = useRef<THREE.Mesh>(null);
  const ballShadow = useRef<THREE.Mesh>(null);
  const trail = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const impact = useRef<THREE.Mesh>(null);
  const rigs = useRef<(THREE.Group | null)[]>([null, null]);
  const paddles = useRef<(THREE.Group | null)[]>([null, null]);
  /** When each seat's swing animation started, for the paddle arc. */
  const swingAt = useRef<number[]>([-1e9, -1e9]);
  const wasSwinging = useRef<boolean[]>([false, false]);

  const { camera, size } = useThree();
  const aspect = size.width / Math.max(1, size.height);
  const cam = useMemo(
    () => cameraFor(court, lane(ownSeat), aspect),
    [court, ownSeat, aspect],
  );
  const back = Math.abs(cam.position[2]);

  // Everything that needs to scale with the scene, derived from the camera rather
  // than from the court: fog tuned to court size alone leaves the far half of a
  // small court almost fully fogged out, because the camera does not sit at a
  // fixed multiple of the court length.
  const fogNear = back * 1.15;
  const fogFar = back * 3.6;
  // The shadow frustum has to cover the players too, and they stand well outside
  // the lines — behind a table, or a reach past a baseline.
  const shadowSpan = Math.max(court.length, court.width) * 0.62 + 3.0;

  useEffect(() => {
    camera.position.set(...cam.position);
    camera.lookAt(...cam.target);
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      (camera as THREE.PerspectiveCamera).fov = cam.fov;
      (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
    }
  }, [camera, cam]);

  const trailGeo = useMemo(() => new THREE.BufferGeometry(), []);
  useEffect(() => () => trailGeo.dispose(), [trailGeo]);

  useFrame(() => {
    const now = performance.now();
    const render: RenderState | null = client.snapshots.sample(client.serverNow());

    // Step 4 of the contact model arrives in the snapshot stream. Consume it here
    // rather than on a timer: this is the only place it is used, and it is needed
    // at frame rate.
    const pending = client.snapshots.takeReconcile();
    if (pending) {
      feel.reconcile = {
        seat: pending.seat,
        p: pending.p,
        at: now,
        kind: pending.kind,
      };
    }

    // ── Camera: fixed during play, swooping only for the replay ──────────────
    const replay = feel.replayBall(now);
    const [sx, sy] = feel.shakeOffset(now);
    if (replay) {
      const t = replay.progress;
      const sign = seatSign(lane(ownSeat) as Seat);
      const angle = -0.9 + t * 1.8;
      // Orbit at the broadcast camera's own distance rather than a fraction of
      // the court length: on a small court the latter puts the camera inside the
      // table and the replay plays out from under the net.
      const radius = back * 0.78;
      camera.position.set(
        Math.sin(angle) * radius,
        court.tableHeight + cam.position[1] * 0.5 + Math.sin(t * Math.PI) * back * 0.12,
        sign * (radius * 0.8) + Math.cos(angle) * radius * 0.2,
      );
      camera.lookAt(replay.p[0], replay.p[1] + 0.2, replay.p[2]);
    } else {
      camera.position.set(cam.position[0] + sx, cam.position[1] + sy, cam.position[2]);
      camera.lookAt(...cam.target);
    }

    if (!render) {
      // Nothing to draw yet — the buffer is empty because no snapshot has arrived
      // (a display that just joined, or one waiting out a reconnect). Returning
      // here without hiding anything leaves every object at the pose it was
      // mounted with: two players stacked at the centre of the net, and the ball,
      // whose geometry is a UNIT sphere scaled to the sport's radius each frame,
      // drawn at a full metre across.
      if (ball.current) ball.current.visible = false;
      if (ballShadow.current) ballShadow.current.visible = false;
      if (trail.current) trail.current.visible = false;
      if (ring.current) ring.current.visible = false;
      if (impact.current) impact.current.visible = false;
      for (const rig of rigs.current) if (rig) rig.visible = false;
      for (const paddle of paddles.current) if (paddle) paddle.visible = false;
      return;
    }
    for (const rig of rigs.current) if (rig) rig.visible = true;
    for (const paddle of paddles.current) if (paddle) paddle.visible = true;

    // ── Ball, trail and shadow ──────────────────────────────────────────────
    const bp: Vec3 | null = replay ? replay.p : render.ball?.p ?? null;
    if (ball.current) {
      ball.current.visible = bp !== null;
      if (bp) {
        ball.current.position.set(bp[0], bp[1], bp[2]);
        // 40 ms of scale punch on contact. The geometry is a unit sphere so the
        // ball is always exactly the sport's real radius.
        const punch = now < feel.flashUntil ? 1.9 : 1;
        ball.current.scale.setScalar(ballRadius * punch);
        const mat = ball.current.material as THREE.MeshStandardMaterial;
        mat.emissiveIntensity = now < feel.flashUntil ? 2.4 : 0.35;
      }
    }
    // The shadow under the ball is what lets players judge depth on a 2D screen,
    // and it is worth more than everything below it on the feel list.
    if (ballShadow.current) {
      ballShadow.current.visible = bp !== null;
      if (bp) {
        const height = Math.max(0, bp[1] - court.tableHeight);
        const onTable =
          court.tableHeight > 0 &&
          Math.abs(bp[0]) <= court.width / 2 &&
          Math.abs(bp[2]) <= court.length / 2;
        const floor = onTable ? court.tableHeight : 0;
        ballShadow.current.position.set(bp[0], floor + 0.006, bp[2]);
        const spread = ballRadius * 1.5 * (1 + height * 0.5);
        ballShadow.current.scale.set(spread, spread, 1);
        (ballShadow.current.material as THREE.MeshBasicMaterial).opacity =
          Math.max(0.05, 0.42 - height * 0.06);
      }
    }
    if (bp && !replay) feel.pushTrail(bp);
    if (trail.current) {
      updateTrail(trailGeo, feel.trail, court);
      trail.current.visible = feel.trail.length > 3;
    }

    // ── Players and paddles ─────────────────────────────────────────────────
    for (const p of render.players) {
      const i = lane(p.seat);
      const rig = rigs.current[i];
      const paddle = paddles.current[i];
      if (rig) {
        // Feet on the FLOOR, never on the playing surface. For a table sport the
        // sim already keeps the body behind the edge; standing them at table
        // height as well would put them on top of it.
        rig.position.set(p.p[0], 0, p.p[2]);
        // Face the net.
        rig.rotation.y = p.seat === 0 ? 0 : Math.PI;
        const wind = p.anim === 'wind' ? 0.12 : 0;
        const swing = p.anim === 'swing' ? -0.18 : 0;
        const celebrate = p.anim === 'celebrate' ? Math.sin(now * 0.012) * 0.14 : 0;
        rig.rotation.z = wind + swing + celebrate;
      }
      // A swing the player can see. The phone reports orientation, not a swing
      // path, so without this the paddle just points somewhere slightly different
      // and the most physical moment in the game has no motion in it.
      const swinging = p.anim === 'swing';
      if (swinging && !wasSwinging.current[i]) swingAt.current[i] = now;
      wasSwinging.current[i] = swinging;

      if (paddle) {
        tmpQ.set(p.paddleQ[0], p.paddleQ[1], p.paddleQ[2], p.paddleQ[3]);
        const armLen = racket.armLen;
        // The paddle hangs off the hand, in front of the shoulder.
        const forward = tmpV.set(0, 0, 1).applyQuaternion(tmpQ);
        const shoulder = new THREE.Vector3(
          p.p[0] + racket.holdSide * -seatSign(p.seat),
          racket.holdHeight,
          p.p[2] + seatSign(p.seat) * -0.12,
        );
        let target = shoulder.clone().addScaledVector(forward, armLen);

        // Sweep the paddle through a short arc across the body: back on the
        // wind-up, through and past the contact point, then settle.
        const swingAge = now - swingAt.current[i];
        const SWING_MS = 260;
        let roll = 0;
        if (swingAge < SWING_MS) {
          const t = swingAge / SWING_MS;
          // -1 behind, +1 through. Fast through the middle, like a real swing.
          const arc = Math.sin(t * Math.PI - Math.PI / 2);
          target.add(
            new THREE.Vector3(1, 0, 0).applyQuaternion(tmpQ).multiplyScalar(-arc * 0.5),
          );
          target.y += Math.cos(t * Math.PI) * 0.12;
          roll = arc * 0.9;
        } else if (p.anim === 'whiff') {
          roll = 0.5;
        }

        // Step 4 of the contact model: on a registered hit, drive the paddle
        // through the ball's real contact point rather than the raw phone pose,
        // then blend back. The player's hand was probably 20 cm off and the
        // screen must never show a paddle passing through empty air.
        const rec = feel.reconcile;
        if (rec && lane(rec.seat as Seat) === i) {
          const age = now - rec.at;
          const drive = TUNING.strike.reconcileMs;
          const blend = TUNING.strike.reconcileBlendBackMs;
          if (age <= drive + blend) {
            const contact = new THREE.Vector3(rec.p[0], rec.p[1], rec.p[2]);
            if (rec.kind === 'whiff') {
              // Sell the miss: exaggerate past the ball.
              contact.addScaledVector(forward, 0.55);
            }
            const k =
              age < drive
                ? smooth(age / drive)
                : 1 - smooth((age - drive) / blend);
            target = target.lerp(contact, k);
          } else {
            feel.reconcile = null;
          }
        }
        paddle.position.copy(target);
        paddle.quaternion.copy(tmpQ);
        // After the quaternion, not before: setting `rotation` first and then
        // copying a quaternion silently discards it, since they are two views of
        // the same underlying value.
        if (roll !== 0) paddle.rotateZ(roll);
      }
    }

    // ── Strike telegraph ────────────────────────────────────────────────────
    // A ring on the court that closes over the last 400 ms before contact. This
    // teaches timing without a tutorial.
    if (ring.current) {
      const tel = render.strike;
      const show =
        tel !== null &&
        (render.phase === 'rally' || render.phase === 'serve') &&
        tel.tIdeal - render.t < TUNING.feel.telegraphLeadMs + 260;
      ring.current.visible = Boolean(show);
      if (show && tel) {
        const lead = TUNING.feel.telegraphLeadMs;
        const remaining = tel.tIdeal - render.t;
        const closing = 1 - Math.max(0, Math.min(1, remaining / lead));
        const radius = 0.95 * (1 - closing * 0.72) + 0.22;
        ring.current.position.set(tel.p[0], court.tableHeight + 0.012, tel.p[2]);
        ring.current.scale.setScalar(radius);
        const mine = tel.seat === ownSeat;
        const mat = ring.current.material as THREE.MeshBasicMaterial;
        mat.color.set(mine ? (tel.open ? '#f8fafc' : LOOKS[sport].accent) : '#64748b');
        // Harder balls draw a thinner ring: the difficulty number made visible.
        mat.opacity = (mine ? 0.95 : 0.4) * (1 - tel.difficulty * 0.45);
      }
    }

    // ── Contact ring ────────────────────────────────────────────────────────
    if (impact.current) {
      const im = feel.impact;
      const age = im ? now - im.at : 1e9;
      const life = 260;
      impact.current.visible = age < life;
      if (im && age < life) {
        const t = age / life;
        impact.current.position.set(im.p[0], im.p[1], im.p[2]);
        impact.current.scale.setScalar(0.15 + t * (0.6 + im.strength * 0.9));
        (impact.current.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.8;
      }
    }
  });

  const half = court.length / 2;
  const netH = court.netHeight;

  return (
    <>
      <color attach="background" args={[look.surround]} />
      <fog attach="fog" args={[look.surround, fogNear, fogFar]} />

      <hemisphereLight args={['#d6e4ff', look.surround, 1.15]} />
      <ambientLight intensity={0.45} />
      <directionalLight
        position={[shadowSpan * 0.7, shadowSpan * 1.1, -shadowSpan * 0.45]}
        intensity={2.5}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0008}
        shadow-normalBias={0.02}
      >
        <orthographicCamera
          attach="shadow-camera"
          args={[-shadowSpan, shadowSpan, shadowSpan, -shadowSpan, 0.5, shadowSpan * 4]}
        />
      </directionalLight>

      {/* Surround */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[court.width + court.surround * 2, court.length + court.surround * 2]} />
        <meshStandardMaterial color={look.surround} roughness={0.95} metalness={0} />
      </mesh>

      {/* Playing surface */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, court.tableHeight, 0]}
        receiveShadow
      >
        <planeGeometry args={[court.width, court.length]} />
        <meshStandardMaterial map={courtTex} roughness={0.72} metalness={0.02} />
      </mesh>

      {/* Table apron and legs, for sports played above the floor */}
      {court.tableHeight > 0 && (
        <>
          {/* The apron sits clear of the playing surface. Coplanar faces z-fight,
              and the artefact reads as large dark rectangles sliding across the
              table rather than as the depth-buffer tie that it is. */}
          <mesh position={[0, court.tableHeight - 0.08, 0]} castShadow>
            <boxGeometry args={[court.width + 0.06, 0.12, court.length + 0.06]} />
            <meshStandardMaterial color={look.surfaceEdge} roughness={0.6} />
          </mesh>
          {[
            [-court.width / 2 + 0.3, -court.length / 2 + 0.4],
            [court.width / 2 - 0.3, -court.length / 2 + 0.4],
            [-court.width / 2 + 0.3, court.length / 2 - 0.4],
            [court.width / 2 - 0.3, court.length / 2 - 0.4],
          ].map(([x, z], i) => (
            // Stops short of the apron, for the same reason the apron stops
            // short of the surface: coplanar faces z-fight.
            <mesh key={i} position={[x, (court.tableHeight - 0.16) / 2, z]} castShadow>
              <boxGeometry args={[0.12, court.tableHeight - 0.16, 0.12]} />
              <meshStandardMaterial color="#111820" roughness={0.7} />
            </mesh>
          ))}
        </>
      )}

      {/* Net: an alpha-mapped plane plus a solid tape and two posts */}
      {netH > 0 && (
        <group position={[0, court.tableHeight, 0]}>
          <mesh position={[0, netH / 2, 0]}>
            <planeGeometry args={[court.width, netH]} />
            <meshBasicMaterial
              map={makeNetMaterialTexture(netTex)}
              alphaMap={netTex}
              transparent
              opacity={0.92}
              color="#dbe6f5"
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
          <mesh position={[0, netH + 0.012, 0]}>
            <boxGeometry args={[court.width, 0.035, 0.02]} />
            <meshStandardMaterial color="#f8fafc" roughness={0.5} />
          </mesh>
          {[-1, 1].map((s) => (
            <mesh key={s} position={[(s * court.width) / 2, netH / 2, 0]} castShadow>
              <cylinderGeometry args={[0.028, 0.028, netH, 10]} />
              <meshStandardMaterial color="#94a3b8" metalness={0.5} roughness={0.4} />
            </mesh>
          ))}
        </group>
      )}

      {/* Ball, its shadow, and the trail */}
      <mesh ref={ball} castShadow>
        <sphereGeometry args={[1, 20, 16]} />
        <meshStandardMaterial
          color="#fde047"
          emissive="#fde047"
          emissiveIntensity={0.35}
          roughness={0.45}
        />
      </mesh>
      <mesh ref={ballShadow} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1, 24]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.35} depthWrite={false} />
      </mesh>
      <mesh ref={trail} geometry={trailGeo}>
        <meshBasicMaterial
          color="#fef08a"
          transparent
          opacity={0.55}
          depthWrite={false}
          side={THREE.DoubleSide}
          vertexColors
        />
      </mesh>

      {/* Telegraph and impact rings */}
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.82, 1, 48]} />
        <meshBasicMaterial color="#4ade80" transparent opacity={0.9} depthWrite={false} />
      </mesh>
      <mesh ref={impact}>
        <sphereGeometry args={[1, 16, 12]} />
        <meshBasicMaterial color="#fff7ed" transparent opacity={0.6} depthWrite={false} />
      </mesh>

      {/* Players: capsule bodies, sphere heads, a paddle on a stick */}
      {[0, 1].map((i) => (
        <group key={i}>
          <group ref={(g) => (rigs.current[i] = g)}>
            <mesh position={[0, 0.62, 0]} castShadow>
              <capsuleGeometry args={[0.21, 0.72, 6, 14]} />
              <meshStandardMaterial
                color={i === lane(ownSeat) ? '#38bdf8' : '#f472b6'}
                roughness={0.55}
              />
            </mesh>
            <mesh position={[0, 1.34, 0]} castShadow>
              <sphereGeometry args={[0.15, 20, 16]} />
              <meshStandardMaterial color="#f8d9b5" roughness={0.7} />
            </mesh>
            <mesh position={[0, 0.18, 0]} castShadow>
              <capsuleGeometry args={[0.09, 0.36, 4, 10]} />
              <meshStandardMaterial color="#1f2937" roughness={0.7} />
            </mesh>
          </group>
          <group ref={(g) => (paddles.current[i] = g)}>
            {racket.shape === 'strung' ? (
              /*
               * A strung racket is a rim around a hole, and drawing it as a filled
               * disc like a paddle puts a black dinner plate over the player's
               * head. The torus already lies in the XY plane with its axis along
               * Z, which is the direction the face points, so it needs no
               * rotation — only a Y scale to make the oval.
               */
              <group scale={[1, racket.headOval, 1]}>
                <mesh castShadow>
                  <torusGeometry args={[racket.headRadius, racket.thickness, 8, 32]} />
                  <meshStandardMaterial
                    color={i === lane(ownSeat) ? '#cbd5e1' : '#f5d0e0'}
                    roughness={0.35}
                    metalness={0.5}
                  />
                </mesh>
                <mesh>
                  <circleGeometry args={[racket.headRadius, 32]} />
                  <meshStandardMaterial
                    color={i === lane(ownSeat) ? '#38bdf8' : '#f472b6'}
                    emissive={i === lane(ownSeat) ? '#0ea5e9' : '#db2777'}
                    emissiveIntensity={0.25}
                    roughness={0.8}
                    side={THREE.DoubleSide}
                    // Strings are mostly air.
                    transparent
                    opacity={0.18}
                  />
                </mesh>
              </group>
            ) : racket.shape === 'paddle' && paddleGeo ? (
              /*
               * A pickleball paddle: a flat slab, taller than it is wide, with a
               * black rubber bumper right round the rim. The bumper is not
               * decoration — it is the single feature that makes the silhouette
               * read as a pickleball paddle rather than as a large table tennis
               * bat, and it is on every paddle ever sold.
               *
               * Both geometries are already centred and already face local +Z,
               * so neither needs the rotation the disc below does.
               */
              <>
                <mesh castShadow geometry={paddleGeo.face}>
                  <meshStandardMaterial
                    color={i === lane(ownSeat) ? '#2563eb' : '#be185d'}
                    roughness={0.72}
                    metalness={0.04}
                  />
                </mesh>
                <mesh geometry={paddleGeo.guard}>
                  <meshStandardMaterial color="#14181f" roughness={0.85} />
                </mesh>
                {/* The throat: a paddle's face does not meet its grip at a point. */}
                <mesh
                  position={[0, -(racket.headRadius * racket.headOval + 0.018), 0]}
                  castShadow
                >
                  <boxGeometry args={[0.052, 0.04, racket.thickness * 1.4]} />
                  <meshStandardMaterial color="#14181f" roughness={0.8} />
                </mesh>
              </>
            ) : (
              <>
                {/*
                  * Local Y is the cylinder's axis, and the X rotation turns that
                  * into world Z so the face points forward.
                  */}
                <mesh castShadow rotation={[Math.PI / 2, 0, 0]}>
                  <cylinderGeometry
                    args={[racket.headRadius, racket.headRadius, racket.thickness, 24]}
                  />
                  <meshStandardMaterial
                    color={i === lane(ownSeat) ? '#1e293b' : '#3f1d2e'}
                    roughness={0.45}
                    metalness={0.1}
                  />
                </mesh>
                <mesh position={[0, 0, racket.thickness * 0.6]} rotation={[Math.PI / 2, 0, 0]}>
                  <cylinderGeometry
                    args={[racket.headRadius * 0.87, racket.headRadius * 0.87, 0.004, 24]}
                  />
                  <meshStandardMaterial
                    color={i === lane(ownSeat) ? '#38bdf8' : '#f472b6'}
                    emissive={i === lane(ownSeat) ? '#0ea5e9' : '#db2777'}
                    emissiveIntensity={0.35}
                    roughness={0.6}
                  />
                </mesh>
              </>
            )}
            <mesh
              position={[0, -(racket.headRadius * racket.headOval + racket.shaft / 2), 0]}
              castShadow
            >
              <cylinderGeometry args={[0.014, 0.02, racket.shaft, 10]} />
              <meshStandardMaterial color="#111827" roughness={0.8} />
            </mesh>
            {racket.shape === 'paddle' && (
              // The butt cap. A paddle grip flares at the end so it cannot slide
              // out of the hand, and the flare is visible from every angle the
              // camera ever takes.
              <mesh
                position={[0, -(racket.headRadius * racket.headOval + racket.shaft), 0]}
                castShadow
              >
                <cylinderGeometry args={[0.024, 0.021, 0.012, 12]} />
                <meshStandardMaterial color="#0b0f14" roughness={0.9} />
              </mesh>
            )}
          </group>
        </group>
      ))}
    </>
  );
}

const smooth = (x: number): number => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

/**
 * A tapering ribbon over the last 12 ball positions. Cheap, and it is what makes
 * speed legible at a glance — the single highest-value item on the feel list.
 */
function updateTrail(geo: THREE.BufferGeometry, points: Vec3[], court: CourtSpec): void {
  if (points.length < 3) return;
  const n = points.length;
  const positions = new Float32Array(n * 2 * 3);
  const colors = new Float32Array(n * 2 * 3);
  const width = Math.max(0.018, court.width * 0.006);

  for (let i = 0; i < n; i++) {
    const p = points[i];
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(n - 1, i + 1)];
    // Perpendicular in the horizontal plane, so the ribbon always faces up-ish.
    let dx = next[0] - prev[0];
    let dz = next[2] - prev[2];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const taper = (i / (n - 1)) ** 1.6;
    const w = width * (0.25 + taper * 2.4);
    const ox = -dz * w;
    const oz = dx * w;

    positions.set([p[0] + ox, p[1], p[2] + oz], i * 6);
    positions.set([p[0] - ox, p[1], p[2] - oz], i * 6 + 3);
    const a = taper;
    colors.set([1, 0.95, 0.45 * a + 0.2], i * 6);
    colors.set([1, 0.95, 0.45 * a + 0.2], i * 6 + 3);
  }

  const indices: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
}

/** The net's colour map: white, so the alpha map does all the shaping. */
let netWhite: THREE.Texture | null = null;
function makeNetMaterialTexture(alpha: THREE.Texture): THREE.Texture {
  if (netWhite) return netWhite;
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 2, 2);
  netWhite = new THREE.CanvasTexture(canvas);
  netWhite.wrapS = alpha.wrapS;
  netWhite.repeat.copy(alpha.repeat);
  return netWhite;
}
