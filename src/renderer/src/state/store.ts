import { create } from 'zustand'
import { defaultViewState } from '@shared/dewarp/views'
import type { AppInfo, Settings } from '@shared/ipc'
import type { Calibration, Keyframe, Mount, PtzState, Recording, RedactionTrack, RedactOutside, SignedVideoResult, ViewState, ZoomPath } from '@shared/types'

export interface PerRecording {
  view: ViewState
  fisheye: boolean
  redactions: RedactionTrack[]
  /** null: boxes are hidden; a style: everything outside the boxes is hidden with it */
  redactOutside: RedactOutside
  viewPath: Keyframe<PtzState>[]
  followPath: boolean
  /** digital zoom path on the raw frame (any camera) */
  zoomPath: ZoomPath | null
  /** replay the zoom path during playback; manual pan/zoom pauses it */
  followZoom: boolean
  /** show the dashed export frame for zoom paths */
  frameGuide: boolean
  inSec: number | null
  outSec: number | null
}

export interface MediaState {
  status: 'idle' | 'preparing' | 'ready' | 'error'
  url?: string
  progress?: number
  error?: string
  proxy?: boolean
}

export interface JobState {
  id: string
  label: string
  progress: number
  message?: string
  status: 'running' | 'done' | 'error'
  error?: string
  result?: unknown
  kind: 'export' | 'prepare' | 'verify' | 'hash'
  recordingId?: string
}

export type SignedState = SignedVideoResult | { status: 'checking'; progress: number }

export type Tool = 'none' | 'redact-draw' | 'calibrate' | 'zoom-box'

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
  detail?: string
  action?: { label: string; run: () => void }
}

interface State {
  appInfo: AppInfo | null
  settings: Settings | null
  recordings: Recording[]
  loading: boolean
  selectedId: string | null
  layout: 'single' | 'grid'
  gridCameras: string[]
  focusedTile: number
  media: Record<string, MediaState>
  /** library thumbnails (JPEG data URLs); null = could not be grabbed */
  thumbs: Record<string, string | null>
  per: Record<string, PerRecording>
  calibrations: Record<string, Calibration>
  keyframes: Record<string, number[]>
  signed: Record<string, SignedState>
  jobs: Record<string, JobState>
  toasts: Toast[]
  tool: Tool
  selectedTrack: string | null
  rightTab: 'view' | 'redact' | 'verify' | 'info'
  exportOpen: boolean
  settingsOpen: boolean
  shortcutsOpen: boolean
  /** playback (single: media seconds; grid: master epoch ms) */
  playing: boolean
  rate: number
  time: number
  duration: number
  gridOffsets: Record<string, number>
}

interface Actions {
  set: (p: Partial<State>) => void
  updatePer: (id: string, fn: (p: PerRecording) => PerRecording) => void
  toast: (t: Omit<Toast, 'id'>) => void
  dismissToast: (id: number) => void
}

/**
 * Camera identity across containers: MP4 exports carry only the name (file name), ASF/MKV carry name + id,
 * so group by normalized name and fall back to id / file name.
 */
export function cameraKey(r: Recording): string {
  if (r.cameraName) return r.cameraName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return r.cameraId ?? r.fileName
}

export function mountFromAxis(r: Recording): Mount {
  // FINDINGS §4: TiltOrientation=2 observed on a ceiling mount. Other values unconfirmed.
  const t = r.axis?.tiltOrientation
  if (t === 0) return 'wall'
  if (t === 1) return 'desk'
  return 'ceiling'
}

export function newPer(r: Recording): PerRecording {
  const mount = mountFromAxis(r)
  return {
    view: defaultViewState(mount),
    fisheye: !!r.axis?.isFisheye,
    redactions: [],
    redactOutside: null,
    viewPath: [],
    followPath: true,
    zoomPath: null,
    followZoom: true,
    frameGuide: true,
    inSec: null,
    outSec: null
  }
}

let toastId = 1

export const useApp = create<State & Actions>((set, get) => ({
  appInfo: null,
  settings: null,
  recordings: [],
  loading: false,
  selectedId: null,
  layout: 'single',
  gridCameras: [],
  focusedTile: 0,
  media: {},
  thumbs: {},
  per: {},
  calibrations: {},
  keyframes: {},
  signed: {},
  jobs: {},
  toasts: [],
  tool: 'none',
  selectedTrack: null,
  rightTab: 'view',
  exportOpen: false,
  settingsOpen: false,
  shortcutsOpen: false,
  playing: false,
  rate: 1,
  time: 0,
  duration: 0,
  gridOffsets: {},
  set: (p) => set(p),
  updatePer: (id, fn) => {
    const rec = get().recordings.find((r) => r.id === id)
    const cur = get().per[id] ?? (rec ? newPer(rec) : undefined)
    if (!cur) return
    set({ per: { ...get().per, [id]: fn(cur) } })
  },
  toast: (t) => {
    const id = toastId++
    set({ toasts: [...get().toasts, { ...t, id }] })
    if (t.kind !== 'error') setTimeout(() => get().dismissToast(id), 6000)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) })
}))

export function selectedRecording(): Recording | undefined {
  const s = useApp.getState()
  return s.recordings.find((r) => r.id === s.selectedId)
}

export function perFor(id: string): PerRecording {
  const s = useApp.getState()
  const r = s.recordings.find((x) => x.id === id)
  return s.per[id] ?? newPer(r!)
}

export function calibrationFor(r: Recording): Calibration | null {
  return useApp.getState().calibrations[cameraKey(r)] ?? null
}

/** Wait for a background job to finish. */
export function waitJob<T>(jobId: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const j = useApp.getState().jobs[jobId]
      if (j?.status === 'done') {
        unsub()
        resolve(j.result as T)
      } else if (j?.status === 'error') {
        unsub()
        reject(new Error(j.error))
      }
    }
    const unsub = useApp.subscribe(check)
    check()
  })
}
