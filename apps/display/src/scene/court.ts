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

export interface CourtLook {
  surface: string;
  surfaceEdge: string;
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
  tabletennis: 0.05,
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
export interface RacketLook {
  /** Head radius, metres. */
  headRadius: number;
  /** Vertical stretch of the head. 1 is a round paddle; above 1 is an oval. */
  headOval: number;
  /** Frame thickness, metres. */
  thickness: number;
  /** Shaft and handle length, metres. */
  shaft: number;
  /** Shoulder to racket centre. A badminton racket reaches a long way. */
  armLen: number;
  /** A strung frame reads as an open face; a paddle reads as a solid one. */
  strung: boolean;
}

export const RACKETS: Record<SportId, RacketLook> = {
  pickleball: { headRadius: 0.115, headOval: 1, thickness: 0.022, shaft: 0.13, armLen: 0.62, strung: false },
  tabletennis: { headRadius: 0.115, headOval: 1, thickness: 0.022, shaft: 0.13, armLen: 0.62, strung: false },
  badminton: { headRadius: 0.13, headOval: 1.14, thickness: 0.011, shaft: 0.34, armLen: 0.95, strung: true },
  bowling: { headRadius: 0.115, headOval: 1, thickness: 0.022, shaft: 0.13, armLen: 0.62, strung: false },
};

export const LOOKS: Record<SportId, CourtLook> = {
  pickleball: {
    surface: '#1d4f6b',
    surfaceEdge: '#17425a',
    line: '#f4f8ff',
    surround: '#123040',
    accent: '#4ade80',
  },
  tabletennis: {
    surface: '#15527d',
    surfaceEdge: '#0e3d61',
    line: '#ffffff',
    // Light enough that the far half of the table does not disappear into it.
    surround: '#111f33',
    accent: '#38bdf8',
  },
  badminton: {
    // Tournament mats are green or blue; green keeps it instantly distinct from
    // the two blue courts.
    surface: '#1f6b4a',
    surfaceEdge: '#17553b',
    line: '#f6fff8',
    surround: '#0f2a20',
    accent: '#fbbf24',
  },
  bowling: {
    surface: '#8a5a2b',
    surfaceEdge: '#6d4720',
    line: '#f1e0c6',
    surround: '#1a1410',
    accent: '#fbbf24',
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

  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, look.surfaceEdge);
  grad.addColorStop(0.5, look.surface);
  grad.addColorStop(1, look.surfaceEdge);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  // Subtle texture so a flat plane does not read as flat.
  g.globalAlpha = 0.05;
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
