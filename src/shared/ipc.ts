/** Typed IPC contract between main and renderer (single source of truth). */
import type { ProjectEntry } from './project'
import type { Box, Calibration, JobEvent, PtzState, Recording, RedactionTrack, RedactOutside, SignedVideoResult, ViewState, ZoomPath } from './types'

export const IPC = {
  openPaths: 'library:open',
  pickFolder: 'dialog:pickFolder',
  pickFiles: 'dialog:pickFiles',
  pickOutputDir: 'dialog:pickOutputDir',
  prepareMedia: 'media:prepare',
  thumbnail: 'media:thumbnail',
  keyframes: 'media:keyframes',
  hashSource: 'hash:source',
  exportClip: 'export:clip',
  exportSnapshot: 'export:snapshot',
  verifySigned: 'verify:signed',
  cancelJob: 'jobs:cancel',
  jobEvent: 'jobs:event',
  storeGet: 'store:get',
  storeSet: 'store:set',
  reveal: 'shell:reveal',
  appInfo: 'app:info',
  openPathsPush: 'library:push',
  saveProject: 'project:save',
  loadProject: 'project:load'
} as const

export interface AppInfo {
  name: string
  version: string
  ffmpegVersion: string
  encoders: string[]
  encoder: string | null
  platform: string
  signedVideoValidator: boolean
  osUser: string
}

export interface Settings {
  theme: 'dark' | 'light'
  cacheLimitGb: number
  defaultOutputDir: string | null
  defaultTrimMode: 'fast' | 'exact'
  encoderOverride: string | null
  operatorName: string
  integrityNoticeAcknowledged: boolean
}

export interface StoreShape {
  settings: Settings
  calibrations: Record<string, Calibration>
  recent: string[]
}

export type ExportView =
  | { kind: 'original' }
  | { kind: 'crop'; rect: Box }
  | { kind: 'current'; view: ViewState; calib: Calibration | null }
  | { kind: 'view-path'; keyframes: { tSec: number; value: PtzState }[]; calib: Calibration }
  /** digital zoom path on the raw frame; output aspect must equal path.aspect */
  | { kind: 'zoom-path'; path: ZoomPath }

export interface ExportRequest {
  recordingId: string
  inSec: number
  outSec: number
  trimMode: 'fast' | 'exact'
  view: ExportView
  outW: number
  outH: number
  redactions: RedactionTrack[]
  /** hide everything outside the boxes with this style instead of inside them (default: inside) */
  redactOutside?: RedactOutside
  overlay: { timestamp: boolean; cameraName: boolean; customText: string | null }
  includeAudio: boolean
  outputDir: string
  fileStem: string
  notes: string | null
}

export interface ExportResult {
  outputPath: string
  manifestPath: string
}

export interface SnapshotRequest {
  recordingId: string
  png: Uint8Array
  width: number
  height: number
  mediaTimeSec: number
  view: ViewState
  calib: Calibration | null
  redactions: RedactionTrack[]
  /** hide everything outside the boxes with this style instead of inside them (default: inside) */
  redactOutside?: RedactOutside
  outputDir: string
  fileStem: string
  notes: string | null
}

export interface ProjectFile {
  schema: string
  savedAt: string
  sources: { fileName: string; sha256?: string; sizeBytes: number }[]
  recordings: Record<string, ProjectEntry>
}

/** Render job spec sent to the hidden export renderer. */
export interface RenderSpec {
  srcW: number
  srcH: number
  /** region of the source the decoded frames cover, in source px */
  srcRect: Box
  decW: number
  decH: number
  outW: number
  outH: number
  fps: number
  inSec: number
  view: ExportView
  redactions: RedactionTrack[]
  /** hide everything outside the boxes with this style instead of inside them (default: inside) */
  redactOutside?: RedactOutside
  overlay: ExportRequest['overlay']
  cameraName: string | null
  wallClockStart: string | null
  wallClockApprox: boolean
}

export interface AxhibitApi {
  openPaths(paths: string[]): Promise<Recording[]>
  pickFolder(): Promise<string | null>
  pickFiles(): Promise<string[]>
  pickOutputDir(): Promise<string | null>
  prepareMedia(recordingId: string, needProxy: boolean): Promise<string>
  /** JPEG data URL for the library, or null if no frame could be read */
  thumbnail(recordingId: string): Promise<string | null>
  keyframes(recordingId: string): Promise<number[]>
  hashSource(recordingId: string): Promise<string>
  exportClip(req: ExportRequest): Promise<string>
  exportSnapshot(req: SnapshotRequest): Promise<ExportResult>
  verifySigned(recordingId: string): Promise<string>
  cancelJob(jobId: string): Promise<void>
  onJobEvent(cb: (e: JobEvent) => void): () => void
  onOpenPaths(cb: (paths: string[]) => void): () => void
  storeGet<K extends keyof StoreShape>(key: K): Promise<StoreShape[K]>
  storeSet<K extends keyof StoreShape>(key: K, value: StoreShape[K]): Promise<void>
  reveal(path: string): Promise<void>
  appInfo(): Promise<AppInfo>
  pathForFile(file: File): string
  saveProject(dir: string, stem: string, project: ProjectFile): Promise<string>
  loadProject(): Promise<ProjectFile | null>
}

export type { SignedVideoResult }
