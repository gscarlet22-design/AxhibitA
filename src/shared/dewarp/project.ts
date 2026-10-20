/**
 * TypeScript mirror of the GLSL dewarp shader (src/renderer/src/gl/shaders.ts).
 * Conventions (docs/DEWARP.md):
 *  - Source pixels: origin top-left, +x right, +y down.
 *  - Camera frame: +Z optical axis, +X image right, +Y image down (right-handed).
 *  - World frame for views: +Z forward (horizon), +Y down, +X right.
 * Any change here MUST be mirrored in the shader; tests compare both.
 */
import type { Calibration, LensModel, Mount, PtzState } from '../types'

export type Vec3 = [number, number, number]
export type Mat3 = [number, number, number, number, number, number, number, number, number] // row-major

export const DEG = Math.PI / 180

/** Rotation taking world rays to camera rays, row-major. */
export function mountMatrix(mount: Mount): Mat3 {
  switch (mount) {
    case 'wall':
      return [1, 0, 0, 0, 1, 0, 0, 0, 1]
    case 'ceiling':
      // cam.x = w.x ; cam.y = -w.z ; cam.z = w.y   (optical axis = world down)
      return [1, 0, 0, 0, 0, -1, 0, 1, 0]
    case 'desk':
      // cam.x = w.x ; cam.y = w.z ; cam.z = -w.y   (optical axis = world up)
      return [1, 0, 0, 0, 0, 1, 0, -1, 0]
  }
}

export function mulMat3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
  ]
}

export function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** Pitch about +X: positive tilt looks down (+Y). */
export function rotPitch(v: Vec3, t: number): Vec3 {
  const c = Math.cos(t)
  const s = Math.sin(t)
  return [v[0], v[1] * c + v[2] * s, -v[1] * s + v[2] * c]
}

/** Yaw about +Y: positive pan turns right (+X). */
export function rotYaw(v: Vec3, p: number): Vec3 {
  const c = Math.cos(p)
  const s = Math.sin(p)
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]
}

/** Radial distance (px) from circle center for a ray at angle theta from the optical axis. */
export function lensRadius(theta: number, model: LensModel, fovRad: number, radiusPx: number): number {
  if (model === 'equisolid') return (radiusPx * Math.sin(theta / 2)) / Math.sin(fovRad / 4)
  return (theta / (fovRad / 2)) * radiusPx
}

/** Inverse of lensRadius. */
export function lensTheta(rho: number, model: LensModel, fovRad: number, radiusPx: number): number {
  if (model === 'equisolid') {
    const s = (rho / radiusPx) * Math.sin(fovRad / 4)
    return 2 * Math.asin(Math.max(-1, Math.min(1, s)))
  }
  return (rho / radiusPx) * (fovRad / 2)
}

/** Sample point in source pixels for a world ray, or null if outside the lens FOV. */
export function worldToSource(dWorld: Vec3, calib: Calibration): { px: number; py: number } | null {
  const d = normalize(mulMat3(mountMatrix(calib.mount), dWorld))
  const theta = Math.acos(Math.max(-1, Math.min(1, d[2])))
  const fov = calib.fovDeg * DEG
  if (theta > fov / 2) return null
  const phi = Math.atan2(d[1], d[0])
  const rho = lensRadius(theta, calib.model, fov, calib.radiusPx)
  return { px: calib.cxPx + rho * Math.cos(phi), py: calib.cyPx + rho * Math.sin(phi) }
}

/** World ray for a source pixel (inverse of worldToSource). */
export function sourceToWorld(px: number, py: number, calib: Calibration): Vec3 | null {
  const dx = px - calib.cxPx
  const dy = py - calib.cyPx
  const rho = Math.hypot(dx, dy)
  const fov = calib.fovDeg * DEG
  const theta = lensTheta(rho, calib.model, fov, calib.radiusPx)
  if (theta > fov / 2 + 1e-9) return null
  const phi = Math.atan2(dy, dx)
  const dCam: Vec3 = [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)]
  const m = mountMatrix(calib.mount)
  // inverse of a rotation = transpose
  const mt: Mat3 = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
  return mulMat3(mt, dCam)
}

/** World ray for a PTZ output pixel. u,v in [-1,1] (v down), aspect = W/H. */
export function ptzRay(u: number, v: number, aspect: number, ptz: PtzState): Vec3 {
  const t = Math.tan((ptz.hfovDeg * DEG) / 2)
  let d: Vec3 = normalize([u * t, (v * t) / aspect, 1])
  d = rotPitch(d, ptz.tiltDeg * DEG)
  d = rotYaw(d, ptz.panDeg * DEG)
  return d
}

/** Direction from azimuth / elevation (elevation positive = below horizon). */
export function azElRay(azRad: number, elRad: number): Vec3 {
  return [Math.sin(azRad) * Math.cos(elRad), Math.sin(elRad), Math.cos(azRad) * Math.cos(elRad)]
}

export interface PanoParams {
  offsetDeg: number
  topDeg: number
  bottomDeg: number
}

/** World ray for a panorama output pixel. x,y in [0,1]. */
export function panoRay(x: number, y: number, mount: Mount, fovDeg: number, p: PanoParams): Vec3 {
  if (mount === 'wall') {
    const span = Math.min(fovDeg, 180)
    const az = (p.offsetDeg + (x - 0.5) * span) * DEG
    const el = (-45 + y * 90) * DEG
    return azElRay(az, el)
  }
  const az = (p.offsetDeg + x * 360) * DEG
  const e = p.topDeg + y * (p.bottomDeg - p.topDeg)
  // desk: sky up, horizon at the bottom of the strip
  const el = mount === 'desk' ? -(p.bottomDeg - y * (p.bottomDeg - p.topDeg)) * DEG : e * DEG
  return azElRay(az, el)
}

/** Dual panorama: top half covers [offset, offset+180), bottom half [offset+180, offset+360). */
export function dualPanoRay(x: number, y: number, mount: Mount, fovDeg: number, p: PanoParams): Vec3 {
  const top = y < 0.5
  const ly = top ? y * 2 : (y - 0.5) * 2
  const off = p.offsetDeg + (top ? 0 : 180)
  return panoRay(x * 0.5, ly, mount, fovDeg, { ...p, offsetDeg: off })
}

/** PTZ state that centers the view on a world direction, keeping zoom. */
export function ptzLookAt(d: Vec3, hfovDeg: number): PtzState {
  const n = normalize(d)
  return {
    panDeg: Math.atan2(n[0], n[2]) / DEG,
    tiltDeg: Math.asin(Math.max(-1, Math.min(1, n[1]))) / DEG,
    hfovDeg
  }
}
