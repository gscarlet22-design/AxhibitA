import { describe, expect, it } from 'vitest'
import { ptzToSource, screenRectToSourceBox, sourceBoxOutline, sourceToPtz } from '@shared/dewarp/boxmap'
import type { Calibration, PtzState } from '@shared/types'

const calib: Calibration = { cxPx: 1441, cyPx: 1437, radiusPx: 1443, fovDeg: 180, model: 'equidistant', mount: 'ceiling' }
const vp = { x: 40, y: 20, w: 1280, h: 720 }
const views: PtzState[] = [
  { panDeg: 0, tiltDeg: 35, hfovDeg: 80 },
  { panDeg: 200, tiltDeg: 60, hfovDeg: 45 },
  { panDeg: -75, tiltDeg: 15, hfovDeg: 100 }
]

describe('PTZ view ↔ raw fisheye mapping', () => {
  it('round-trips screen points through the raw frame', () => {
    for (const ptz of views) {
      for (const [px, py] of [[40, 20], [680, 380], [1300, 700], [300, 600]]) {
        const s = ptzToSource(px, py, vp, ptz, calib)
        if (!s) continue // above the horizon: outside a ceiling fisheye's 180° circle
        const back = sourceToPtz(s.x, s.y, vp, ptz, calib)!
        expect(back.x).toBeCloseTo(px, 6)
        expect(back.y).toBeCloseTo(py, 6)
      }
    }
  })

  it('reports points behind the view as not visible', () => {
    // straight down from a view looking at the horizon to the north: the opposite side is behind
    const behind = ptzToSource(680, 380, vp, { panDeg: 180, tiltDeg: 10, hfovDeg: 60 }, calib)!
    expect(sourceToPtz(behind.x, behind.y, vp, { panDeg: 0, tiltDeg: 10, hfovDeg: 60 }, calib)).toBeNull()
  })
})

describe('boxes drawn in a PTZ view', () => {
  it('cover everything inside the drawn rectangle', () => {
    for (const ptz of views) {
      const r = { x: 500, y: 250, w: 200, h: 260 }
      const b = screenRectToSourceBox(r, vp, ptz, calib)!
      for (let j = 0; j <= 30; j++) {
        for (let i = 0; i <= 30; i++) {
          const p = ptzToSource(r.x + (r.w * i) / 30, r.y + (r.h * j) / 30, vp, ptz, calib)!
          expect(p.x).toBeGreaterThanOrEqual(b.x - 1.5)
          expect(p.y).toBeGreaterThanOrEqual(b.y - 1.5)
          expect(p.x).toBeLessThanOrEqual(b.x + b.w + 1.5)
          expect(p.y).toBeLessThanOrEqual(b.y + b.h + 1.5)
        }
      }
    }
  })

  it('draws the stored box back as an outline enclosing the drawn rectangle', () => {
    const ptz = views[0]
    const r = { x: 600, y: 300, w: 120, h: 120 }
    const b = screenRectToSourceBox(r, vp, ptz, calib)!
    const lines = sourceBoxOutline(b, vp, ptz, calib)
    expect(lines.length).toBe(1)
    const xs = lines[0].map((p) => p.x)
    const ys = lines[0].map((p) => p.y)
    expect(Math.min(...xs)).toBeLessThanOrEqual(r.x + 1)
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(r.x + r.w - 1)
    expect(Math.min(...ys)).toBeLessThanOrEqual(r.y + 1)
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(r.y + r.h - 1)
  })

  it('returns nothing for a rectangle entirely outside the lens', () => {
    // a wide view aimed past the horizon sees beyond the 180° circle at its top edge
    const r = { x: 600, y: 20, w: 60, h: 4 }
    const b = screenRectToSourceBox(r, vp, { panDeg: 0, tiltDeg: -60, hfovDeg: 120 }, calib)
    expect(b).toBeNull()
  })
})
