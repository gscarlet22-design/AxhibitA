/**
 * Zoom paths: digital pan/zoom over time on the raw frame (any camera). Pure math shared by playback,
 * the export renderer, the decode plan and tests.
 */
import { ease } from './tracks'
import type { Box, Keyframe, NormalState, ZoomPath, ZoomWindow } from './types'

export const ZOOM_ASPECTS: { label: string; value: number }[] = [
  { label: '16:9', value: 16 / 9 },
  { label: '4:3', value: 4 / 3 },
  { label: '1:1', value: 1 }
]

/** Smallest window allowed (source px tall), so a path can't zoom into a handful of pixels. */
export const MIN_WINDOW_H = 32

const lerp = (a: number, b: number, f: number) => a + (b - a) * f

/** Keep a window inside the frame: shrink it to fit, then slide it in. */
export function clampWindow(w: ZoomWindow, aspect: number, srcW: number, srcH: number): ZoomWindow {
  const maxH = Math.min(srcH, srcW / aspect)
  const hPx = Math.max(Math.min(MIN_WINDOW_H, maxH), Math.min(maxH, w.hPx))
  const halfW = (hPx * aspect) / 2
  const halfH = hPx / 2
  return {
    hPx,
    cxPx: Math.max(halfW, Math.min(srcW - halfW, w.cxPx)),
    cyPx: Math.max(halfH, Math.min(srcH - halfH, w.cyPx))
  }
}

export function windowRect(w: ZoomWindow, aspect: number): Box {
  const ww = w.hPx * aspect
  return { x: w.cxPx - ww / 2, y: w.cyPx - w.hPx / 2, w: ww, h: w.hPx }
}

/** Smallest window at `aspect` that contains a box (e.g. one the investigator drew). */
export function windowForBox(b: Box, aspect: number, srcW: number, srcH: number): ZoomWindow {
  return clampWindow({ cxPx: b.x + b.w / 2, cyPx: b.y + b.h / 2, hPx: Math.max(b.h, b.w / aspect) }, aspect, srcW, srcH)
}

function sorted(k: Keyframe<ZoomWindow>[]) {
  return [...k].sort((a, b) => a.tSec - b.tSec)
}

/**
 * Window at time t. Height is interpolated in log space so zooming feels uniform; the center linearly
 * (in source px); both with the same ease-in-out as PTZ view paths. Before the first / after the last keyframe the window holds.
 */
export function evalZoom(path: ZoomPath, t: number, srcW: number, srcH: number): ZoomWindow | null {
  const k = sorted(path.keyframes)
  if (!k.length) return null
  let a = k[0], b = k[0], f = 0
  if (t >= k[k.length - 1].tSec) a = b = k[k.length - 1]
  else if (t > k[0].tSec) {
    for (let i = 0; i < k.length - 1; i++) {
      if (t >= k[i].tSec && t <= k[i + 1].tSec) {
        a = k[i]
        b = k[i + 1]
        const span = b.tSec - a.tSec
        f = span > 0 ? ease((t - a.tSec) / span) : 0
        break
      }
    }
  }
  const w: ZoomWindow = {
    cxPx: lerp(a.value.cxPx, b.value.cxPx, f),
    cyPx: lerp(a.value.cyPx, b.value.cyPx, f),
    // exact at keyframes (exp(log x) isn't)
    hPx: f === 0 ? a.value.hPx : Math.exp(lerp(Math.log(a.value.hPx), Math.log(b.value.hPx), f))
  }
  return clampWindow(w, path.aspect, srcW, srcH)
}

/**
 * Reduce densely recorded samples to keyframes: keep a sample when straight interpolation from the last
 * kept one drifts by more than tolFrac of the window height (center or height).
 */
export function simplifyZoomPath(samples: Keyframe<ZoomWindow>[], tolFrac = 0.02): Keyframe<ZoomWindow>[] {
  if (samples.length <= 2) return samples
  const s = sorted(samples)
  const out: Keyframe<ZoomWindow>[] = [s[0]]
  let anchor = 0
  for (let i = 2; i < s.length; i++) {
    const a = s[anchor], c = s[i]
    for (let j = anchor + 1; j < i; j++) {
      const b = s[j]
      const f = (b.tSec - a.tSec) / (c.tSec - a.tSec || 1)
      const cx = lerp(a.value.cxPx, c.value.cxPx, f)
      const cy = lerp(a.value.cyPx, c.value.cyPx, f)
      const h = Math.exp(lerp(Math.log(a.value.hPx), Math.log(c.value.hPx), f))
      const tol = tolFrac * b.value.hPx
      if (Math.abs(cx - b.value.cxPx) > tol || Math.abs(cy - b.value.cyPx) > tol || Math.abs(h - b.value.hPx) > tol) {
        out.push(s[i - 1])
        anchor = i - 1
        break
      }
    }
  }
  out.push(s[s.length - 1])
  return out
}

/** Replace the keyframes inside [from, to] with new ones (used after recording over part of a path). */
export function spliceKeyframes<T>(k: Keyframe<T>[], from: number, to: number, add: Keyframe<T>[]): Keyframe<T>[] {
  return [...k.filter((x) => x.tSec < from || x.tSec > to), ...add].sort((a, b) => a.tSec - b.tSec)
}

/**
 * The frame guide for the live raw view: the largest rectangle at `aspect` that fits the viewport,
 * expressed as a window in source px (clamped to the frame).
 */
export function windowFromNormal(n: NormalState, srcW: number, srcH: number, vp: { w: number; h: number }, aspect: number): ZoomWindow {
  const scale = Math.min(vp.w / srcW, vp.h / srcH) * n.zoom // screen px per source px
  const guideH = vp.w / vp.h > aspect ? vp.h : vp.w / aspect
  return clampWindow({ cxPx: n.centerX * srcW, cyPx: n.centerY * srcH, hPx: guideH / scale }, aspect, srcW, srcH)
}

/** Live-view zoom/center that shows `w` exactly in the frame guide (inverse of windowFromNormal). */
export function normalFromWindow(w: ZoomWindow, srcW: number, srcH: number, vp: { w: number; h: number }, aspect: number): NormalState {
  const guideH = vp.w / vp.h > aspect ? vp.h : vp.w / aspect
  const fit = Math.min(vp.w / srcW, vp.h / srcH)
  return { zoom: guideH / w.hPx / fit, centerX: w.cxPx / srcW, centerY: w.cyPx / srcH }
}

/** Largest output-px per source-px ratio over a path (>1 means the export upscales). */
export function maxUpscale(path: ZoomPath, outH: number, times: number[], srcW: number, srcH: number): number {
  let m = 0
  for (const t of times) {
    const w = evalZoom(path, t, srcW, srcH)
    if (w) m = Math.max(m, outH / w.hPx)
  }
  return m
}
