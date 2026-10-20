import { describe, expect, it } from 'vitest'
import { detectCircle, kasaFit } from '@shared/dewarp/circleFit'
import { activeRedactions, angleDelta, evalBox, evalPtz, simplifyPath, upsertKeyframe } from '@shared/tracks'
import { driftCorrection, mediaTimeAt, timelineSpan } from '@shared/sync'
import type { Keyframe, PtzState } from '@shared/types'

function syntheticFisheye(w: number, h: number, cx: number, cy: number, r: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const inside = Math.hypot(x - cx, y - cy) <= r
      // textured content inside, with some dark patches that must not confuse the fit
      const v = inside ? 90 + ((x * 7 + y * 13) % 120) - (Math.hypot(x - cx - r * 0.3, y - cy) < r * 0.1 ? 80 : 0) : 4
      buf[i] = buf[i + 1] = buf[i + 2] = v
      buf[i + 3] = 255
    }
  }
  return buf
}

describe('circle detection', () => {
  it('kasaFit recovers an exact circle', () => {
    const pts = Array.from({ length: 30 }, (_, i) => ({ x: 50 + 20 * Math.cos(i), y: 40 + 20 * Math.sin(i) }))
    const f = kasaFit(pts)!
    expect(f.cx).toBeCloseTo(50)
    expect(f.cy).toBeCloseTo(40)
    expect(f.r).toBeCloseTo(20)
  })
  it('detects a centered circle', () => {
    const r = detectCircle(syntheticFisheye(320, 320, 160, 158, 150), 320, 320)
    expect(r.ok).toBe(true)
    expect(r.cx).toBeCloseTo(160, 0)
    expect(r.cy).toBeCloseTo(158, 0)
    expect(Math.abs(r.r - 150)).toBeLessThan(2)
  })
  it('detects an off-center circle in a wide frame', () => {
    const r = detectCircle(syntheticFisheye(427, 320, 200, 160, 140), 427, 320)
    expect(r.ok).toBe(true)
    expect(Math.abs(r.cx - 200)).toBeLessThan(2)
    expect(Math.abs(r.r - 140)).toBeLessThan(2)
  })
  it('handles a circle clipped by the sensor (top/bottom cut)', () => {
    const r = detectCircle(syntheticFisheye(427, 240, 213, 120, 150), 427, 240)
    expect(r.ok).toBe(true)
    expect(Math.abs(r.r - 150)).toBeLessThan(3)
  })
  it('falls back on a frame with no circle', () => {
    const buf = new Uint8ClampedArray(64 * 64 * 4).fill(200)
    const r = detectCircle(buf, 64, 64)
    expect(r.ok).toBe(false)
    expect(r.r).toBe(32)
  })
})

describe('tracks', () => {
  it('interpolates boxes linearly', () => {
    const k = [
      { tSec: 0, value: { x: 0, y: 0, w: 10, h: 10 } },
      { tSec: 2, value: { x: 100, y: 50, w: 30, h: 10 } }
    ]
    expect(evalBox(k, 1)).toEqual({ x: 50, y: 25, w: 20, h: 10 })
    expect(evalBox(k, 5)).toEqual(k[1].value)
  })
  it('covers the whole recording by default, or only the keyframe range when asked', () => {
    const all = { id: 'b', style: 'solid' as const, enabled: true, keyframes: [
      { tSec: 1, value: { x: 0, y: 0, w: 1, h: 1 } },
      { tSec: 3, value: { x: 5, y: 0, w: 1, h: 1 } }
    ] }
    expect(activeRedactions([all], 0)[0].box.x).toBe(0)
    expect(activeRedactions([all], 99)[0].box.x).toBe(5)
    expect(activeRedactions([{ ...all, enabled: false }], 2)).toHaveLength(0)
  })
  it('only applies limited redactions inside their keyframe range', () => {
    const tr = { id: 'a', style: 'blur' as const, enabled: true, range: 'keyframes' as const, keyframes: [
      { tSec: 1, value: { x: 0, y: 0, w: 1, h: 1 } },
      { tSec: 3, value: { x: 0, y: 0, w: 1, h: 1 } }
    ] }
    expect(activeRedactions([tr], 0.5)).toHaveLength(0)
    expect(activeRedactions([tr], 2)).toHaveLength(1)
    expect(activeRedactions([{ ...tr, keyframes: [tr.keyframes[0]] }], 99)).toHaveLength(1)
  })
  it('new boxes appear at their first keyframe and stay to the end', () => {
    const tr = { id: 'n', style: 'solid' as const, enabled: true, range: 'from' as const, keyframes: [
      { tSec: 12, value: { x: 0, y: 0, w: 1, h: 1 } },
      { tSec: 14, value: { x: 9, y: 0, w: 1, h: 1 } }
    ] }
    expect(activeRedactions([tr], 0)).toHaveLength(0)
    expect(activeRedactions([tr], 11.9)).toHaveLength(0)
    // covers the frame it was drawn on even if the clock sat slightly past that frame's start
    expect(activeRedactions([tr], 11.97)).toHaveLength(1)
    expect(activeRedactions([tr], 13)[0].box.x).toBeCloseTo(4.5)
    expect(activeRedactions([tr], 99)[0].box.x).toBe(9)
  })
  it('PTZ path takes the short way around', () => {
    const k: Keyframe<PtzState>[] = [
      { tSec: 0, value: { panDeg: 170, tiltDeg: 30, hfovDeg: 60 } },
      { tSec: 1, value: { panDeg: -170, tiltDeg: 30, hfovDeg: 60 } }
    ]
    const mid = evalPtz(k, 0.5)!
    expect(Math.abs(angleDelta(180, mid.panDeg))).toBeLessThan(1e-9)
  })
  it('upsert replaces near-identical times and keeps order', () => {
    let k: Keyframe<number>[] = []
    k = upsertKeyframe(k, 2, 1)
    k = upsertKeyframe(k, 1, 2)
    k = upsertKeyframe(k, 2.001, 3)
    expect(k.map((x) => x.value)).toEqual([2, 3])
  })
  it('simplifies a straight path to its endpoints', () => {
    const s: Keyframe<PtzState>[] = Array.from({ length: 50 }, (_, i) => ({ tSec: i / 10, value: { panDeg: i, tiltDeg: 20, hfovDeg: 60 } }))
    expect(simplifyPath(s)).toHaveLength(2)
  })
})

describe('sync', () => {
  const a = { id: 'a', startMs: 1_000_000, durationSec: 60, offsetSec: 0 }
  const b = { id: 'b', startMs: 1_030_000, durationSec: 60, offsetSec: 0 }
  it('spans all sources', () => {
    expect(timelineSpan([a, b])).toEqual({ startMs: 1_000_000, endMs: 1_090_000 })
  })
  it('maps master time to media time with gaps', () => {
    expect(mediaTimeAt(b, 1_010_000, 0)).toBeNull()
    expect(mediaTimeAt(b, 1_040_000, 0)).toBe(10)
    expect(mediaTimeAt({ ...b, offsetSec: 2 }, 1_040_000, 0)).toBe(8)
  })
  it('seeks on big drift, nudges on small drift', () => {
    expect(driftCorrection(10, 10.5, 1).kind).toBe('seek')
    const n = driftCorrection(10, 10.05, 1)
    expect(n.kind).toBe('nudge')
    expect(n.rate).toBeGreaterThan(1)
    expect(driftCorrection(10, 10.001, 1).kind).toBe('none')
  })
})
