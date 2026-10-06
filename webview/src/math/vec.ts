// Pure 3D vector math for the direction picker (trackball). No DOM.
// World space: X right, Y up, Z towards the viewer at yaw = pitch = 0.
// View space: the same axes after the view rotation; screen x = view x,
// screen y (up) = view y, view z > 0 is the front hemisphere.

export type V3 = [number, number, number];

export const DEG = Math.PI / 180;

export const len = (v: V3): number => Math.hypot(v[0], v[1], v[2]);
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const scale = (v: V3, s: number): V3 => [v[0] * s, v[1] * s, v[2] * s];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Unit vector; the zero vector maps to `fallback` (default +Z). */
export function normalize(v: V3, fallback: V3 = [0, 0, 1]): V3 {
  const l = len(v);
  return l > 1e-12 ? scale(v, 1 / l) : [fallback[0], fallback[1], fallback[2]];
}

export function rotX(v: V3, a: number): V3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}

export function rotY(v: V3, a: number): V3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

export interface View {
  /** Radians, rotation around world Y. */
  yaw: number;
  /** Radians, rotation around view X (positive looks from above). */
  pitch: number;
}

export const DEFAULT_VIEW: View = { yaw: -25 * DEG, pitch: 20 * DEG };

/** World -> view space. */
export const toView = (v: V3, view: View): V3 => rotX(rotY(v, view.yaw), view.pitch);
/** View -> world space. */
export const fromView = (v: V3, view: View): V3 => rotY(rotX(v, -view.pitch), -view.yaw);

/**
 * Maps a pointer position in unit-disc coordinates (x right, y up, radius 1 =
 * silhouette) to a unit view-space direction. Inside the disc the point lies
 * on the start hemisphere; between radius 1 and 2 it wraps continuously over
 * the silhouette onto the other hemisphere (so the back can be reached by
 * dragging outwards); beyond 2 it stays at the opposite pole.
 */
export function discToSphere(x: number, y: number, front: boolean): V3 {
  const r = Math.hypot(x, y);
  const sign = front ? 1 : -1;
  if (r < 1e-9) return [0, 0, sign];
  if (r <= 1) return [x, y, sign * Math.sqrt(Math.max(0, 1 - r * r))];
  const p = Math.max(0, 2 - r);
  return [(x / r) * p, (y / r) * p, -sign * Math.sqrt(Math.max(0, 1 - p * p))];
}

/** Rodrigues rotation of `v` around `axis` by `angle` radians. */
export function rotateAround(v: V3, axis: V3, angle: number): V3 {
  const k = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

/** Azimuth (around Y, from +Z towards +X) and elevation (towards +Y), radians. */
export function toAngles(v: V3): { az: number; el: number } {
  const u = normalize(v);
  return { az: Math.atan2(u[0], u[2]), el: Math.asin(Math.max(-1, Math.min(1, u[1]))) };
}

export function fromAngles(az: number, el: number): V3 {
  const c = Math.cos(el);
  return [Math.sin(az) * c, Math.sin(el), Math.cos(az) * c];
}

const tidy = (v: V3): V3 => v.map((x) => (Math.abs(x) < 1e-12 ? 0 : x)) as V3;

/** Snaps azimuth and elevation to multiples of `stepDeg`. Returns a unit vector. */
export function snapAngles(v: V3, stepDeg: number): V3 {
  const { az, el } = toAngles(v);
  const st = stepDeg * DEG;
  const r = (x: number) => Math.round(x / st) * st;
  return tidy(fromAngles(r(az), r(el)));
}

/** The 26 axis / 45-degree diagonal directions (components in {-1, 0, 1}), normalized. */
export const SNAP_DIRECTIONS: V3[] = (() => {
  const out: V3[] = [];
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) if (x || y || z) out.push(normalize([x, y, z]));
  return out;
})();

/** Nearest axis or 45-degree diagonal direction (unit). */
export function snapDiagonal(v: V3): V3 {
  const u = normalize(v);
  let best = SNAP_DIRECTIONS[0];
  let bd = -Infinity;
  for (const d of SNAP_DIRECTIONS) {
    const s = dot(u, d);
    if (s > bd + 1e-12) {
      bd = s;
      best = d;
    }
  }
  return [best[0], best[1], best[2]];
}
