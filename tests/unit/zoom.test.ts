import { describe, expect, it } from 'vitest'
import { entryFromState, stateFromEntry } from '@shared/project'
import { clampWindow, evalZoom, maxUpscale, normalFromWindow, simplifyZoomPath, spliceKeyframes, windowForBox, windowFromNormal, windowRect } from '@shared/zoom'
import type { Keyframe, ZoomPath, ZoomWindow } from '@shared/types'

const W = 5120
const H = 2560
const A = 16 / 9
const kf = (tSec: number, cxPx: number, cyPx: number, hPx: number): Keyframe<ZoomWindow> => ({ tSec, value: { cxPx, cyPx, hPx } })

describe('zoom path evaluation', () => {
  const path: ZoomPath = { aspect: A, keyframes: [kf(2, 1500, 1000, 1200), kf(6, 3000, 1500, 300)] }

  it('hits keyframes exactly and holds outside them', () => {
    expect(evalZoom(path, 2, W, H)).toEqual({ cxPx: 1500, cyPx: 1000, hPx: 1200 })
    expect(evalZoom(path, 6, W, H)).toEqual({ cxPx: 3000, cyPx: 1500, hPx: 300 })
    expect(evalZoom(path, 0, W, H)).toEqual(evalZoom(path, 2, W, H))
    expect(evalZoom(path, 99, W, H)).toEqual(evalZoom(path, 6, W, H))
  })

  it('interpolates height in log space: the midpoint is the geometric mean', () => {
    const mid = evalZoom(path, 4, W, H)!
    expect(mid.hPx).toBeCloseTo(Math.sqrt(1200 * 300), 6)
    expect(mid.cxPx).toBeCloseTo(2250, 6)
    expect(mid.cyPx).toBeCloseTo(1250, 6)
  })

  it('eases in and out', () => {
    const early = evalZoom(path, 2.4, W, H)!
    expect(early.cxPx - 1500).toBeLessThan((3000 - 1500) * 0.1) // slower than linear at the start
  })

  it('is null without keyframes', () => {
    expect(evalZoom({ aspect: A, keyframes: [] }, 1, W, H)).toBeNull()
  })
})

describe('window clamping', () => {
  it('slides windows back inside at every edge and corner', () => {
    for (const [cx, cy] of [[0, 0], [W, 0], [0, H], [W, H], [W / 2, -500], [-500, H / 2]]) {
      const w = clampWindow({ cxPx: cx, cyPx: cy, hPx: 400 }, A, W, H)
      const r = windowRect(w, A)
      expect(r.x).toBeGreaterThanOrEqual(-1e-9)
      expect(r.y).toBeGreaterThanOrEqual(-1e-9)
      expect(r.x + r.w).toBeLessThanOrEqual(W + 1e-9)
      expect(r.y + r.h).toBeLessThanOrEqual(H + 1e-9)
      expect(w.hPx).toBe(400)
    }
  })
  it('shrinks windows larger than the frame, respecting the aspect', () => {
    const w = clampWindow({ cxPx: 100, cyPx: 100, hPx: 99999 }, A, W, H)
    expect(w.hPx).toBe(H) // 2560 × 16/9 = 4551 ≤ 5120
    const sq = clampWindow({ cxPx: 0, cyPx: 0, hPx: 99999 }, 4, 1000, 1000)
    expect(sq.hPx).toBe(250)
  })
  it('never zooms below the minimum window', () => {
    expect(clampWindow({ cxPx: 500, cyPx: 500, hPx: 2 }, A, W, H).hPx).toBe(32)
  })
})

describe('drawing a box', () => {
  it('gives the smallest window at the path aspect that contains it', () => {
    const tall = windowForBox({ x: 1000, y: 500, w: 100, h: 400 }, A, W, H)
    expect(tall).toEqual({ cxPx: 1050, cyPx: 700, hPx: 400 })
    const wide = windowForBox({ x: 1000, y: 500, w: 1600, h: 100 }, A, W, H)
    expect(wide.hPx).toBeCloseTo(900)
    const r = windowRect(wide, A)
    expect(r.x).toBeLessThanOrEqual(1000)
    expect(r.x + r.w).toBeGreaterThanOrEqual(2600 - 1e-9)
  })
})

describe('frame guide conversions', () => {
  const vp = { w: 1200, h: 700 }
  it('round-trips between the live view and a window', () => {
    const n = { zoom: 3, centerX: 0.4, centerY: 0.55 }
    const w = windowFromNormal(n, W, H, vp, A)
    const back = normalFromWindow(w, W, H, vp, A)
    expect(back.zoom).toBeCloseTo(3, 6)
    expect(back.centerX).toBeCloseTo(0.4, 6)
    expect(back.centerY).toBeCloseTo(0.55, 6)
  })
  it('the guide fills the viewport height when the viewport is wider than the aspect', () => {
    const w = windowFromNormal({ zoom: 4, centerX: 0.5, centerY: 0.5 }, W, H, { w: 2000, h: 700 }, A)
    const scale = Math.min(2000 / W, 700 / H) * 4
    expect(w.hPx * scale).toBeCloseTo(700, 6)
  })
})

describe('recording and simplification', () => {
  it('keeps endpoints and corners, drops samples on straight segments', () => {
    const samples: Keyframe<ZoomWindow>[] = []
    for (let i = 0; i <= 20; i++) samples.push(kf(i * 0.1, 1000 + i * 50, 1000, 500))
    for (let i = 1; i <= 20; i++) samples.push(kf(2 + i * 0.1, 2000, 1000 + i * 40, 500))
    const s = simplifyZoomPath(samples)
    expect(s[0]).toEqual(samples[0])
    expect(s[s.length - 1]).toEqual(samples[samples.length - 1])
    expect(s.length).toBeLessThanOrEqual(4)
    expect(s.some((k) => Math.abs(k.tSec - 2) < 0.15)).toBe(true) // the corner survives
  })
  it('replaces keyframes inside a re-recorded range only', () => {
    const k = [kf(0, 1, 1, 100), kf(2, 2, 2, 100), kf(5, 3, 3, 100)]
    const out = spliceKeyframes(k, 1, 3, [kf(1.5, 9, 9, 100)])
    expect(out.map((x) => x.tSec)).toEqual([0, 1.5, 5])
  })
  it('reports the worst upscale over a path', () => {
    const p: ZoomPath = { aspect: A, keyframes: [kf(0, 2000, 1000, 2160), kf(4, 2000, 1000, 540)] }
    expect(maxUpscale(p, 1080, [0, 2, 4], W, H)).toBeCloseTo(2)
  })
})

describe('saved projects', () => {
  it('round-trips zoom paths', () => {
    const z: ZoomPath = { aspect: A, keyframes: [kf(1, 10, 20, 300)] }
    const e = entryFromState({ redactions: [], viewPath: [], zoomPath: z, inSec: null, outSec: null })!
    expect(stateFromEntry(JSON.parse(JSON.stringify(e))).zoomPath).toEqual(z)
  })
  it('reads 1.0 projects (no zoom path) and drops malformed data', () => {
    const s = stateFromEntry({ redactions: [], viewPath: [{ tSec: 1, value: { panDeg: 0, tiltDeg: 30, hfovDeg: 80 } }], inSec: 2 })
    expect(s.zoomPath).toBeNull()
    expect(s.viewPath).toHaveLength(1)
    expect(s.inSec).toBe(2)
    expect(s.outSec).toBeNull()
    expect(stateFromEntry({ zoomPath: { aspect: 'x', keyframes: [] } } as never).zoomPath).toBeNull()
    expect(stateFromEntry({ zoomPath: { aspect: 1, keyframes: [{ tSec: 1, value: { cxPx: 1, cyPx: 1, hPx: -5 } }] } } as never).zoomPath).toBeNull()
  })
  it('skips recordings with nothing to save', () => {
    expect(entryFromState({ redactions: [], viewPath: [], zoomPath: { aspect: A, keyframes: [] }, inSec: null, outSec: null })).toBeNull()
  })
})
