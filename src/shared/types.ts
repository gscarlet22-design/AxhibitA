// Core domain types shared by main, preload and renderer.

export type Mount = 'ceiling' | 'desk' | 'wall'
export type LensModel = 'equidistant' | 'equisolid'

/** Fisheye calibration in source pixels. */
export interface Calibration {
  cxPx: number
  cyPx: number
  radiusPx: number
  fovDeg: number
  model: LensModel
  mount: Mount
}

export type ViewMode = 'normal' | 'ptz' | 'pano' | 'dualpano' | 'quad'

export interface PtzState {
  panDeg: number
  tiltDeg: number
  hfovDeg: number
}

export interface NormalState {
  /** Digital zoom (1 = fit). */
  zoom: number
  /** Center of view in normalized source coords (0..1). */
  centerX: number
  centerY: number
}

export interface ViewState {
  mode: ViewMode
  normal: NormalState
  ptz: PtzState
  pano: { offsetDeg: number; topDeg: number; bottomDeg: number }
  quad: PtzState[]
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export type RedactStyle = 'blur' | 'pixelate' | 'solid'

export interface Keyframe<T> {
  tSec: number
  value: T
}

export interface RedactionTrack {
  id: string
  style: RedactStyle
  keyframes: Keyframe<Box>[]
  enabled: boolean
  /** 'all' (default, safest): hidden for the whole recording, holding the first/last position.
   *  'keyframes': only between the first and last keyframe. */
  range?: 'all' | 'keyframes'
}

export interface ViewPathTrack {
  keyframes: Keyframe<PtzState>[]
}

/**
 * A framing window on the raw frame, in source pixels. Width is hPx × the path's aspect.
 * Source pixels (not the live view's screen-relative zoom) so a keyframe means the same thing at any
 * window size or output size, and can go straight into the manifest.
 */
export interface ZoomWindow {
  cxPx: number
  cyPx: number
  hPx: number
}

/** Digital zoom path (pan + zoom over time) on the raw frame of any camera. */
export interface ZoomPath {
  /** width / height of every window and of the exported clip */
  aspect: number
  keyframes: Keyframe<ZoomWindow>[]
}

export interface VideoStreamInfo {
  codec: string
  width: number
  height: number
  fps: number
  pixFmt?: string
  colorSpace?: string
}

export interface AudioStreamInfo {
  codec: string
  channels: number
  sampleRate: number
}

export interface MediaInfo {
  path: string
  fileName: string
  sizeBytes: number
  modifiedAt: string
  container: string
  durationSec: number
  video?: VideoStreamInfo
  audio?: AudioStreamInfo
  tags: Record<string, string>
  wallClockStart?: string
  wallClockSource: string
  /** true when wall-clock comes from the file name (approximate, ±seconds) */
  wallClockApprox: boolean
  wallClockStop?: string
  cameraName?: string
  cameraNameSource: string
  /** Axis camera id (product id + serial) when present */
  cameraId?: string
  axis?: {
    isFisheye?: boolean
    lensProfile?: number[]
    tiltOrientation?: number
    triggerName?: string
  }
  /** container start_time offset in seconds */
  startTimeSec: number
}

export interface Recording extends MediaInfo {
  id: string
  error?: string
}

export type SignedVideoStatus =
  | 'not_checked'
  | 'verified'
  | 'partially_verified'
  | 'failed'
  | 'not_signed'
  | 'unsupported'

export interface SignedVideoResult {
  status: SignedVideoStatus
  checkedAt: string
  publicKeySha256?: string
  gopsTotal: number
  gopsValid: number
  invalidRanges: { fromSec: number; toSec: number; reason: string }[]
  validator: string
  detail?: string
}

export interface JobEvent {
  jobId: string
  kind: 'progress' | 'done' | 'error'
  progress?: number
  message?: string
  result?: unknown
}
