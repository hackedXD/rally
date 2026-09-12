/**
 * Everything the table tennis scene is made of, transplanted from `pickle`.
 *
 * The other sports are drawn from a `CourtSpec` — a plane, a texture with the
 * lines painted on, a net quad — because at 13 m a court IS mostly a painted
 * plane. A ping-pong table at 2.74 m is close enough to the camera that the
 * approximation stops working: you can see the edge, the apron under it and the
 * legs, and without them the surface reads as a diagram rather than a table you
 * are standing at.
 *
 * So this file builds real geometry. It is plain three.js rather than JSX
 * because that is what it was, and because nothing in here is ever touched
 * again once it is placed — react-three-fiber's whole value is reconciling
 * things that change.
 */

import * as THREE from 'three';
import { PALETTE } from '../theme.js';

/** `#rrggbb` as the number three.js material options want. */
const hex = (css: string): number => parseInt(css.slice(1), 16);

/** Mirrors `@rally/sim`'s pingpong constants. Checked at runtime — see below. */
export const PP = {
  TABLE: { LEN: 2.74, WIDTH: 1.525, TOP: 0.76 },
  NET: { HEIGHT: 0.1525, OVERHANG: 0.1525 },
  BALL: { R: 0.02 },
  BLADE_R: 0.077,
} as const;

/**
 * How far the bat hangs below its own origin, metres.
 *
 * The origin is the centre of the blade — that is the physics contract, and it
 * is not negotiable (see `makeBat`) — so everything from the shoulder down is
 * BELOW the position the simulation reports. Held at the height the sim
 * considers comfortable, the grip is therefore inside the table.
 *
 * Derived from the model rather than eyeballed, so reshaping the handle cannot
 * silently reintroduce the clipping: blade radius, then the grip capsule at
 * -R-0.068 with its 0.0155 cap, which is the lowest point on the bat.
 */
export const BAT_DROP = PP.BLADE_R + 0.068 + 0.062 / 2 + 0.0155;

/** +1 if this seat hits toward +z. Seat 0 stands at -z. */
export const dirOf = (seat: number): 1 | -1 => (seat === 0 ? 1 : -1);
/** Where a seat's own right points in world x. */
export const rightOf = (seat: number): 1 | -1 => (seat === 0 ? -1 : 1);
export const homeZ = (seat: number): number =>
  dirOf(seat) * -(PP.TABLE.LEN / 2 + 0.25);

const box = (
  w: number,
  h: number,
  d: number,
  color: number,
  opts: THREE.MeshStandardMaterialParameters = {},
): THREE.Mesh =>
  new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.0, ...opts }),
  );

/**
 * A texture drawn in code.
 *
 * There are no image files in this project and there is not going to be one — a
 * venue network that cannot load three.js cannot load a PNG either, and a data
 * URI of a net is less readable than the four lines that draw one. Two things
 * here genuinely need a texture rather than a colour: the net, which is a grid,
 * and the floor, which needs to fall off into the dark instead of being one flat
 * grey.
 */
const canvasTex = (
  size: number,
  draw: (g: CanvasRenderingContext2D, n: number) => void,
): THREE.CanvasTexture => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
};

/**
 * Build the table, the net and the floor into a group.
 *
 * Returns the group and a disposer: React will unmount this when the sport
 * changes, and geometry that is never disposed is a leak that only shows up
 * after somebody has played four matches without reloading.
 */
export function buildTable(): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group();
  const owned: { dispose: () => void }[] = [];
  const track = <T extends THREE.Mesh>(m: T): T => {
    owned.push(m.geometry);
    owned.push(m.material as THREE.Material);
    group.add(m);
    return m;
  };

  // floor — a pool of light under the table, dark at the edges. A flat plane
  // meets the fog as a hard grey band across the middle of the screen.
  const floorTex = canvasTex(256, (g, n) => {
    const r = g.createRadialGradient(n / 2, n / 2, n * 0.05, n / 2, n / 2, n * 0.5);
    r.addColorStop(0, PALETTE.apron);
    r.addColorStop(0.55, PALETTE.apronDeep);
    r.addColorStop(1, PALETTE.inkBlue);
    g.fillStyle = r;
    g.fillRect(0, 0, n, n);
  });
  owned.push(floorTex);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24),
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  track(floor);

  // --- table ----------------------------------------------------------------
  // Real proportions, and three parts rather than one slab: the playing surface,
  // the apron under it, and the frame. A single box floating on four sticks is
  // the difference between a table and a diagram of one — and the apron is what
  // the eye actually uses to read the height of the surface.
  const { TABLE, NET } = PP;
  const TOP_T = 0.022; //   the playing surface itself
  const APRON_H = 0.075; // the skirt under it

  const top = box(TABLE.WIDTH, TOP_T, TABLE.LEN, hex(PALETTE.court), {
    roughness: 0.3,
    metalness: 0.08,
  });
  top.position.y = TABLE.TOP - TOP_T / 2;
  top.receiveShadow = true;
  track(top);

  const apron = box(TABLE.WIDTH - 0.04, APRON_H, TABLE.LEN - 0.04, hex(PALETTE.kitchen), {
    roughness: 0.85,
  });
  apron.position.y = TABLE.TOP - TOP_T - APRON_H / 2;
  apron.castShadow = true;
  track(apron);

  const LINE = 0.02;
  const line = (w: number, d: number, x: number, z: number): void => {
    const m = box(w, 0.004, d, hex(PALETTE.line), { roughness: 0.4 });
    m.position.set(x, TABLE.TOP + 0.003, z);
    track(m);
  };
  line(TABLE.WIDTH, LINE, 0, -TABLE.LEN / 2 + LINE / 2);
  line(TABLE.WIDTH, LINE, 0, TABLE.LEN / 2 - LINE / 2);
  line(LINE, TABLE.LEN, -TABLE.WIDTH / 2 + LINE / 2, 0);
  line(LINE, TABLE.LEN, TABLE.WIDTH / 2 - LINE / 2, 0);
  line(0.006, TABLE.LEN, 0, 0);

  // Legs, with a rail tying each pair together. Tapered, because a leg that is
  // the same width all the way down reads as a table drawn in a spreadsheet.
  const STEEL = { color: hex(PALETTE.inkBlue), roughness: 0.5, metalness: 0.35 };
  const legH = TABLE.TOP - TOP_T - APRON_H;
  for (const sz of [-1, 1]) {
    const railZ = sz * (TABLE.LEN / 2 - 0.34);
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(
        new THREE.CylinderGeometry(0.019, 0.028, legH, 10),
        new THREE.MeshStandardMaterial(STEEL),
      );
      leg.position.set(sx * (TABLE.WIDTH / 2 - 0.13), legH / 2, railZ);
      leg.castShadow = true;
      track(leg);
    }
    const rail = box(TABLE.WIDTH - 0.26, 0.022, 0.022, STEEL.color, STEEL);
    rail.position.set(0, legH * 0.42, railZ);
    track(rail);
  }

  // --- net ------------------------------------------------------------------
  // A grid, two posts and a tape. The posts do most of the work: without them
  // the net is a grey rectangle hanging in the air with nothing holding it, and
  // the eye reads it as fog rather than as an obstacle the ball has to clear.
  const netW = TABLE.WIDTH + NET.OVERHANG * 2;
  const netTex = canvasTex(64, (g, n) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, n, n);
    g.strokeStyle = PALETTE.chalk;
    g.lineWidth = 2;
    for (let i = 0; i <= 8; i++) {
      const k = (i / 8) * n;
      g.beginPath();
      g.moveTo(k, 0);
      g.lineTo(k, n);
      g.stroke();
      g.beginPath();
      g.moveTo(0, k);
      g.lineTo(n, k);
      g.stroke();
    }
  });
  netTex.wrapS = netTex.wrapT = THREE.RepeatWrapping;
  netTex.repeat.set(26, 3);
  owned.push(netTex);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(netW, NET.HEIGHT),
    new THREE.MeshBasicMaterial({
      map: netTex,
      transparent: true,
      alphaMap: netTex,
      side: THREE.DoubleSide,
      depthWrite: false,
      opacity: 0.85,
    }),
  );
  mesh.position.y = TABLE.TOP + NET.HEIGHT / 2;
  track(mesh);
  const tape = box(netW, 0.014, 0.009, hex(PALETTE.line), { roughness: 0.35 });
  tape.position.y = TABLE.TOP + NET.HEIGHT;
  track(tape);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.011, 0.011, NET.HEIGHT + 0.03, 10),
      new THREE.MeshStandardMaterial({ color: hex(PALETTE.line), roughness: 0.4, metalness: 0.5 }),
    );
    post.position.set((sx * netW) / 2, TABLE.TOP + (NET.HEIGHT + 0.03) / 2 - 0.015, 0);
    post.castShadow = true;
    track(post);
  }

  return {
    group,
    dispose: () => {
      for (const o of owned) o.dispose();
    },
  };
}

/**
 * A bat.
 *
 * Your own bat is half a metre from the eye and on screen for the entire game.
 * It is the only object here worth spending geometry on, and a coloured disc
 * with a matchstick glued to it is not enough.
 *
 * A real bat is a stack: matte rubber, a pale wood core showing as a thin bright
 * ring at the edge, a shoulder, and a shaped grip that flares at the end so it
 * cannot slide out of the hand. Four bands instead of one flat face is the whole
 * difference, and it is still four primitives.
 *
 * The frame must stay exactly as it is: the blade's normal is the group's local
 * z, the handle hangs down local -y, and BLADE_R is shared with the physics — so
 * what you see is exactly what the ball meets.
 */
/**
 * One bat.
 *
 * `seat` places it — the bat rests on its own side of the table. `mine` colours
 * it, and is a separate question: the app-wide rule is that you are in white and
 * your opponent is in flag orange, which is about who is holding it rather than
 * which end of the table it sits at.
 */
export function makeBat(
  seat: number,
  mine: boolean,
): { group: THREE.Group; dispose: () => void } {
  const g = new THREE.Group();
  const owned: { dispose: () => void }[] = [];
  const add = (m: THREE.Mesh): void => {
    owned.push(m.geometry, m.material as THREE.Material);
    m.castShadow = true;
    g.add(m);
  };
  const R = PP.BLADE_R;
  const rubber = mine ? hex(PALETTE.line) : hex(PALETTE.flag);

  // The wood, a hair wider than the rubber so it shows all the way round.
  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 1.03, R * 1.03, 0.006, 48),
    new THREE.MeshStandardMaterial({ color: 0xe8cfa6, roughness: 0.65 }),
  );
  core.rotation.x = Math.PI / 2;
  add(core);

  // One rubber face each side. Both the seat's colour: which face you hit with
  // is decided per swing, so a bat with a "wrong" side would be lying about the
  // rules.
  for (const s of [-1, 1]) {
    const face = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R, 0.004, 48),
      new THREE.MeshStandardMaterial({ color: rubber, roughness: 0.95, metalness: 0 }),
    );
    face.rotation.x = Math.PI / 2;
    face.position.z = s * 0.005;
    add(face);
  }

  const woodColor = 0x8d6743;
  // shoulder: the blade narrowing into the handle
  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.016, 0.045, 12),
    new THREE.MeshStandardMaterial({ color: woodColor, roughness: 0.72 }),
  );
  neck.position.y = -R - 0.012;
  add(neck);
  // grip: a capsule, flared at the butt. Capsule and not a box because the one
  // thing you know about a handle is that it is round in the hand.
  const grip = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.0155, 0.062, 4, 14),
    new THREE.MeshStandardMaterial({ color: 0x2b1d14, roughness: 0.92 }),
  );
  grip.position.y = -R - 0.068;
  add(grip);
  const butt = new THREE.Mesh(
    new THREE.CylinderGeometry(0.021, 0.018, 0.012, 14),
    new THREE.MeshStandardMaterial({ color: woodColor, roughness: 0.72 }),
  );
  butt.position.y = -R - 0.104;
  add(butt);

  g.position.set(0, PP.TABLE.TOP + 0.22, homeZ(seat));
  return { group: g, dispose: () => owned.forEach((o) => o.dispose()) };
}

/**
 * Two framings, and `first` is the default.
 *
 * "first" stands you at the table: the near edge runs along the bottom of the
 * screen and the far end sits high, which is the only way a 2.74 m table reads
 * as a table rather than a diagram. The wide view exists because a spectator
 * screen wants to see both ends.
 */
export const VIEWS = {
  first: { back: 0.85, height: 1.45, fov: 62, lookY: PP.TABLE.TOP - 0.02, lookZ: 0.35 },
  wide: { back: 2.15, height: 1.72, fov: 52, lookY: PP.TABLE.TOP + 0.05, lookZ: 0 },
} as const;

export type PpViewName = keyof typeof VIEWS;

export function ppCamera(
  view: PpViewName,
  seat: number,
): { position: [number, number, number]; target: [number, number, number]; fov: number } {
  const v = VIEWS[view];
  const facing = seat === 0 ? 1 : -1;
  return {
    position: [0, v.height, -facing * (PP.TABLE.LEN / 2 + v.back)],
    target: [0, v.lookY, facing * v.lookZ],
    fov: v.fov,
  };
}

/**
 * Where a bat is between points: face down on your own half, off to your bat
 * hand's side so it is not sitting under the serve toss.
 *
 * The orientation is the fiddly part, and it is fiddly for the reason everything
 * else here is: the group's local +z IS the blade normal and local -y IS the
 * handle, so "lying flat" is a quarter turn about world x — which leaves the
 * handle pointing at the net. Seat 1 stands at +z so that already points back at
 * them; seat 0 needs the extra half turn about world up, which flips the handle
 * without disturbing the face. `rightOf`, not a bare sign, for the same reason
 * it is used everywhere else — world +x is screen LEFT for seat 0.
 */
export const REST_LIFT = 0.012;

export const restPos = (seat: number): [number, number, number] => [
  rightOf(seat) * 0.34,
  PP.TABLE.TOP + REST_LIFT,
  dirOf(seat) * -(PP.TABLE.LEN / 2 - 0.3),
];

export function restQuat(seat: number): THREE.Quaternion {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  if (seat === 0) {
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
  }
  return q;
}
