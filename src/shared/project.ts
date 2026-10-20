/** Saved-project entries (per recording): what gets written and how older files are read back. */
import type { Keyframe, PtzState, RedactionTrack, ZoomPath } from './types'

export interface ProjectEntry {
  redactions: RedactionTrack[]
  viewPath: Keyframe<PtzState>[]
  /** added in 1.1; absent in older projects */
  zoomPath?: ZoomPath
  inSec?: number
  outSec?: number
}

export interface EditableState {
  redactions: RedactionTrack[]
  viewPath: Keyframe<PtzState>[]
  zoomPath: ZoomPath | null
  inSec: number | null
  outSec: number | null
}

/** Entry to save, or null when the recording has no edits worth keeping. */
export function entryFromState(p: EditableState): ProjectEntry | null {
  const zoom = p.zoomPath && p.zoomPath.keyframes.length ? p.zoomPath : undefined
  if (!p.redactions.length && !p.viewPath.length && !zoom && p.inSec === null && p.outSec === null) return null
  return { redactions: p.redactions, viewPath: p.viewPath, zoomPath: zoom, inSec: p.inSec ?? undefined, outSec: p.outSec ?? undefined }
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

function readZoomPath(z: unknown): ZoomPath | null {
  if (!z || typeof z !== 'object') return null
  const { aspect, keyframes } = z as { aspect?: unknown; keyframes?: unknown }
  if (!isNum(aspect) || aspect <= 0 || !Array.isArray(keyframes)) return null
  const k = keyframes.filter((x): x is Keyframe<{ cxPx: number; cyPx: number; hPx: number }> => {
    const v = (x as { value?: Record<string, unknown> })?.value
    return isNum((x as { tSec?: unknown }).tSec) && !!v && isNum(v.cxPx) && isNum(v.cyPx) && isNum(v.hPx) && (v.hPx as number) > 0
  })
  return k.length ? { aspect, keyframes: k.map((x) => ({ tSec: x.tSec, value: { cxPx: x.value.cxPx, cyPx: x.value.cyPx, hPx: x.value.hPx } })) } : null
}

/** State restored from a saved entry, tolerating projects saved by older versions. */
export function stateFromEntry(e: Partial<ProjectEntry> | undefined): EditableState {
  return {
    redactions: Array.isArray(e?.redactions) ? e.redactions : [],
    viewPath: Array.isArray(e?.viewPath) ? e.viewPath : [],
    zoomPath: readZoomPath(e?.zoomPath),
    inSec: isNum(e?.inSec) ? e.inSec : null,
    outSec: isNum(e?.outSec) ? e.outSec : null
  }
}
