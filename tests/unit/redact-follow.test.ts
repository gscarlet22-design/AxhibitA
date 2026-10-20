import { describe, expect, it } from 'vitest'
import { evalBox, simplifyBoxPath } from '@shared/tracks'
import { spliceKeyframes } from '@shared/zoom'
import type { Box, Keyframe } from '@shared/types'

const kf = (tSec: number, x: number, y: number, w = 120, h = 160): Keyframe<Box> => ({ tSec, value: { x, y, w, h } })

/** Densely sampled path: walks right for 2 s, then down for 2 s, with sub-pixel hand jitter. */
function recorded(): Keyframe<Box>[] {
  const out: Keyframe<Box>[] = []
  for (let i = 0; i <= 40; i++) out.push(kf(i * 0.05, 100 + i * 10 + (i % 2) * 0.4, 300))
  for (let i = 1; i <= 40; i++) out.push(kf(2 + i * 0.05, 500, 300 + i * 8 - (i % 2) * 0.4))
  return out
}

describe('following a subject while playing', () => {
  it('thins a recorded path to a few keyframes, keeping the turn', () => {
    const s = simplifyBoxPath(recorded())
    expect(s.length).toBeLessThanOrEqual(5)
    expect(s[0].tSec).toBe(0)
    expect(s[s.length - 1].tSec).toBe(4)
    expect(s.some((k) => Math.abs(k.tSec - 2) <= 0.06)).toBe(true)
  })

  it('never lets the glide drift from what was recorded by more than the tolerance', () => {
    const samples = recorded()
    const s = simplifyBoxPath(samples, 0.03, 2)
    for (const k of samples) {
      const b = evalBox(s, k.tSec)!
      const tol = Math.max(2, 0.03 * Math.min(k.value.w, k.value.h)) + 1e-9
      expect(Math.abs(b.x - k.value.x)).toBeLessThanOrEqual(tol)
      expect(Math.abs(b.y - k.value.y)).toBeLessThanOrEqual(tol)
      expect(Math.abs(b.x + b.w - (k.value.x + k.value.w))).toBeLessThanOrEqual(tol)
      expect(Math.abs(b.y + b.h - (k.value.y + k.value.h))).toBeLessThanOrEqual(tol)
    }
  })

  it('keeps resizes made while following', () => {
    const samples: Keyframe<Box>[] = []
    for (let i = 0; i <= 20; i++) samples.push(kf(i * 0.1, 200, 200, 100 + (i > 10 ? (i - 10) * 15 : 0), 100))
    const s = simplifyBoxPath(samples)
    expect(evalBox(s, 2)!.w).toBe(250)
    expect(s.some((k) => Math.abs(k.tSec - 1) < 0.15)).toBe(true)
  })

  it('replaces only the recorded stretch of an existing track', () => {
    const existing = [kf(0, 0, 0), kf(5, 50, 50), kf(9, 90, 90)]
    const out = spliceKeyframes(existing, 4, 6, [kf(4, 1, 1), kf(6, 2, 2)])
    expect(out.map((k) => k.tSec)).toEqual([0, 4, 6, 9])
  })
})
