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
  bowling: 0.108,
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
    surface: '#0f3f63',
    surfaceEdge: '#0b3353',
    line: '#ffffff',
    surround: '#0a1422',
    accent: '#38bdf8',
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
  return {
    position: [
      0,
      (court.tableHeight + 3.9 + half * 0.14) * (0.85 + pullback * 0.18),
      sign * (half + 6.1) * pullback,
    ],
    target: [0, court.tableHeight + 0.85, sign * -half * 0.1],
    fov: 35,
  };
}
