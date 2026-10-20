/** Multi-camera clock model: one master wall-clock time drives each tile's media time. */

export interface SyncSource {
  id: string
  /** epoch ms of media time 0, or undefined if unknown */
  startMs?: number
  durationSec: number
  /** manual offset in seconds added to the start (user alignment) */
  offsetSec: number
}

export function effectiveStartMs(s: SyncSource, fallbackMs: number): number {
  return (s.startMs ?? fallbackMs) + s.offsetSec * 1000
}

/** Overall timeline [startMs, endMs] covering all sources. */
export function timelineSpan(sources: SyncSource[]): { startMs: number; endMs: number } {
  if (sources.length === 0) return { startMs: 0, endMs: 0 }
  const base = Math.min(...sources.map((s) => s.startMs ?? Infinity).filter(Number.isFinite), Infinity)
  const fallback = Number.isFinite(base) ? base : 0
  let start = Infinity
  let end = -Infinity
  for (const s of sources) {
    const st = effectiveStartMs(s, fallback)
    start = Math.min(start, st)
    end = Math.max(end, st + s.durationSec * 1000)
  }
  return { startMs: start, endMs: end }
}

/** Media time for a source at master time, or null when the source has no video then. */
export function mediaTimeAt(s: SyncSource, masterMs: number, fallbackMs: number): number | null {
  const t = (masterMs - effectiveStartMs(s, fallbackMs)) / 1000
  if (t < 0 || t > s.durationSec) return null
  return t
}

export interface DriftAction {
  kind: 'none' | 'nudge' | 'seek'
  rate?: number
  seekTo?: number
}

/** Decide how to correct a tile drifting from its target media time. */
export function driftCorrection(actual: number, target: number, baseRate: number): DriftAction {
  const err = target - actual
  if (Math.abs(err) > 0.15) return { kind: 'seek', seekTo: target }
  if (Math.abs(err) < 1 / 120) return { kind: 'none', rate: baseRate }
  const adj = Math.max(-0.03, Math.min(0.03, err * 0.5))
  return { kind: 'nudge', rate: baseRate * (1 + adj) }
}
