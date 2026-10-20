import { defaultCalibration } from '@shared/dewarp/views'
import type { ExportView } from '@shared/ipc'
import { evalPtz } from '@shared/tracks'
import { formatWallClock, wallClockAt } from '@shared/time'
import { evalZoom } from '@shared/zoom'
import type { Box, Calibration, RedactStyle, ViewState } from '@shared/types'
import { normalMapping, type GLRenderer, type Viewport } from './renderer'

export interface ViewInput {
  srcW: number
  srcH: number
  srcRect?: Box
  view: ViewState
  calib: Calibration | null
  boxes: { box: Box; style: RedactStyle }[]
  redactOutside?: RedactStyle | null
}

/** Sub-viewports for the quad view (2×2 with a 2px gutter). */
export function quadViewports(vp: Viewport): Viewport[] {
  const g = 2
  const w = Math.floor((vp.w - g) / 2)
  const h = Math.floor((vp.h - g) / 2)
  return [
    { x: vp.x, y: vp.y, w, h },
    { x: vp.x + w + g, y: vp.y, w: vp.w - w - g, h },
    { x: vp.x, y: vp.y + h + g, w, h: vp.h - h - g },
    { x: vp.x + w + g, y: vp.y + h + g, w: vp.w - w - g, h: vp.h - h - g }
  ]
}

export function drawView(r: GLRenderer, i: ViewInput, vp: Viewport): void {
  const calib = i.calib ?? defaultCalibration(i.srcW, i.srcH)
  const base = { srcW: i.srcW, srcH: i.srcH, srcRect: i.srcRect, boxes: i.boxes, redactOutside: i.redactOutside, calib }
  switch (i.view.mode) {
    case 'normal': {
      const m = normalMapping(i.srcW, i.srcH, vp, i.view.normal)
      r.draw({ ...base, mode: 'normal', normCenter: m.center, normScale: m.scale }, vp)
      break
    }
    case 'ptz':
      r.draw({ ...base, mode: 'ptz', ptz: i.view.ptz }, vp)
      break
    case 'pano':
      r.draw({ ...base, mode: 'pano', pano: i.view.pano }, vp)
      break
    case 'dualpano':
      r.draw({ ...base, mode: 'dualpano', pano: i.view.pano }, vp)
      break
    case 'quad': {
      const vps = quadViewports(vp)
      vps.forEach((v, k) => r.draw({ ...base, mode: 'ptz', ptz: i.view.quad[k] }, v))
      break
    }
  }
}

/** Draw an export frame for any ExportView at media time t. */
export function drawExportView(r: GLRenderer, ev: ExportView, i: Omit<ViewInput, 'view' | 'calib'>, t: number, vp: Viewport): void {
  const base = { srcW: i.srcW, srcH: i.srcH, srcRect: i.srcRect, boxes: i.boxes, redactOutside: i.redactOutside }
  if (ev.kind === 'original') {
    r.draw({ ...base, mode: 'normal', normCenter: { x: i.srcW / 2, y: i.srcH / 2 }, normScale: Math.min(vp.w / i.srcW, vp.h / i.srcH) }, vp)
  } else if (ev.kind === 'crop') {
    const c = ev.rect
    r.draw({ ...base, mode: 'normal', normCenter: { x: c.x + c.w / 2, y: c.y + c.h / 2 }, normScale: Math.min(vp.w / c.w, vp.h / c.h) }, vp)
  } else if (ev.kind === 'current') {
    drawView(r, { ...i, view: ev.view, calib: ev.calib }, vp)
  } else if (ev.kind === 'zoom-path') {
    const w = evalZoom(ev.path, t, i.srcW, i.srcH) ?? { cxPx: i.srcW / 2, cyPx: i.srcH / 2, hPx: i.srcH }
    // output aspect equals the path aspect, so scaling by height frames the window exactly
    r.draw({ ...base, mode: 'normal', normCenter: { x: w.cxPx, y: w.cyPx }, normScale: vp.h / w.hPx }, vp)
  } else {
    const ptz = evalPtz(ev.keyframes, t) ?? { panDeg: 0, tiltDeg: 35, hfovDeg: 80 }
    r.draw({ ...base, mode: 'ptz', ptz, calib: ev.calib }, vp)
  }
}

export function overlayLines(o: { timestamp: boolean; cameraName: boolean; customText: string | null }, cameraName: string | null, wallStart: string | null, approx: boolean, t: number): string[] {
  const lines: string[] = []
  if (o.cameraName && cameraName) lines.push(cameraName)
  if (o.timestamp) {
    const d = wallClockAt(wallStart ?? undefined, t)
    lines.push(d ? formatWallClock(d, true) + (approx ? ' (approx.)' : '') : `Elapsed ${t.toFixed(2)} s`)
  }
  if (o.customText) lines.push(o.customText)
  return lines
}

/** Burn overlay text into a 2D context (top-left, boxed for legibility). */
export function drawOverlay(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, lines: string[], w: number, h: number): void {
  if (!lines.length) return
  const size = Math.max(12, Math.round(h / 32))
  ctx.font = `600 ${size}px "Segoe UI", Inter, Arial, sans-serif`
  ctx.textBaseline = 'top'
  const pad = Math.round(size * 0.45)
  const lh = Math.round(size * 1.3)
  const width = Math.max(...lines.map((l) => ctx.measureText(l).width))
  const x = Math.round(w * 0.015)
  const y = Math.round(h * 0.02)
  ctx.fillStyle = 'rgba(0,0,0,0.6)'
  ctx.fillRect(x, y, width + pad * 2, lines.length * lh + pad * 2 - (lh - size))
  ctx.fillStyle = '#ffffff'
  lines.forEach((l, k) => ctx.fillText(l, x + pad, y + pad + k * lh))
}
