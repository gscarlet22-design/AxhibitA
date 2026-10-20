import { describe, expect, it } from 'vitest'
import { ptzRay, worldToSource } from '@shared/dewarp/project'
import { planFromFootprint, sampleTimes, viewFootprint } from '@shared/export/footprint'
import type { ExportView } from '@shared/ipc'
import type { Calibration, PtzState, ViewState } from '@shared/types'

const calib: Calibration = { cxPx: 1441, cyPx: 1437, radiusPx: 1443, fovDeg: 180, model: 'equidistant', mount: 'ceiling' }
const view = (ptz: PtzState): ViewState => ({ mode: 'ptz', normal: { zoom: 1, centerX: 0.5, centerY: 0.5 }, ptz, pano: { offsetDeg: 0, topDeg: 0, bottomDeg: 70 }, quad: [] })

/** Every source point a PTZ output samples (dense grid) must fall inside the footprint. */
function coversDense(ptz: PtzState, outW: number, outH: number, rect: { x: number; y: number; w: number; h: number }) {
  for (let j = 0; j <= 60; j++) {
    for (let i = 0; i <= 60; i++) {
      const p = worldToSource(ptzRay((i / 60) * 2 - 1, (j / 60) * 2 - 1, outW / outH, ptz), calib)
      if (!p) continue
      if (p.px < rect.x - 0.5 || p.py < rect.y - 0.5 || p.px > rect.x + rect.w + 0.5 || p.py > rect.y + rect.h + 0.5) return false
    }
  }
  return true
}

describe('export footprint', () => {
  it('a PTZ view covers only part of the fisheye circle', () => {
    const ptz = { panDeg: 200, tiltDeg: 35, hfovDeg: 80 }
    const fp = viewFootprint({ kind: 'current', view: view(ptz), calib }, 2880, 2880, 1920, 1080, 0, 1)!
    expect(fp.rect.w * fp.rect.h).toBeLessThan(2880 * 2880 * 0.5)
    expect(coversDense(ptz, 1920, 1080, fp.rect)).toBe(true)
  })

  it('covers every sampled point for assorted PTZ views, including ones running off the lens', () => {
    for (const ptz of [{ panDeg: 0, tiltDeg: 90, hfovDeg: 60 }, { panDeg: 45, tiltDeg: 5, hfovDeg: 100 }, { panDeg: -120, tiltDeg: 60, hfovDeg: 30 }]) {
      const fp = viewFootprint({ kind: 'current', view: view(ptz), calib }, 2880, 2880, 1280, 720, 0, 1)!
      expect(coversDense(ptz, 1280, 720, fp.rect)).toBe(true)
    }
  })

  it('a view path covers the views at both ends', () => {
    const a = { panDeg: 0, tiltDeg: 30, hfovDeg: 90 }
    const b = { panDeg: 120, tiltDeg: 50, hfovDeg: 60 }
    const ev: ExportView = { kind: 'view-path', calib, keyframes: [{ tSec: 3, value: a }, { tSec: 4.5, value: b }] }
    const fp = viewFootprint(ev, 2880, 2880, 960, 540, 3, 4.5)!
    expect(coversDense(a, 960, 540, fp.rect)).toBe(true)
    expect(coversDense(b, 960, 540, fp.rect)).toBe(true)
  })

  it('a zoomed normal view covers the visible window and reports detail needed', () => {
    const v: ViewState = { ...view({ panDeg: 0, tiltDeg: 0, hfovDeg: 90 }), mode: 'normal', normal: { zoom: 2, centerX: 0.25, centerY: 0.5 } }
    const fp = viewFootprint({ kind: 'current', view: v, calib: null }, 3840, 2160, 1920, 1080, 0, 1)!
    expect(fp.rect).toEqual({ x: 0, y: 540, w: 1920, h: 1080 })
    expect(fp.minSrcPerOut).toBeCloseTo(1)
  })

  it('needs the whole frame for panoramas', () => {
    expect(viewFootprint({ kind: 'current', view: { ...view({ panDeg: 0, tiltDeg: 0, hfovDeg: 90 }), mode: 'pano' }, calib }, 2880, 2880, 3840, 1080, 0, 1)).toBeNull()
  })
})

describe('decode plan from footprint', () => {
  it('pads, clamps to the frame and keeps even coordinates', () => {
    const p = planFromFootprint({ rect: { x: -5, y: 101, w: 333, h: 211 }, minSrcPerOut: 0.5 }, 1000, 1000, 12e6, 16)
    expect(p.rect.x).toBe(0)
    expect(p.rect.y % 2).toBe(0)
    expect(p.rect.w % 2).toBe(0)
    expect(p.rect.y).toBeLessThanOrEqual(101 - 16)
    expect(p.rect.y + p.rect.h).toBeGreaterThanOrEqual(101 + 211 + 16)
    expect(p.scale).toBe(1) // upscaling view keeps full detail
  })
  it('downscales when the output never needs full source detail', () => {
    const p = planFromFootprint({ rect: { x: 0, y: 0, w: 3840, h: 2160 }, minSrcPerOut: 4 }, 3840, 2160, 12e6)
    expect(p.scale).toBeCloseTo(1.25 / 4)
  })
  it('falls back to the whole frame within the pixel budget', () => {
    const p = planFromFootprint(null, 5120, 2560, 6e6)
    expect(p.rect).toEqual({ x: 0, y: 0, w: 5120, h: 2560 })
    expect(5120 * 2560 * p.scale * p.scale).toBeLessThanOrEqual(6e6 + 1)
  })
  it('samples keyframes and range ends', () => {
    const ts = sampleTimes([3.05, 9], 3, 3.2)
    expect(ts).toEqual(expect.arrayContaining([3, 3.05, 3.2]))
    expect(ts).not.toContain(9)
    expect([...ts].sort((a, b) => a - b)).toEqual(ts)
  })
})
