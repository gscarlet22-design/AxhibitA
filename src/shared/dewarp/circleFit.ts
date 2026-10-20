/**
 * Fisheye image-circle auto-detection (docs/DEWARP.md → Image-circle auto-detect).
 * Pure function over an RGBA or luma buffer so it runs in tests and in the renderer.
 */

export interface CircleFitResult {
  cx: number
  cy: number
  r: number
  confidence: number
  ok: boolean
  points: number
}

export interface Pt {
  x: number
  y: number
}

/** Algebraic (Kåsa) least-squares circle fit. */
export function kasaFit(pts: Pt[]): { cx: number; cy: number; r: number } | null {
  const n = pts.length
  if (n < 3) return null
  let mx = 0
  let my = 0
  for (const p of pts) {
    mx += p.x
    my += p.y
  }
  mx /= n
  my /= n
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0
  for (const p of pts) {
    const u = p.x - mx
    const v = p.y - my
    suu += u * u
    svv += v * v
    suv += u * v
    suuu += u * u * u
    svvv += v * v * v
    suvv += u * v * v
    svuu += v * u * u
  }
  const det = suu * svv - suv * suv
  if (Math.abs(det) < 1e-9) return null
  const a = 0.5 * (suuu + suvv)
  const b = 0.5 * (svvv + svuu)
  const uc = (a * svv - b * suv) / det
  const vc = (b * suu - a * suv) / det
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n)
  return { cx: uc + mx, cy: vc + my, r }
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Circle through three points. */
function circle3(a: Pt, b: Pt, c: Pt): { cx: number; cy: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(d) < 1e-9) return null
  const a2 = a.x * a.x + a.y * a.y
  const b2 = b.x * b.x + b.y * b.y
  const c2 = c.x * c.x + c.y * c.y
  const cx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d
  const cy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d
  return { cx, cy, r: Math.hypot(a.x - cx, a.y - cy) }
}

export function ransacCircle(pts: Pt[], tol: number, iters = 200, seed = 1234) {
  const rnd = mulberry32(seed)
  let best: Pt[] = []
  for (let i = 0; i < iters && pts.length >= 3; i++) {
    const a = pts[Math.floor(rnd() * pts.length)]
    const b = pts[Math.floor(rnd() * pts.length)]
    const c = pts[Math.floor(rnd() * pts.length)]
    const m = circle3(a, b, c)
    if (!m || !Number.isFinite(m.r)) continue
    const inl = pts.filter((p) => Math.abs(Math.hypot(p.x - m.cx, p.y - m.cy) - m.r) <= tol)
    if (inl.length > best.length) best = inl
  }
  const fit = kasaFit(best)
  return { fit, inliers: best.length }
}

/** Convert RGBA to luma and apply a 5×5 box blur. */
export function lumaBlur(rgba: ArrayLike<number>, w: number, h: number): Float32Array {
  const l = new Float32Array(w * h)
  for (let i = 0, j = 0; i < w * h; i++, j += 4) l[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const R = 2
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0
      for (let k = -R; k <= R; k++) {
        const xx = x + k
        if (xx >= 0 && xx < w) {
          s += l[y * w + xx]
          n++
        }
      }
      tmp[y * w + x] = s / n
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0
      for (let k = -R; k <= R; k++) {
        const yy = y + k
        if (yy >= 0 && yy < h) {
          s += tmp[yy * w + x]
          n++
        }
      }
      out[y * w + x] = s / n
    }
  }
  return out
}

/**
 * Detect the fisheye image circle. Coordinates returned are in the given buffer's pixel space;
 * callers scale back to full resolution.
 */
export function detectCircle(rgba: ArrayLike<number>, w: number, h: number): CircleFitResult {
  const fallback: CircleFitResult = { cx: w / 2, cy: h / 2, r: Math.min(w, h) / 2, confidence: 0, ok: false, points: 0 }
  if (w < 16 || h < 16) return fallback
  const luma = lumaBlur(rgba, w, h)

  // median luma of the central 20% region
  const vals: number[] = []
  const x0 = Math.floor(w * 0.4), x1 = Math.ceil(w * 0.6)
  const y0 = Math.floor(h * 0.4), y1 = Math.ceil(h * 0.6)
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) vals.push(luma[y * w + x])
  vals.sort((a, b) => a - b)
  const median = vals[Math.floor(vals.length / 2)] ?? 0
  const T = Math.max(24, 0.15 * median)

  const pts: Pt[] = []
  const N = 180
  const cx0 = w / 2, cy0 = h / 2
  const maxR = Math.hypot(w, h) / 2
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2
    const dx = Math.cos(a), dy = Math.sin(a)
    let lastBright = -1
    let darkRun = 0
    let hitBorder = false
    for (let r = 0; r < maxR; r += 1) {
      const x = Math.round(cx0 + dx * r)
      const y = Math.round(cy0 + dy * r)
      if (x < 0 || y < 0 || x >= w || y >= h) {
        hitBorder = darkRun < 8
        break
      }
      if (luma[y * w + x] > T) {
        lastBright = r
        darkRun = 0
      } else if (lastBright >= 0) {
        darkRun++
        if (darkRun >= 8) break
      }
    }
    if (hitBorder || lastBright < 0) continue
    const ex = cx0 + dx * lastBright
    const ey = cy0 + dy * lastBright
    if (ex <= 1 || ey <= 1 || ex >= w - 2 || ey >= h - 2) continue
    pts.push({ x: ex, y: ey })
  }
  if (pts.length < 40) return { ...fallback, points: pts.length }
  const tol = Math.max(1.5, 0.015 * Math.max(w, h))
  const { fit, inliers } = ransacCircle(pts, tol)
  if (!fit || inliers < 40) return { ...fallback, points: pts.length }
  const confidence = inliers / pts.length
  if (confidence < 0.6) return { ...fallback, confidence, points: pts.length }
  return { cx: fit.cx, cy: fit.cy, r: fit.r, confidence, ok: true, points: pts.length }
}
