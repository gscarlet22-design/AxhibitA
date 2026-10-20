import { describe, expect, it } from 'vitest'
import {
  dualPanoRay,
  lensRadius,
  lensTheta,
  mountMatrix,
  panoRay,
  ptzLookAt,
  ptzRay,
  sourceToWorld,
  worldToSource,
  type Vec3
} from '@shared/dewarp/project'
import { clampPtz, defaultCalibration } from '@shared/dewarp/views'
import type { Calibration } from '@shared/types'

const det = (m: number[]) =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])

describe('mount matrices', () => {
  it('are proper rotations (no mirroring)', () => {
    for (const m of ['ceiling', 'desk', 'wall'] as const) expect(det(mountMatrix(m))).toBeCloseTo(1)
  })
})

describe('lens model', () => {
  it('equidistant and equisolid invert', () => {
    for (const model of ['equidistant', 'equisolid'] as const) {
      for (const th of [0, 0.3, 0.9, 1.5]) {
        const r = lensRadius(th, model, Math.PI, 1000)
        expect(lensTheta(r, model, Math.PI, 1000)).toBeCloseTo(th, 6)
      }
    }
  })
  it('maps the FOV edge to the circle radius', () => {
    expect(lensRadius(Math.PI / 2, 'equidistant', Math.PI, 1400)).toBeCloseTo(1400)
    expect(lensRadius(Math.PI / 2, 'equisolid', Math.PI, 1400)).toBeCloseTo(1400)
  })
})

describe('world <-> source', () => {
  const calib: Calibration = { ...defaultCalibration(2880, 2880), cxPx: 1450, cyPx: 1430, radiusPx: 1410 }
  it('round-trips for every mount', () => {
    for (const mount of ['ceiling', 'desk', 'wall'] as const) {
      const c = { ...calib, mount }
      for (const [px, py] of [[1450, 1430], [600, 900], [2400, 2000], [1450, 100]]) {
        const d = sourceToWorld(px, py, c)!
        const back = worldToSource(d, c)!
        expect(back.px).toBeCloseTo(px, 6)
        expect(back.py).toBeCloseTo(py, 6)
      }
    }
  })
  it('ceiling: straight down hits the circle center; horizon hits the rim', () => {
    const c = { ...calib, mount: 'ceiling' as const }
    const center = worldToSource([0, 1, 0], c)!
    expect(center.px).toBeCloseTo(1450)
    expect(center.py).toBeCloseTo(1430)
    const fwd = worldToSource([0, 0, 1], c)!
    expect(Math.hypot(fwd.px - 1450, fwd.py - 1430)).toBeCloseTo(1410)
    // world forward appears at the top of the image
    expect(fwd.py).toBeLessThan(1430)
  })
  it('rejects rays outside the lens', () => {
    expect(worldToSource([0, -1, 0], { ...calib, mount: 'ceiling' })).toBeNull()
  })
})

describe('views', () => {
  it('PTZ center ray points along pan/tilt', () => {
    const d = ptzRay(0, 0, 16 / 9, { panDeg: 30, tiltDeg: 40, hfovDeg: 70 })
    const back = ptzLookAt(d, 70)
    expect(back.panDeg).toBeCloseTo(30)
    expect(back.tiltDeg).toBeCloseTo(40)
  })
  it('PTZ horizontal edge is at hfov/2', () => {
    const d = ptzRay(1, 0, 1, { panDeg: 0, tiltDeg: 0, hfovDeg: 90 })
    expect((Math.atan2(d[0], d[2]) * 180) / Math.PI).toBeCloseTo(45)
  })
  it('pano rays stay unit and cover 360 for ceiling', () => {
    const p = { offsetDeg: 0, topDeg: 0, bottomDeg: 70 }
    const a: Vec3 = panoRay(0, 0, 'ceiling', 180, p)
    const b: Vec3 = panoRay(0.25, 0, 'ceiling', 180, p)
    expect(Math.hypot(...a)).toBeCloseTo(1)
    expect((Math.atan2(b[0], b[2]) * 180) / Math.PI).toBeCloseTo(90)
    // bottom row is 70° below horizon
    const c = panoRay(0, 1, 'ceiling', 180, p)
    expect((Math.asin(c[1]) * 180) / Math.PI).toBeCloseTo(70)
  })
  it('dual pano bottom half starts 180° around', () => {
    const p = { offsetDeg: 0, topDeg: 0, bottomDeg: 70 }
    const d = dualPanoRay(0, 0.5, 'ceiling', 180, p)
    expect(Math.abs((Math.atan2(d[0], d[2]) * 180) / Math.PI)).toBeCloseTo(180)
  })
  it('clamps PTZ by mount', () => {
    expect(clampPtz({ panDeg: 370, tiltDeg: 120, hfovDeg: 5 }, 'ceiling', 180)).toEqual({ panDeg: 10, tiltDeg: 90, hfovDeg: 15 })
    expect(clampPtz({ panDeg: 170, tiltDeg: 0, hfovDeg: 60 }, 'wall', 180).panDeg).toBe(80)
  })
})
