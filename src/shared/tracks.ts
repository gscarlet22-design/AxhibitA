import type { Box, Keyframe, PtzState, RedactionTrack } from './types'

export function sortKeyframes<T>(k: Keyframe<T>[]): Keyframe<T>[] {
  return [...k].sort((a, b) => a.tSec - b.tSec)
}

/** Insert or replace a keyframe within `eps` seconds of t. */
export function upsertKeyframe<T>(k: Keyframe<T>[], t: number, value: T, eps = 1 / 120): Keyframe<T>[] {
  const out = k.filter((kf) => Math.abs(kf.tSec - t) > eps)
  out.push({ tSec: t, value })
  return sortKeyframes(out)
}

export function removeKeyframeNear<T>(k: Keyframe<T>[], t: number, eps = 1 / 30): Keyframe<T>[] {
  return k.filter((kf) => Math.abs(kf.tSec - t) > eps)
}

function bracket<T>(k: Keyframe<T>[], t: number): [Keyframe<T>, Keyframe<T>, number] | null {
  if (k.length === 0) return null
  if (t <= k[0].tSec) return [k[0], k[0], 0]
  const last = k[k.length - 1]
  if (t >= last.tSec) return [last, last, 0]
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i], b = k[i + 1]
    if (t >= a.tSec && t <= b.tSec) {
      const span = b.tSec - a.tSec
      return [a, b, span > 0 ? (t - a.tSec) / span : 0]
    }
  }
  return [last, last, 0]
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f
/** Ease-in-out shared by animated paths (PTZ view paths, zoom paths). */
export const ease = (f: number) => (f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2)

export function evalBox(k: Keyframe<Box>[], t: number): Box | null {
  const br = bracket(k, t)
  if (!br) return null
  const [a, b, f] = br
  return { x: lerp(a.value.x, b.value.x, f), y: lerp(a.value.y, b.value.y, f), w: lerp(a.value.w, b.value.w, f), h: lerp(a.value.h, b.value.h, f) }
}

/**
 * Active redaction boxes at time t. By default a track covers the whole recording (holding its first/last
 * position) so a subject is never accidentally exposed; range 'keyframes' limits it to first..last keyframe.
 */
export function activeRedactions(tracks: RedactionTrack[], t: number): { box: Box; style: RedactionTrack['style'] }[] {
  const out: { box: Box; style: RedactionTrack['style'] }[] = []
  for (const tr of tracks) {
    if (!tr.enabled || tr.keyframes.length === 0) continue
    const k = sortKeyframes(tr.keyframes)
    if (tr.range === 'keyframes' && k.length > 1 && (t < k[0].tSec - 1e-6 || t > k[k.length - 1].tSec + 1e-6)) continue
    const box = evalBox(k, t)
    if (box) out.push({ box, style: tr.style })
  }
  return out
}

/**
 * Reduce a redaction box recorded while playing to keyframes. A sample is kept when straight interpolation
 * from the last kept keyframe misses it by more than `tolFrac` of the box's smaller side (at least `minPx`),
 * on any edge, so the glide between keyframes stays within that distance of what was recorded.
 */
export function simplifyBoxPath(samples: Keyframe<Box>[], tolFrac = 0.03, minPx = 2): Keyframe<Box>[] {
  if (samples.length <= 2) return samples
  const s = sortKeyframes(samples)
  const out: Keyframe<Box>[] = [s[0]]
  let anchor = 0
  for (let i = 2; i < s.length; i++) {
    const a = s[anchor], c = s[i]
    for (let j = anchor + 1; j < i; j++) {
      const b = s[j]
      const f = (b.tSec - a.tSec) / (c.tSec - a.tSec || 1)
      const x = lerp(a.value.x, c.value.x, f)
      const y = lerp(a.value.y, c.value.y, f)
      const r = lerp(a.value.x + a.value.w, c.value.x + c.value.w, f)
      const btm = lerp(a.value.y + a.value.h, c.value.y + c.value.h, f)
      const tol = Math.max(minPx, tolFrac * Math.min(b.value.w, b.value.h))
      const err = Math.max(Math.abs(x - b.value.x), Math.abs(y - b.value.y), Math.abs(r - (b.value.x + b.value.w)), Math.abs(btm - (b.value.y + b.value.h)))
      if (err > tol) {
        out.push(s[i - 1])
        anchor = i - 1
        break
      }
    }
  }
  out.push(s[s.length - 1])
  return out
}

/** Shortest signed angular difference b - a in degrees. */
export function angleDelta(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180
}

export function evalPtz(k: Keyframe<PtzState>[], t: number): PtzState | null {
  const br = bracket(sortKeyframes(k), t)
  if (!br) return null
  const [a, b, f0] = br
  const f = ease(f0)
  return {
    panDeg: a.value.panDeg + angleDelta(a.value.panDeg, b.value.panDeg) * f,
    tiltDeg: lerp(a.value.tiltDeg, b.value.tiltDeg, f),
    hfovDeg: lerp(a.value.hfovDeg, b.value.hfovDeg, f)
  }
}

/**
 * Reduce a densely recorded path to keyframes: keep a sample when the linear prediction from
 * the last kept keyframe drifts more than tolerance (degrees).
 */
export function simplifyPath(samples: Keyframe<PtzState>[], tolDeg = 1.5): Keyframe<PtzState>[] {
  if (samples.length <= 2) return samples
  const s = sortKeyframes(samples)
  const out: Keyframe<PtzState>[] = [s[0]]
  let anchor = 0
  for (let i = 2; i < s.length; i++) {
    const a = s[anchor], c = s[i]
    for (let j = anchor + 1; j < i; j++) {
      const b = s[j]
      const f = (b.tSec - a.tSec) / (c.tSec - a.tSec || 1)
      const pan = a.value.panDeg + angleDelta(a.value.panDeg, c.value.panDeg) * f
      const tilt = lerp(a.value.tiltDeg, c.value.tiltDeg, f)
      const fov = lerp(a.value.hfovDeg, c.value.hfovDeg, f)
      const err = Math.max(Math.abs(angleDelta(pan, b.value.panDeg)), Math.abs(tilt - b.value.tiltDeg), Math.abs(fov - b.value.hfovDeg))
      if (err > tolDeg) {
        out.push(s[i - 1])
        anchor = i - 1
        break
      }
    }
  }
  out.push(s[s.length - 1])
  return out
}
