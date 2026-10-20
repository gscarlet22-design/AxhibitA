/**
 * Which part of the source an export view actually samples, and how much source detail it needs.
 * Used by the export decode plan to crop and downscale before frames cross IPC (the main export cost).
 */
import { defaultCalibration } from '../dewarp/views'
import { ptzRay, worldToSource } from '../dewarp/project'
import { evalPtz } from '../tracks'
import { evalZoom, windowRect } from '../zoom'
import type { ExportView } from '../ipc'
import type { Box, Calibration, PtzState } from '../types'

export interface Footprint {
  /** Source region sampled (source px, not clamped/padded). */
  rect: Box
  /**
   * Smallest number of source px per output px anywhere in the view. Below 1 the view is upscaling,
   * so full source resolution is needed; above 1 the decode can be downscaled.
   */
  minSrcPerOut: number
}

const GRID = 24

/** Sample a PTZ view on a grid of output points; null where a ray leaves the lens. */
function ptzSamples(ptz: PtzState, calib: Calibration, outW: number, outH: number): ({ px: number; py: number } | null)[][] {
  const aspect = outW / outH
  const rows: ({ px: number; py: number } | null)[][] = []
  for (let j = 0; j <= GRID; j++) {
    const row: ({ px: number; py: number } | null)[] = []
    for (let i = 0; i <= GRID; i++) row.push(worldToSource(ptzRay((i / GRID) * 2 - 1, (j / GRID) * 2 - 1, aspect, ptz), calib))
    rows.push(row)
  }
  return rows
}

function ptzFootprint(ptz: PtzState, calib: Calibration, outW: number, outH: number): Footprint | null {
  const s = ptzSamples(ptz, calib, outW, outH)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  let partial = false
  let minRatio = Infinity
  const stepX = outW / GRID
  const stepY = outH / GRID
  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      const p = s[j][i]
      if (!p) {
        partial = true
        continue
      }
      x0 = Math.min(x0, p.px); y0 = Math.min(y0, p.py); x1 = Math.max(x1, p.px); y1 = Math.max(y1, p.py)
      const r = i < GRID ? s[j][i + 1] : null
      const d = j < GRID ? s[j + 1][i] : null
      if (r) minRatio = Math.min(minRatio, Math.hypot(r.px - p.px, r.py - p.py) / stepX)
      if (d) minRatio = Math.min(minRatio, Math.hypot(d.px - p.px, d.py - p.py) / stepY)
    }
  }
  if (!Number.isFinite(x0)) return null
  // pad by one grid cell of source distance so the region between samples (and the lens rim) is covered
  const cell = Math.max((x1 - x0) / GRID, (y1 - y0) / GRID)
  if (partial) {
    // the view runs off the lens: include the rim on the visible side generously
    const r = calib.radiusPx
    x0 = Math.max(calib.cxPx - r, x0 - cell * 2); y0 = Math.max(calib.cyPx - r, y0 - cell * 2)
    x1 = Math.min(calib.cxPx + r, x1 + cell * 2); y1 = Math.min(calib.cyPx + r, y1 + cell * 2)
  }
  return { rect: { x: x0 - cell, y: y0 - cell, w: x1 - x0 + 2 * cell, h: y1 - y0 + 2 * cell }, minSrcPerOut: Number.isFinite(minRatio) ? minRatio : 1 }
}

function union(a: Footprint | null, b: Footprint | null): Footprint | null {
  if (!a) return b
  if (!b) return a
  const x = Math.min(a.rect.x, b.rect.x)
  const y = Math.min(a.rect.y, b.rect.y)
  return {
    rect: { x, y, w: Math.max(a.rect.x + a.rect.w, b.rect.x + b.rect.w) - x, h: Math.max(a.rect.y + a.rect.h, b.rect.y + b.rect.h) - y },
    minSrcPerOut: Math.min(a.minSrcPerOut, b.minSrcPerOut)
  }
}

/** Times at which to evaluate an animated view over [inSec, outSec]: every keyframe plus a regular sampling. */
export function sampleTimes(keyTimes: number[], inSec: number, outSec: number, step = 0.1): number[] {
  const ts = new Set<number>([inSec, outSec])
  for (let t = inSec; t < outSec; t += step) ts.add(t)
  for (const k of keyTimes) if (k > inSec && k < outSec) ts.add(k)
  return [...ts].sort((a, b) => a - b)
}

/**
 * Footprint of an export view over the export range, or null when it needs the whole frame
 * (original frame, panoramas, unknown).
 */
export function viewFootprint(view: ExportView, srcW: number, srcH: number, outW: number, outH: number, inSec: number, outSec: number): Footprint | null {
  if (view.kind === 'crop') {
    return { rect: { ...view.rect }, minSrcPerOut: Math.min(view.rect.w / outW, view.rect.h / outH) }
  }
  if (view.kind === 'current') {
    const v = view.view
    if (v.mode === 'normal') {
      const fit = Math.min(outW / srcW, outH / srcH)
      const scale = fit * v.normal.zoom // output px per source px
      const w = outW / scale
      const h = outH / scale
      return { rect: { x: v.normal.centerX * srcW - w / 2, y: v.normal.centerY * srcH - h / 2, w, h }, minSrcPerOut: 1 / scale }
    }
    const calib = view.calib ?? defaultCalibration(srcW, srcH)
    if (v.mode === 'ptz') return ptzFootprint(v.ptz, calib, outW, outH)
    if (v.mode === 'quad') {
      // each quadrant is about half the output in each dimension
      return v.quad.reduce<Footprint | null>((acc, q) => union(acc, ptzFootprint(q, calib, outW / 2, outH / 2)), null)
    }
    return null
  }
  if (view.kind === 'zoom-path') {
    let acc: Footprint | null = null
    for (const t of sampleTimes(view.path.keyframes.map((k) => k.tSec), inSec, outSec)) {
      const w = evalZoom(view.path, t, srcW, srcH)
      if (w) acc = union(acc, { rect: windowRect(w, view.path.aspect), minSrcPerOut: w.hPx / outH })
    }
    return acc
  }
  if (view.kind === 'view-path') {
    let acc: Footprint | null = null
    for (const t of sampleTimes(view.keyframes.map((k) => k.tSec), inSec, outSec)) {
      const p = evalPtz(view.keyframes, t)
      if (p) acc = union(acc, ptzFootprint(p, view.calib, outW, outH))
    }
    return acc
  }
  return null
}

/**
 * Decode plan from a footprint: crop to the (padded, clamped, even-aligned) footprint and downscale when the
 * output never needs full source detail. `maxPixels` bounds the IPC cost of one frame.
 */
export function planFromFootprint(fp: Footprint | null, srcW: number, srcH: number, maxPixels: number, pad = 16): { rect: Box; scale: number } {
  let rect: Box = { x: 0, y: 0, w: srcW, h: srcH }
  if (fp) {
    const x0 = Math.max(0, Math.floor((fp.rect.x - pad) / 2) * 2)
    const y0 = Math.max(0, Math.floor((fp.rect.y - pad) / 2) * 2)
    const x1 = Math.min(srcW, Math.ceil((fp.rect.x + fp.rect.w + pad) / 2) * 2)
    const y1 = Math.min(srcH, Math.ceil((fp.rect.y + fp.rect.h + pad) / 2) * 2)
    if (x1 - x0 >= 16 && y1 - y0 >= 16) rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }
  // keep ≥1.25 decoded px per output px where the view needs the most detail
  const detail = fp ? Math.min(1, 1.25 / Math.max(fp.minSrcPerOut, 1e-6)) : 1
  const budget = Math.min(1, Math.sqrt(maxPixels / (rect.w * rect.h)))
  return { rect, scale: Math.min(detail, budget) }
}
