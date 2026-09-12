/**
 * Court geometry and the painted-lines texture.
 *
 * Everything in the scene is a primitive. A court plane with lines drawn to a
 * canvas, a box net with an alpha-mapped mesh, capsules and spheres for players.
 * A restrained scene with good lighting reads as intentional; free asset packs
 * read as a scramble.
 */

import * as THREE from 'three';
import type { CourtSpec, SportId } from '@rally/protocol';
import { PALETTE } from '../theme.js';

export interface CourtLook {
  surface: string;
  surfaceEdge: string;
  /** The second painted field: the kitchen, or badminton's forecourt. */
  zone: string;
  /**
   * What type must be set in when it sits on `surround`.
   *
   * The apron floods the whole viewport behind the lobby, and it is not the same
   * colour for every sport — badminton's is green, where white type measures
   * 2.28:1 and is simply unreadable. Each sport therefore carries the ink its own
   * ground can hold.
   */
  groundInk: string;
  /**
   * What type must be set in when it sits on `surface` — the playing area
   * itself, which is green for pickleball and blue for the other two. The rack
   * stencils the sport's name across it, so this is a different question from
   * `groundInk` and has a different answer per sport.
   */
  surfaceInk: string;
  line: string;
  surround: string;
  accent: string;
}

/**
 * Ball radius per sport, mirrored from the sport modules for the same reason the
 * court dimensions are: the display may only import `@rally/protocol`.
 */
export const BALL_RADIUS: Record<SportId, number> = {
  pickleball: 0.037,
  // A real 40 mm ball. Table tennis is drawn by `PingPongScene`, which carries
  // its own copy of this — the entry stays so anything reading the record by
  // sport gets a true number rather than the old scaled-up court's.
  tabletennis: 0.02,
  badminton: 0.034,
  bowling: 0.108,
};

/**
 * What the player is holding, per sport. Swing style made visible.
 *
 * A badminton racket is the giveaway silhouette: a light oval head on a long
 * shaft, held at arm's length and met above the head. A pickleball paddle is
 * short, thick and solid, and swung from the waist. Rendering both as the same
 * disc on a stub would throw away the most legible difference between the two
 * sports on screen.
 */
/**
 * How the head is built.
 *
 * Not a style flag — these are three different objects. A strung frame is a rim
 * around a hole; a paddle is a flat slab with a rubber bumper right round its
 * edge; a bat is a disc. Drawing any of them as another throws away the most
 * legible difference between the sports on screen.
 */
export type RacketShape = 'paddle' | 'bat' | 'strung';

export interface RacketLook {
  /** Half the head's WIDTH, metres. Also the radius, for a round head. */
  headRadius: number;
  /** Height as a multiple of the width. 1 is round; above 1 is taller than wide. */
  headOval: number;
  /** Frame thickness, metres. */
  thickness: number;
  /** Shaft and handle length, metres. */
  shaft: number;
  /** Shoulder to racket centre. A badminton racket reaches a long way. */
  armLen: number;
  /**
   * Height the hand carries the racket at, metres.
   *
   * Swing style again, and it is not cosmetic: a shuttle is met above the head,
   * a pickleball somewhere between the waist and the chest. Held at one height
   * for every sport, a pickleball paddle sits exactly where the player's own
   * head is drawn and disappears behind it from the broadcast camera.
   */
  holdHeight: number;
  /**
   * How far to the player's side the hand carries it, metres.
   *
   * Without this the racket is drawn on the body's own centre line and spends
   * the match inside the capsule that represents the player — visible only when
   * the swing animation happens to throw it clear. A hand is not in the middle
   * of a chest.
   *
   * Mirrored per seat so both ends look the same from their own camera, and
   * deliberately not tied to handedness: which hand somebody holds it in is not
   * something the simulation knows.
   */
  holdSide: number;
  shape: RacketShape;
  /** Corner radius of a paddle face, metres. Ignored by the other shapes. */
  cornerRadius?: number;
  /** Width of a paddle's edge guard, metres. Ignored by the other shapes. */
  guard?: number;
}

export const RACKETS: Record<SportId, RacketLook> = {
  /*
   * A regulation pickleball paddle, near enough. The rules cap length plus width
   * at 24 inches and length at 17, and almost everything on the market lands at
   * about 15.75 x 7.9 — so a 0.20 m wide, 0.27 m tall face over a 0.13 m handle
   * is the real object rather than an approximation of one.
   *
   * The proportions are the whole point. It is noticeably TALLER than it is
   * wide, which a disc cannot express, and it is the shape people recognise
   * before they read anything else on screen.
   */
  pickleball: {
    headRadius: 0.1,
    headOval: 1.35,
    thickness: 0.014,
    shaft: 0.13,
    armLen: 0.62,
    // Chest height. Pickleball is played low — the kitchen rule is about keeping
    // players off the net, and the dink that results is struck from the waist.
    holdHeight: 0.95,
    holdSide: 0.34,
    shape: 'paddle',
    cornerRadius: 0.045,
    guard: 0.007,
  },
  // Table tennis has its own renderer entirely — see `PingPongScene`. This entry
  // exists so the record is total, and is what a fallback would draw.
  tabletennis: { headRadius: 0.077, headOval: 1, thickness: 0.02, shaft: 0.11, armLen: 0.55, holdHeight: 1.0, holdSide: 0.3, shape: 'bat' },
  // Carried high, because that is where the shuttle is met.
  badminton: { headRadius: 0.13, headOval: 1.14, thickness: 0.011, shaft: 0.34, armLen: 0.95, holdHeight: 1.2, holdSide: 0.3, shape: 'strung' },
  bowling: { headRadius: 0.115, headOval: 1, thickness: 0.022, shaft: 0.13, armLen: 0.62, holdHeight: 0.8, holdSide: 0.3, shape: 'bat' },
};

/**
 * A pickleball paddle's face and its edge guard, as geometry.
 *
 * Built rather than composed from primitives because the shape IS the
 * recognition: a rounded rectangle with a bumper round the rim, not a circle.
 * Two pieces so they can take different materials — the face is the player's
 * colour, the guard is the black rubber every paddle has.
 *
 * Both are centred on the origin and face down local +Z, which is the frame
 * every other racket in this file uses.
 */
export function makePaddleGeometry(look: RacketLook): {
  face: THREE.ExtrudeGeometry;
  guard: THREE.ExtrudeGeometry;
  dispose: () => void;
} {
  const w = look.headRadius * 2;
  const h = w * look.headOval;
  const r = look.cornerRadius ?? 0.04;
  const g = look.guard ?? 0.006;

  const face = new THREE.ExtrudeGeometry(roundedRect(w, h, r), {
    depth: look.thickness,
    bevelEnabled: true,
    bevelThickness: 0.0015,
    bevelSize: 0.0015,
    bevelSegments: 2,
    curveSegments: 10,
  });
  face.translate(0, 0, -look.thickness / 2);

  // The guard is a ring: the outer outline with the face punched out of it. It
  // stands a little proud of the face on both sides, which is exactly what the
  // real thing does and what makes the edge read at a distance.
  const outer = roundedRect(w + g * 2, h + g * 2, r + g);
  outer.holes.push(roundedRect(w, h, r));
  const depth = look.thickness * 1.5;
  const guard = new THREE.ExtrudeGeometry(outer, {
    depth,
    bevelEnabled: false,
    curveSegments: 10,
  });
  guard.translate(0, 0, -depth / 2);

  return {
    face,
    guard,
    dispose: () => {
      face.dispose();
      guard.dispose();
    },
  };
}

/**
 * A rounded rectangle, centred on the origin.
 *
 * Wound counter-clockwise. `ExtrudeGeometry` uses the winding to decide which
 * way the faces point, and a hole punched with the same winding as its outline
 * is not a hole.
 */
function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const x = -w / 2;
  const y = -h / 2;
  const rad = Math.min(r, w / 2, h / 2);
  const s = new THREE.Shape();
  s.moveTo(x + rad, y);
  s.lineTo(x + w - rad, y);
  s.quadraticCurveTo(x + w, y, x + w, y + rad);
  s.lineTo(x + w, y + h - rad);
  s.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  s.lineTo(x + rad, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - rad);
  s.lineTo(x, y + rad);
  s.quadraticCurveTo(x, y, x + rad, y);
  return s;
}

/**
 * The paint.
 *
 * A real outdoor court is acrylic over asphalt in two flat fields: a saturated
 * in-bounds colour inside a contrasting apron, with the non-volley zone painted
 * differently again. No gradients, because paint does not have any — the whole
 * look reads as court only while the fields stay flat.
 *
 * Every entry is a getter rather than a value. Module bodies run before
 * `syncTheme()` reconciles the palette against the stylesheet, so a captured
 * copy here would be the one thing in the app that could still drift from CSS.
 */
export const LOOKS: Record<SportId, CourtLook> = {
  pickleball: {
    get surface() { return PALETTE.court; },
    get surfaceEdge() { return PALETTE.apron; },
    get zone() { return PALETTE.kitchen; },
    get line() { return PALETTE.line; },
    get surround() { return PALETTE.apron; },
    get accent() { return PALETTE.optic; },
    get groundInk() { return PALETTE.line; },
    get surfaceInk() { return PALETTE.ink; },
  },
  // Table tennis is not drawn from a `CourtLook` — `PingPongScene` builds real
  // geometry instead. These are the lobby's colours for it, and the accent the
  // HUD and the timing ring pick up.
  tabletennis: {
    get surface() { return PALETTE.apron; },
    get surfaceEdge() { return PALETTE.apronDeep; },
    get zone() { return PALETTE.apronDeep; },
    get line() { return PALETTE.line; },
    get surround() { return PALETTE.apronDeep; },
    get accent() { return PALETTE.optic; },
    get groundInk() { return PALETTE.line; },
    get surfaceInk() { return PALETTE.line; },
  },
  // One ground for every sport: the tartan's blue field runs behind all of them,
  // so the world does not change colour when the carousel re-stripes. Badminton
  // stays distinguishable from pickleball the way a real hall does — a lighter
  // in-bounds green inside the same surround, with its own forecourt band —
  // rather than by swapping the whole room to green for one sport.
  badminton: {
    get surface() { return PALETTE.courtAlt; },
    get surfaceEdge() { return PALETTE.apron; },
    get zone() { return PALETTE.kitchen; },
    get line() { return PALETTE.line; },
    get surround() { return PALETTE.apron; },
    get accent() { return PALETTE.optic; },
    // The ground is blue now, so the ink that sits on it is the one blue can
    // hold. See The Ground Decides The Ink Rule.
    get groundInk() { return PALETTE.line; },
    get surfaceInk() { return PALETTE.ink; },
  },
  bowling: {
    get surface() { return PALETTE.courtAlt; },
    get surfaceEdge() { return PALETTE.apron; },
    get zone() { return PALETTE.kitchen; },
    get line() { return PALETTE.line; },
    get surround() { return PALETTE.apron; },
    get accent() { return PALETTE.optic; },
    get groundInk() { return PALETTE.line; },
    get surfaceInk() { return PALETTE.ink; },
  },
};

/**
 * Paint the court lines into a canvas texture. One texture, drawn once per sport,
 * beats a pile of thin boxes: no z-fighting, no geometry, and the line weights
 * can be tuned like a drawing rather than like a mesh.
 */
export function makeCourtTexture(court: CourtSpec, look: CourtLook, sport: SportId): THREE.Texture {
  const pxPerM = 96;
  const w = Math.round(court.width * pxPerM);
  const h = Math.round(court.length * pxPerM);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;

  // Flat, because paint is flat. A gradient here is the single thing that would
  // stop this reading as a painted court and start it reading as a lit panel.
  g.fillStyle = look.surface;
  g.fillRect(0, 0, w, h);

  // The second painted field, laid down before the lines so the tape sits on top
  // of it exactly as it does on a real court.
  if (court.nonVolleyZone > 0) {
    const zone = court.nonVolleyZone * pxPerM;
    g.fillStyle = look.zone;
    g.fillRect(0, h / 2 - zone, w, zone * 2);
  }

  // Acrylic over asphalt has a tooth to it. Kept well under the line contrast so
  // the surface reads as a material rather than as noise.
  g.globalAlpha = 0.035;
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = i % 2 ? '#ffffff' : '#000000';
    g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
  g.globalAlpha = 1;

  const lw = Math.max(3, Math.round(0.05 * pxPerM));
  g.strokeStyle = look.line;
  g.lineWidth = lw;

  // Outer boundary.
  g.strokeRect(lw / 2, lw / 2, w - lw, h - lw);

  // Centre line (the net plane).
  g.beginPath();
  g.moveTo(0, h / 2);
  g.lineTo(w, h / 2);
  g.stroke();

  if (sport === 'pickleball' && court.nonVolleyZone > 0) {
    // Kitchen lines.
    const kz = court.nonVolleyZone * pxPerM;
    for (const y of [h / 2 - kz, h / 2 + kz]) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    // Service centre lines, baseline to kitchen.
    g.beginPath();
    g.moveTo(w / 2, 0);
    g.lineTo(w / 2, h / 2 - kz);
    g.moveTo(w / 2, h);
    g.lineTo(w / 2, h / 2 + kz);
    g.stroke();
  } else if (sport === 'badminton') {
    // Short service lines, the centre line splitting each service court, and the
    // doubles long service line just inside the back boundary. Between them
    // these are what make a badminton court unmistakable at a glance.
    const shortLine = court.nonVolleyZone * pxPerM;
    for (const y of [h / 2 - shortLine, h / 2 + shortLine]) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    // Doubles long service line, 0.76 m in from each back boundary.
    const longLine = 0.76 * pxPerM;
    g.lineWidth = Math.max(2, lw * 0.7);
    for (const y of [longLine, h - longLine]) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    // Centre line, from each short service line to the back.
    g.lineWidth = lw;
    g.beginPath();
    g.moveTo(w / 2, 0);
    g.lineTo(w / 2, h / 2 - shortLine);
    g.moveTo(w / 2, h);
    g.lineTo(w / 2, h / 2 + shortLine);
    g.stroke();
  } else if (sport === 'tabletennis') {
    // A single centre line down the length, as a table has.
    g.lineWidth = Math.max(2, lw * 0.6);
    g.beginPath();
    g.moveTo(w / 2, 0);
    g.lineTo(w / 2, h);
    g.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** An alpha map that makes the net read as a mesh rather than a solid slab. */
export function makeNetTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  g.strokeStyle = '#fff';
  g.lineWidth = 2.4;
  const step = size / 14;
  g.beginPath();
  for (let i = 0; i <= 14; i++) {
    g.moveTo(i * step, 0);
    g.lineTo(i * step, size);
    g.moveTo(0, i * step);
    g.lineTo(size, i * step);
  }
  g.stroke();
  // The tape along the top is solid.
  g.fillStyle = '#fff';
  g.fillRect(0, 0, size, size * 0.085);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.set(10, 1);
  return texture;
}

/**
 * The broadcast camera: fixed, slightly above and behind your own baseline.
 *
 * It does not move during rallies. Camera motion is reserved entirely for the
 * point-winning replay, so that motion *means* something when it happens.
 */
export function cameraFor(
  court: CourtSpec,
  seat: number,
  aspect = 16 / 9,
): {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
} {
  const sign = seat === 0 ? -1 : 1;
  const half = court.length / 2;

  // A 35 degree vertical field of view frames the court on a widescreen laptop.
  // On a narrower window the court runs off the sides, so pull back rather than
  // widening the lens — widening it distorts the depth cue the ball shadow
  // depends on.
  const pullback = Math.max(1, Math.sqrt(1.55 / Math.max(0.6, aspect)));

  // Framed from the deepest a player can stand, not from the lines. Behind a
  // table that is well past the edge, and framing on the lines alone crops your
  // own player off the bottom of the screen — which is the half of the court you
  // least want to lose, because it is the one you are playing from.
  const nearExtent = half + court.standBehind + 0.8;
  const back = (nearExtent * 1.95 + 4.2) * pullback;
  const height = court.tableHeight + nearExtent * 0.52 + 2.6 + (pullback - 1) * 1.5;

  return {
    position: [0, height, sign * back],
    // Aimed a little past the net so the far court, where the ball is coming
    // from, sits in the middle of the frame rather than the near baseline.
    target: [0, court.tableHeight + 0.8, sign * -half * 0.15],
    fov: 35,
  };
}
