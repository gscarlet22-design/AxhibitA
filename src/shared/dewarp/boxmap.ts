/**
 * Mapping between a dewarped PTZ viewport (screen px) and the raw fisheye frame (source px), for drawing,
 * moving and following redaction boxes in PTZ / quad views. Boxes stay stored in source px (what the shader
 * and the manifest use); these helpers only translate the interaction and the on-screen outline.
 * Built on the same TS mirror of the shader as everything else (project.ts).
 */
import type { Box, Calibration, PtzState } from '../types'
import { DEG, ptzRay, rotPitch, rotYaw, sourceToWorld, worldToSource } from './project'

export interface ScreenRect {
  x: number
  y: number
  w: number
  h: number
}

export interface Pt {
  x: number
  y: number
}

/** Source px under a screen point of a PTZ viewport, or null outside the lens. */
export function ptzToSource(px: number, py: number, vp: ScreenRect, ptz: PtzState, calib: Calibration): Pt | null {
  const u = ((px - vp.x) / vp.w) * 2 - 1
  const v = ((py - vp.y) / vp.h) * 2 - 1
  const s = worldToSource(ptzRay(u, v, vp.w / vp.h, ptz), calib)
  return s ? { x: s.px, y: s.py } : null
}

/** Screen point of a source px in a PTZ viewport (inverse of ptzToSource), or null when behind the view. */
export function sourceToPtz(sx: number, sy: number, vp: ScreenRect, ptz: PtzState, calib: Calibration): Pt | null {
  const w = sourceToWorld(sx, sy, calib)
  if (!w) return null
  // undo ptzRay: it pitches, then yaws
  const d = rotPitch(rotYaw(w, -ptz.panDeg * DEG), -ptz.tiltDeg * DEG)
  if (d[2] <= 1e-6) return null
  const t = Math.tan((ptz.hfovDeg * DEG) / 2)
  const u = d[0] / d[2] / t
  const v = (d[1] / d[2]) * (vp.w / vp.h) / t
  return { x: vp.x + ((u + 1) / 2) * vp.w, y: vp.y + ((v + 1) / 2) * vp.h }
}

/**
 * Source box that covers a rectangle drawn on a PTZ view: the bounding box of its outline and interior
 * projected onto the raw frame. Never smaller than what was drawn (redaction errs toward covering more).
 */
export function screenRectToSourceBox(r: ScreenRect, vp: ScreenRect, ptz: PtzState, calib: Calibration, n = 10): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      // the outline at full density, the interior on the same grid (catches bulges near the lens axis)
      const p = ptzToSource(r.x + (r.w * i) / n, r.y + (r.h * j) / n, vp, ptz, calib)
      if (!p) continue
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y)
    }
  }
  if (!Number.isFinite(x0)) return null
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
}

/**
 * Outline of a source box as it appears in a PTZ view: polylines (split where the outline goes behind the
 * view) in screen px, for drawing the true curved shape that will be redacted.
 */
export function sourceBoxOutline(b: Box, vp: ScreenRect, ptz: PtzState, calib: Calibration, perEdge = 16): Pt[][] {
  const pts: (Pt | null)[] = []
  const edge = (ax: number, ay: number, bx: number, by: number) => {
    for (let i = 0; i < perEdge; i++) pts.push(sourceToPtz(ax + ((bx - ax) * i) / perEdge, ay + ((by - ay) * i) / perEdge, vp, ptz, calib))
  }
  edge(b.x, b.y, b.x + b.w, b.y)
  edge(b.x + b.w, b.y, b.x + b.w, b.y + b.h)
  edge(b.x + b.w, b.y + b.h, b.x, b.y + b.h)
  edge(b.x, b.y + b.h, b.x, b.y)
  pts.push(pts[0])
  const lines: Pt[][] = []
  let cur: Pt[] = []
  for (const p of pts) {
    if (p) cur.push(p)
    else if (cur.length) {
      lines.push(cur)
      cur = []
    }
  }
  if (cur.length > 1) lines.push(cur)
  return lines.filter((l) => l.length > 1)
}
