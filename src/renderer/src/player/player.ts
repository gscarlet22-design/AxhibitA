/**
 * Playback controller (non-React): owns <video> elements, the GL renderer, the draw loop,
 * single-recording playback and synchronized multi-camera grid playback.
 */
import { detectCircle } from '@shared/dewarp/circleFit'
import { clampPtz, defaultCalibration } from '@shared/dewarp/views'
import { driftCorrection, mediaTimeAt, timelineSpan, type SyncSource } from '@shared/sync'
import { activeRedactions, evalBox, evalPtz, simplifyBoxPath, sortKeyframes } from '@shared/tracks'
import type { Box, Calibration, Keyframe, NormalState, PtzState, Recording, RedactionTrack, ViewState, ZoomWindow } from '@shared/types'
import { evalZoom, normalFromWindow, simplifyZoomPath, spliceKeyframes, windowFromNormal } from '@shared/zoom'
import { drawView } from '../gl/compose'
import { GLRenderer, type Viewport } from '../gl/renderer'
import { cameraKey, perFor, useApp, waitJob } from '../state/store'

export interface Tile {
  cameraKey: string
  label: string
  segments: Recording[]
  vp: Viewport
  video: HTMLVideoElement
  activeId: string | null
  /** Segment that should be showing but is still being prepared (remux/proxy). */
  pendingId: string | null
  empty: boolean
}

const api = () => window.axhibit

async function canPlay(r: Recording): Promise<boolean> {
  const v = r.video
  if (!v) return false
  const codecs = v.codec === 'hevc' ? 'hvc1.1.6.L153.B0' : v.codec === 'h264' ? 'avc1.640033' : ''
  if (!codecs) return false
  try {
    const res = await navigator.mediaCapabilities.decodingInfo({
      type: 'file',
      video: { contentType: `video/mp4; codecs="${codecs}"`, width: v.width, height: v.height, bitrate: 8e6, framerate: v.fps || 15 }
    })
    return res.supported
  } catch {
    return v.codec === 'h264'
  }
}

const preparing = new Map<string, Promise<string>>()

/** Remux (or proxy) a recording into the cache and return its playable URL. */
export function ensureMedia(r: Recording): Promise<string> {
  const s = useApp.getState()
  const m = s.media[r.id]
  if (m?.status === 'ready' && m.url) return Promise.resolve(m.url)
  const existing = preparing.get(r.id)
  if (existing) return existing
  const p = (async () => {
    const proxy = !(await canPlay(r))
    useApp.setState((st) => ({ media: { ...st.media, [r.id]: { status: 'preparing', progress: 0, proxy } } }))
    try {
      const jobId = await api().prepareMedia(r.id, proxy)
      useApp.setState((st) => ({ jobs: { ...st.jobs, [jobId]: { id: jobId, label: proxy ? `Making playable copy of ${r.fileName}` : `Opening ${r.fileName}`, progress: 0, status: 'running', kind: 'prepare', recordingId: r.id } } }))
      const url = await waitJob<string>(jobId)
      useApp.setState((st) => ({ media: { ...st.media, [r.id]: { status: 'ready', url, proxy } } }))
      return url
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      useApp.setState((st) => ({ media: { ...st.media, [r.id]: { status: 'error', error: msg } } }))
      throw err
    } finally {
      preparing.delete(r.id)
    }
  })()
  preparing.set(r.id, p)
  return p
}

function newVideo(): HTMLVideoElement {
  const v = document.createElement('video')
  v.muted = false
  v.preload = 'auto'
  v.playsInline = true
  v.crossOrigin = 'anonymous'
  v.style.display = 'none'
  return v
}

export class Player {
  private canvas: HTMLCanvasElement | null = null
  private host: HTMLElement | null = null
  private gl: GLRenderer | null = null
  private single = newVideo()
  private singleId: string | null = null
  tiles: Tile[] = []
  private raf = 0
  private dirty = true
  private lastUi = 0
  private masterMs = 0
  private lastTick = 0
  private span = { startMs: 0, endMs: 0 }
  private sources: Record<string, SyncSource> = {}
  private recordingPath: { tSec: number; value: PtzState }[] | null = null
  private recordingZoom: Keyframe<ZoomWindow>[] | null = null
  /** a redaction box being steered by hand while the video plays */
  private following: { recId: string; trackId: string; samples: Keyframe<Box>[]; live: Box; prevRate: number } | null = null
  private lastSample = -1
  private unsub: (() => void) | null = null
  private ro: ResizeObserver | null = null
  onTilesChanged: (() => void) | null = null
  glError: string | null = null

  attach(canvas: HTMLCanvasElement, host: HTMLElement) {
    this.canvas = canvas
    this.host = host
    try {
      this.gl = new GLRenderer(canvas)
    } catch (err) {
      this.glError = err instanceof Error ? err.message : String(err)
    }
    host.appendChild(this.single)
    this.single.addEventListener('loadedmetadata', () => {
      useApp.setState({ duration: this.single.duration || 0 })
      this.dirty = true
    })
    this.single.addEventListener('ended', () => {
      useApp.setState({ playing: false })
      this.finishRedactFollow()
    })
    for (const ev of ['seeked', 'loadeddata', 'canplay']) this.single.addEventListener(ev, () => (this.dirty = true))
    this.watchFrames(this.single)
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(host)
    this.resize()
    this.unsub = useApp.subscribe(() => (this.dirty = true))
    const loop = (ts: number) => {
      this.tick(ts)
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  detach() {
    cancelAnimationFrame(this.raf)
    this.unsub?.()
    this.ro?.disconnect()
  }

  private watchFrames(v: HTMLVideoElement) {
    const cb = () => {
      this.dirty = true
      v.requestVideoFrameCallback(cb)
    }
    if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(cb)
  }

  private resize() {
    if (!this.canvas || !this.host) return
    const dpr = window.devicePixelRatio || 1
    const r = this.host.getBoundingClientRect()
    this.canvas.width = Math.max(2, Math.round(r.width * dpr))
    this.canvas.height = Math.max(2, Math.round(r.height * dpr))
    this.canvas.style.width = `${r.width}px`
    this.canvas.style.height = `${r.height}px`
    this.layoutTiles()
    this.dirty = true
  }

  /** CSS-pixel viewport for the single view (whole canvas). */
  cssViewport(): Viewport {
    const r = this.host?.getBoundingClientRect()
    return { x: 0, y: 0, w: r?.width ?? 0, h: r?.height ?? 0 }
  }

  get dpr() {
    return window.devicePixelRatio || 1
  }

  // ---------- single mode ----------

  async load(r: Recording | undefined) {
    this.recordingPath = null
    this.recordingZoom = null
    this.finishRedactFollow()
    if (!r) {
      this.singleId = null
      this.single.removeAttribute('src')
      this.single.load()
      return
    }
    if (this.singleId === r.id) return
    this.singleId = r.id
    this.single.pause()
    useApp.setState({ playing: false, time: 0, duration: r.durationSec })
    try {
      const url = await ensureMedia(r)
      if (this.singleId !== r.id) return
      this.single.src = url
      this.single.playbackRate = useApp.getState().rate
    } catch (err) {
      useApp.getState().toast({ kind: 'error', text: `Couldn't open ${r.fileName}`, detail: err instanceof Error ? err.message : String(err) })
    }
  }

  get video(): HTMLVideoElement {
    return this.single
  }

  // ---------- grid mode ----------

  setGrid(cameraKeys: string[], recordings: Recording[]) {
    for (const t of this.tiles) {
      t.video.pause()
      t.video.remove()
    }
    this.tiles = cameraKeys.map((k) => {
      const segs = recordings.filter((r) => cameraKey(r) === k && !r.error).sort((a, b) => (a.wallClockStart ?? '').localeCompare(b.wallClockStart ?? ''))
      const video = newVideo()
      video.muted = true
      this.host?.appendChild(video)
      this.watchFrames(video)
      for (const ev of ['seeked', 'loadeddata', 'canplay']) video.addEventListener(ev, () => (this.dirty = true))
      return { cameraKey: k, label: segs[0]?.cameraName ?? k, segments: segs, vp: { x: 0, y: 0, w: 0, h: 0 }, video, activeId: null, pendingId: null, empty: true }
    })
    this.rebuildSync()
    this.masterMs = this.span.startMs
    useApp.setState({ time: this.masterMs, duration: (this.span.endMs - this.span.startMs) / 1000 })
    this.layoutTiles()
    this.onTilesChanged?.()
    this.prepareGrid()
  }

  /**
   * Prepare every segment of every grid camera up front so tiles don't go blank at segment changes.
   * Cameras prepare in parallel; within a camera, segments go one at a time, nearest the playhead first.
   */
  private prepareGrid() {
    const tiles = this.tiles
    for (const t of tiles) {
      const order = [...t.segments].sort((a, b) => this.distanceFromPlayhead(a) - this.distanceFromPlayhead(b))
      void (async () => {
        for (const r of order) {
          if (this.tiles !== tiles) return // grid changed
          await ensureMedia(r).catch(() => undefined)
        }
      })()
    }
  }

  private distanceFromPlayhead(r: Recording): number {
    const src = this.sources[r.id]
    if (!src?.startMs) return Number.MAX_SAFE_INTEGER
    const start = src.startMs + (src.offsetSec ?? 0) * 1000
    const end = start + r.durationSec * 1000
    return this.masterMs < start ? start - this.masterMs : this.masterMs > end ? this.masterMs - end : 0
  }

  rebuildSync() {
    const offsets = useApp.getState().gridOffsets
    const sources: Record<string, SyncSource> = {}
    for (const t of this.tiles) {
      for (const s of t.segments) {
        sources[s.id] = {
          id: s.id,
          startMs: s.wallClockStart ? Date.parse(s.wallClockStart) : undefined,
          durationSec: s.durationSec,
          offsetSec: offsets[t.cameraKey] ?? 0
        }
      }
    }
    this.sources = sources
    this.span = timelineSpan(Object.values(sources))
  }

  get gridSpan() {
    return this.span
  }

  private layoutTiles() {
    const vp = this.cssViewport()
    const n = this.tiles.length
    if (!n) return
    const cols = n <= 1 ? 1 : 2
    const rows = Math.ceil(n / cols)
    const g = 4
    const w = (vp.w - g * (cols - 1)) / cols
    const h = (vp.h - g * (rows - 1)) / rows
    this.tiles.forEach((t, i) => {
      const c = i % cols
      const r = Math.floor(i / cols)
      t.vp = { x: Math.round(c * (w + g)), y: Math.round(r * (h + g)), w: Math.round(w), h: Math.round(h) }
    })
    this.onTilesChanged?.()
  }

  private segmentAt(t: Tile, masterMs: number): { rec: Recording; mediaT: number } | null {
    for (const s of t.segments) {
      const src = this.sources[s.id]
      if (!src) continue
      const mt = mediaTimeAt(src, masterMs, this.span.startMs)
      if (mt !== null) return { rec: s, mediaT: mt }
    }
    return null
  }

  private syncTiles(playing: boolean, rate: number) {
    for (const t of this.tiles) {
      const seg = this.segmentAt(t, this.masterMs)
      if (!seg) {
        if (!t.empty || t.pendingId) {
          t.empty = true
          t.pendingId = null
          t.video.pause()
          this.onTilesChanged?.()
        }
        continue
      }
      if (t.activeId !== seg.rec.id) {
        const media = useApp.getState().media[seg.rec.id]
        if (media?.status === 'ready' && media.url) {
          t.activeId = seg.rec.id
          t.pendingId = null
          t.empty = false
          this.onTilesChanged?.()
          t.video.src = media.url
          t.video.currentTime = seg.mediaT
        } else {
          if (t.pendingId !== seg.rec.id || t.empty) {
            t.activeId = null // don't keep drawing the previous segment's last frame
            t.pendingId = seg.rec.id
            t.empty = false
            t.video.pause()
            this.onTilesChanged?.()
          }
          void ensureMedia(seg.rec).catch(() => undefined)
          continue
        }
      }
      if (t.empty) {
        t.empty = false
        this.onTilesChanged?.()
      }
      const v = t.video
      if (v.readyState < 2) continue
      if (!playing) {
        if (!v.paused) v.pause()
        if (Math.abs(v.currentTime - seg.mediaT) > 0.04 && !v.seeking) v.currentTime = seg.mediaT
        continue
      }
      const a = driftCorrection(v.currentTime, seg.mediaT, rate)
      if (a.kind === 'seek' && !v.seeking) v.currentTime = a.seekTo!
      else if (a.rate) v.playbackRate = Math.max(0.0625, Math.min(16, a.rate))
      if (v.paused) void v.play().catch(() => undefined)
    }
  }

  // ---------- transport ----------

  play() {
    const s = useApp.getState()
    if (s.layout === 'single') {
      if (!this.single.src) return
      if (this.single.ended) this.single.currentTime = 0
      void this.single.play().catch(() => undefined)
    }
    this.lastTick = performance.now()
    useApp.setState({ playing: true })
  }

  pause() {
    this.single.pause()
    for (const t of this.tiles) t.video.pause()
    useApp.setState({ playing: false })
    this.finishPathRecording()
    this.finishZoomRecording()
    this.finishRedactFollow()
  }

  toggle() {
    if (useApp.getState().playing) this.pause()
    else this.play()
  }

  /** Seek: single = media seconds; grid = master epoch ms. */
  seek(t: number) {
    this.finishRedactFollow() // a jump would splice unrelated moments into the path
    const s = useApp.getState()
    if (s.layout === 'single') {
      const d = this.single.duration || s.duration
      this.single.currentTime = Math.max(0, Math.min(d || 0, t))
      useApp.setState({ time: this.single.currentTime })
    } else {
      this.masterMs = Math.max(this.span.startMs, Math.min(this.span.endMs, t))
      useApp.setState({ time: this.masterMs })
    }
    this.dirty = true
  }

  step(frames: number) {
    const s = useApp.getState()
    this.pause()
    if (s.layout === 'single') {
      const r = s.recordings.find((x) => x.id === this.singleId)
      const fps = r?.video?.fps || 15
      this.seek(this.single.currentTime + frames / fps)
    } else {
      this.seek(this.masterMs + (frames * 1000) / 15)
    }
  }

  jump(sec: number) {
    const s = useApp.getState()
    if (s.layout === 'single') this.seek(this.single.currentTime + sec)
    else this.seek(this.masterMs + sec * 1000)
  }

  setRate(r: number) {
    this.single.playbackRate = r
    useApp.setState({ rate: r })
  }

  currentMediaTime(): number {
    return this.single.currentTime || 0
  }

  // ---------- view path recording ----------

  startPathRecording() {
    this.recordingPath = []
    this.lastSample = -1
    if (!useApp.getState().playing) this.play()
  }

  get isRecordingPath() {
    return this.recordingPath !== null
  }

  finishPathRecording(): { tSec: number; value: PtzState }[] | null {
    const p = this.recordingPath
    this.recordingPath = null
    if (!p || !this.singleId) return null
    const id = this.singleId
    if (p.length >= 2) {
      void import('@shared/tracks').then(({ simplifyPath, sortKeyframes }) => {
        const simplified = simplifyPath(p)
        useApp.getState().updatePer(id, (x) => {
          // replace keyframes inside the recorded range, keep the rest
          const from = p[0].tSec
          const to = p[p.length - 1].tSec
          const kept = x.viewPath.filter((k) => k.tSec < from || k.tSec > to)
          return { ...x, viewPath: sortKeyframes([...kept, ...simplified]), followPath: true }
        })
      })
    }
    return p
  }

  // ---------- redaction: follow a subject while playing ----------

  /**
   * Start steering a redaction box by hand while the video plays (optionally slowed down). The box is
   * sampled every frame; on stop the samples are thinned to keyframes and replace that stretch of the track.
   */
  startRedactFollow(trackId: string, rate: number) {
    const id = this.singleId
    if (!id) return
    const tr = perFor(id).redactions.find((x) => x.id === trackId)
    if (!tr?.keyframes.length) return
    const t = this.currentMediaTime()
    const live = evalBox(sortKeyframes(tr.keyframes), t)
    if (!live) return
    this.following = { recId: id, trackId, samples: [{ tSec: t, value: { ...live } }], live: { ...live }, prevRate: useApp.getState().rate }
    this.lastSample = t
    this.setRate(rate)
    if (!useApp.getState().playing) this.play()
    this.onTilesChanged?.()
  }

  /** The box being followed right now (for the overlay and the drag handlers), if any. */
  get redactFollow(): { trackId: string; live: Box } | null {
    return this.following && this.following.recId === this.singleId ? { trackId: this.following.trackId, live: this.following.live } : null
  }

  setRedactLive(b: Box) {
    if (!this.following) return
    this.following.live = b
    this.dirty = true
  }

  finishRedactFollow() {
    const f = this.following
    if (!f) return
    this.following = null
    this.setRate(f.prevRate)
    const t = this.single.currentTime
    const last = f.samples[f.samples.length - 1]
    if (f.recId === this.singleId && t > last.tSec) f.samples.push({ tSec: t, value: { ...f.live } })
    if (f.samples.length >= 2) {
      const simplified = simplifyBoxPath(f.samples)
      const from = f.samples[0].tSec
      const to = f.samples[f.samples.length - 1].tSec
      useApp.getState().updatePer(f.recId, (x) => ({
        ...x,
        redactions: x.redactions.map((tr) => (tr.id === f.trackId ? { ...tr, keyframes: spliceKeyframes(tr.keyframes, from, to, simplified) } : tr))
      }))
    }
    this.onTilesChanged?.()
  }

  /** Redaction boxes to draw at t: the saved tracks, with the hand-steered box in place of its track. */
  private boxesAt(id: string, tracks: RedactionTrack[], t: number) {
    const f = this.following
    if (!f || f.recId !== id) return activeRedactions(tracks, t)
    return activeRedactions(tracks.map((tr) => (tr.id === f.trackId ? { ...tr, keyframes: [{ tSec: t, value: f.live }], range: 'all' as const } : tr)), t)
  }

  // ---------- zoom path recording ----------

  /** Aspect of the selected recording's zoom path (or the default for a new one). */
  zoomAspect(id: string): number {
    return perFor(id).zoomPath?.aspect ?? 16 / 9
  }

  /** The window the frame guide shows right now (what a keyframe or recording sample captures). */
  guideWindow(r: Recording): ZoomWindow | null {
    if (!r.video) return null
    return windowFromNormal(this.rawNormal(r.id, this.currentMediaTime()), r.video.width, r.video.height, this.cssViewport(), this.zoomAspect(r.id))
  }

  startZoomRecording() {
    this.recordingZoom = []
    this.lastSample = -1
    if (this.singleId) useApp.getState().updatePer(this.singleId, (x) => ({ ...x, followZoom: true }))
    if (!useApp.getState().playing) this.play()
  }

  get isRecordingZoom() {
    return this.recordingZoom !== null
  }

  finishZoomRecording() {
    const p = this.recordingZoom
    this.recordingZoom = null
    if (!p || !this.singleId || p.length < 2) return
    const id = this.singleId
    const simplified = simplifyZoomPath(p)
    useApp.getState().updatePer(id, (x) => {
      const aspect = x.zoomPath?.aspect ?? 16 / 9
      return { ...x, zoomPath: { aspect, keyframes: spliceKeyframes(x.zoomPath?.keyframes ?? [], p[0].tSec, p[p.length - 1].tSec, simplified) }, followZoom: true }
    })
  }

  /**
   * Live-view zoom for the raw view at time t: the zoom path when following it, else the user's own framing.
   * While recording, the user steers, so their framing wins.
   */
  rawNormal(id: string, t: number): NormalState {
    const per = perFor(id)
    const r = useApp.getState().recordings.find((x) => x.id === id)
    if (r?.video && per.zoomPath && per.followZoom && !this.recordingZoom && per.zoomPath.keyframes.length && useApp.getState().tool !== 'calibrate') {
      const w = evalZoom(per.zoomPath, t, r.video.width, r.video.height)
      if (w) return normalFromWindow(w, r.video.width, r.video.height, this.cssViewport(), per.zoomPath.aspect)
    }
    return per.view.normal
  }

  // ---------- loop ----------

  private tick(ts: number) {
    const s = useApp.getState()
    if (s.layout === 'grid') {
      if (s.playing) {
        const dt = this.lastTick ? ts - this.lastTick : 0
        this.masterMs += dt * s.rate
        if (this.masterMs >= this.span.endMs) {
          this.masterMs = this.span.endMs
          this.pause()
        }
        this.dirty = true
      }
      this.lastTick = ts
      this.syncTiles(s.playing, s.rate)
      if (ts - this.lastUi > 66) {
        this.lastUi = ts
        useApp.setState({ time: this.masterMs })
      }
    } else {
      const t = this.single.currentTime
      if (this.recordingPath && s.playing && this.singleId) {
        const per = perFor(this.singleId)
        if (t - this.lastSample >= 0.1) {
          this.recordingPath.push({ tSec: t, value: { ...per.view.ptz } })
          this.lastSample = t
        }
      }
      if (this.following && s.playing && t - this.lastSample >= 1 / 15) {
        this.following.samples.push({ tSec: t, value: { ...this.following.live } })
        this.lastSample = t
      }
      if (this.recordingZoom && s.playing && this.singleId && t - this.lastSample >= 0.1) {
        const r = s.recordings.find((x) => x.id === this.singleId)
        const w = r && this.guideWindow(r)
        if (w) this.recordingZoom.push({ tSec: t, value: w })
        this.lastSample = t
      }
      if (ts - this.lastUi > 50 && Math.abs(s.time - t) > 1e-3) {
        this.lastUi = ts
        useApp.setState({ time: t })
      }
    }
    if (this.dirty) {
      this.dirty = false
      this.draw()
    }
  }

  /** The view actually displayed for a recording at time t (path playback applied). */
  effectiveView(id: string, t: number): ViewState {
    const per = perFor(id)
    if (per.view.mode === 'ptz' && per.followPath && per.viewPath.length >= 2 && !this.recordingPath) {
      const p = evalPtz(per.viewPath, t)
      if (p) return { ...per.view, ptz: p }
    }
    return per.view
  }

  private draw() {
    const gl = this.gl
    if (!gl || !this.canvas) return
    const s = useApp.getState()
    gl.clear()
    const dpr = this.dpr
    const scaleVp = (v: Viewport): Viewport => ({ x: Math.round(v.x * dpr), y: Math.round(v.y * dpr), w: Math.round(v.w * dpr), h: Math.round(v.h * dpr) })
    if (s.layout === 'single') {
      const r = s.recordings.find((x) => x.id === this.singleId)
      if (!r?.video) return
      if (this.single.readyState < 2) {
        if (this.single.src && !this.single.error) this.dirty = true // try again next frame
        return
      }
      const per = perFor(r.id)
      const t = this.single.currentTime
      gl.uploadVideo(this.single, r.video.width, r.video.height)
      const raw = !per.fisheye || s.tool === 'calibrate'
      const view = raw || per.view.mode === 'normal' ? { ...per.view, mode: 'normal' as const, normal: this.rawNormal(r.id, t) } : this.effectiveView(r.id, t)
      drawView(gl, { srcW: r.video.width, srcH: r.video.height, view, calib: this.calibFor(r), boxes: this.boxesAt(r.id, per.redactions, t), redactOutside: per.redactOutside }, scaleVp(this.cssViewport()))
    } else {
      for (const tile of this.tiles) {
        if (tile.empty || !tile.activeId) continue
        if (tile.video.readyState < 2) {
          if (!tile.video.error) this.dirty = true // a tile is mid-seek; redraw next frame
          continue
        }
        const r = s.recordings.find((x) => x.id === tile.activeId)
        if (!r?.video) continue
        const per = perFor(r.id)
        gl.uploadVideo(tile.video, r.video.width, r.video.height)
        const view = per.fisheye ? per.view : { ...per.view, mode: 'normal' as const }
        drawView(gl, { srcW: r.video.width, srcH: r.video.height, view, calib: this.calibFor(r), boxes: activeRedactions(per.redactions, tile.video.currentTime), redactOutside: per.redactOutside }, scaleVp(tile.vp))
      }
    }
  }

  calibFor(r: Recording): Calibration {
    return useApp.getState().calibrations[cameraKey(r)] ?? defaultCalibration(r.video?.width ?? 1, r.video?.height ?? 1, 'ceiling')
  }

  invalidate() {
    this.dirty = true
  }

  /** Grab the current frame of the single video at reduced size (for circle detection). */
  grabFrame(maxSide = 1024): { data: Uint8ClampedArray; w: number; h: number; scale: number } | null {
    const v = this.single
    if (v.readyState < 2 || !v.videoWidth) return null
    const scale = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight))
    const w = Math.round(v.videoWidth * scale)
    const h = Math.round(v.videoHeight * scale)
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(v, 0, 0, w, h)
    return { data: ctx.getImageData(0, 0, w, h).data, w, h, scale }
  }

  autoDetectCircle(r: Recording): Calibration | null {
    const f = this.grabFrame()
    if (!f || !r.video) return null
    const res = detectCircle(f.data, f.w, f.h)
    const base = this.calibFor(r)
    if (!res.ok) return null
    return { ...base, cxPx: res.cx / f.scale, cyPx: res.cy / f.scale, radiusPx: res.r / f.scale }
  }

  /** Render the current view of the single recording at a given output size and return PNG bytes. */
  async snapshot(r: Recording, outW: number, outH: number): Promise<Uint8Array> {
    const v = this.single
    if (!r.video || v.readyState < 2) throw new Error('No frame to capture yet')
    const c = document.createElement('canvas')
    c.width = outW
    c.height = outH
    const g = new GLRenderer(c, { preserveDrawingBuffer: true })
    try {
      g.uploadVideo(v, r.video.width, r.video.height)
      g.clear()
      const per = perFor(r.id)
      const t = v.currentTime
      const view = per.fisheye && per.view.mode !== 'normal' ? this.effectiveView(r.id, t) : { ...per.view, mode: 'normal' as const, normal: this.rawNormal(r.id, t) }
      const snapView: ViewState = view.mode === 'normal' ? snapNormal(view, r.video.width, r.video.height, outW, outH, this.cssViewport()) : view
      drawView(g, { srcW: r.video.width, srcH: r.video.height, view: snapView, calib: this.calibFor(r), boxes: this.boxesAt(r.id, per.redactions, t), redactOutside: per.redactOutside }, { x: 0, y: 0, w: outW, h: outH })
      const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), 'image/png'))
      return new Uint8Array(await blob.arrayBuffer())
    } finally {
      g.dispose()
    }
  }

  clampPtzFor(r: Recording, p: PtzState): PtzState {
    const c = this.calibFor(r)
    return clampPtz(p, c.mount, c.fovDeg)
  }
}

/**
 * The on-screen normal view (fit to the viewport) re-expressed for an output of a different aspect:
 * keep the same visible source region.
 */
export function snapNormal(view: ViewState, srcW: number, srcH: number, outW: number, outH: number, screen: Viewport): ViewState {
  const fitScreen = Math.min(screen.w / srcW, screen.h / srcH) * view.normal.zoom
  const visW = screen.w / fitScreen
  const fitOut = Math.min(outW / srcW, outH / srcH)
  const zoom = outW / visW / fitOut
  return { ...view, normal: { ...view.normal, zoom } }
}

/** Visible source region of the normal view on screen (clamped to the frame). */
export function visibleRegion(view: ViewState, srcW: number, srcH: number, screen: Viewport) {
  const scale = Math.min(screen.w / srcW, screen.h / srcH) * view.normal.zoom
  const w = Math.min(srcW, screen.w / scale)
  const h = Math.min(srcH, screen.h / scale)
  const cx = view.normal.centerX * srcW
  const cy = view.normal.centerY * srcH
  return { x: Math.max(0, cx - w / 2), y: Math.max(0, cy - h / 2), w, h }
}

export const player = new Player()
