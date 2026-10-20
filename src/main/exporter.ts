import { app, BrowserWindow, MessageChannelMain, type MessagePortMain } from 'electron'
import { existsSync } from 'node:fs'
import { rename, rm, stat, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { even, fastTrimArgs, keyframeAtOrBefore, renderDecodeArgs, renderEncodeArgs } from '../shared/ffmpeg/args'
import { sanitizeStem, uniqueStem } from '../shared/files'
import type { ExportRequest, ExportResult, RenderSpec, SnapshotRequest } from '../shared/ipc'
import { planFromFootprint, sampleTimes, viewFootprint } from '../shared/export/footprint'
import { maxUpscale } from '../shared/zoom'
import { buildManifest } from '../shared/manifest/build'
import type { Operation } from '../shared/manifest/schema'
import { toLocalIso, wallClockAt } from '../shared/time'
import type { Box, MediaInfo } from '../shared/types'
import type { JobContext } from './jobs'
import { chooseEncoder, getFfmpegVersion, getRecording, hashPath, keyframes, sha256File } from './library'
import { log } from './log'
import { ffmpegPath, killTree, lastLines, runFfmpegWithProgress, spawn, WIN_OPTS } from './proc'
import { getStore } from './store'
import { getSignedResult } from './verify'

const MANIFEST_SUFFIX = '.manifest.json'

function osUser(): string {
  try {
    return userInfo().username
  } catch {
    return 'unknown'
  }
}

function resolveOutput(dir: string, stem: string, ext: string): { out: string; manifest: string } {
  const s = uniqueStem(sanitizeStem(stem), [ext, ext + MANIFEST_SUFFIX, '.partial' + ext], (f) => existsSync(join(dir, f)))
  return { out: join(dir, s + ext), manifest: join(dir, s + ext + MANIFEST_SUFFIX) }
}

/** Guard: outputs must never land on top of a source file. */
function assertNotSource(out: string, src: string) {
  if (out.toLowerCase() === src.toLowerCase()) throw new Error('Refusing to write over the source file')
}

function wall(src: MediaInfo, t: number): string | null {
  const d = wallClockAt(src.wallClockStart, t)
  return d ? toLocalIso(d) : null
}

function viewOperations(req: ExportRequest, srcW: number, srcH: number): Operation[] {
  const ops: Operation[] = []
  const v = req.view
  if (v.kind === 'crop') ops.push({ type: 'crop', rect: v.rect })
  if (v.kind === 'current') {
    if (v.view.mode === 'normal') {
      if (v.view.normal.zoom !== 1 || v.view.normal.centerX !== 0.5 || v.view.normal.centerY !== 0.5) ops.push({ type: 'digital_zoom', view: { ...v.view.normal } })
    } else {
      const mode = v.view.mode
      const view = mode === 'ptz' ? v.view.ptz : mode === 'quad' ? v.view.quad : v.view.pano
      ops.push({ type: 'dewarp', mode, calibration: { ...(v.calib ?? {}) }, view })
    }
  }
  if (v.kind === 'view-path') ops.push({ type: 'dewarp', mode: 'view_path', calibration: { ...v.calib }, view: { keyframes: v.keyframes } })
  if (v.kind === 'zoom-path') {
    const times = sampleTimes(v.path.keyframes.map((k) => k.tSec), req.inSec, req.outSec)
    ops.push({
      type: 'zoom_path',
      aspect: v.path.aspect,
      keyframes: v.path.keyframes.map((k) => ({ tSec: k.tSec, cxPx: k.value.cxPx, cyPx: k.value.cyPx, hPx: k.value.hPx })),
      interpolation: 'window height in log space, center linear in source px, ease-in-out; window clamped inside the frame; held before the first and after the last keyframe',
      maxUpscale: Math.round(maxUpscale(v.path, even(req.outH), times, srcW, srcH) * 1000) / 1000
    })
  }
  const red = req.redactions.filter((r) => r.enabled && r.keyframes.length)
  if (red.length) ops.push({ type: 'redaction', tracks: red })
  if (req.overlay.timestamp || req.overlay.cameraName || req.overlay.customText) {
    ops.push({ type: 'overlay', timestamp: req.overlay.timestamp, cameraName: req.overlay.cameraName, customText: req.overlay.customText })
  }
  return ops
}

/** Whether a request can use stream copy (no pixel changes at all). */
export function canFastTrim(req: ExportRequest): boolean {
  const pixelOps = viewOperations(req, 1, 1).length > 0
  return req.trimMode === 'fast' && req.view.kind === 'original' && !pixelOps
}

export async function exportClip(req: ExportRequest, ctx: JobContext): Promise<ExportResult> {
  const src = getRecording(req.recordingId)
  if (!src.video) throw new Error('No video stream')
  if (!(req.outSec > req.inSec)) throw new Error('Out point must be after in point')
  if (req.view.kind === 'zoom-path') {
    if (!req.view.path.keyframes.length) throw new Error('The zoom path has no keyframes')
    if (Math.abs(even(req.outW) / even(req.outH) - req.view.path.aspect) > 0.01) throw new Error('Output size must match the zoom path aspect ratio')
  }
  const { out, manifest } = resolveOutput(req.outputDir, req.fileStem, '.mp4')
  assertNotSource(out, src.path)
  // Encode into a temporary name so an interrupted export never leaves a plausible-looking clip behind.
  const partial = out.replace(/\.mp4$/, '.partial.mp4')

  ctx.progress(0, 'Hashing source')
  const srcHash = await sha256File(src.id)
  const ops: Operation[] = []
  const argsLog: string[][] = []
  let encoderName: string | null = null
  let outW = src.video.width
  let outH = src.video.height
  let actualIn = req.inSec
  let actualOut = req.outSec
  const fps = src.video.fps > 0 ? Math.round(src.video.fps * 1000) / 1000 : 15

  try {
    if (canFastTrim(req)) {
      const keys = await keyframes(src.id)
      actualIn = keyframeAtOrBefore(keys, req.inSec)
      const args = fastTrimArgs({ src: src.path, out: partial, inSec: actualIn + src.startTimeSec, durSec: req.outSec - actualIn, includeAudio: req.includeAudio && !!src.audio })
      argsLog.push(args)
      ctx.progress(0.02, 'Copying')
      await runFfmpegWithProgress(args, req.outSec - actualIn, ctx)
    } else {
      const enc = await chooseEncoder()
      encoderName = enc
      outW = even(req.outW)
      outH = even(req.outH)
      const { decodeArgs, encodeArgs } = await renderPipeline(req, src, enc, fps, partial, ctx)
      argsLog.push(decodeArgs, encodeArgs)
      ops.push({ type: 'encode', videoCodec: 'h264', encoder: enc, normalizedFps: fps, audio: req.includeAudio && src.audio ? 'aac 128k' : null })
    }
    await rename(partial, out)
  } catch (err) {
    await rm(partial, { force: true })
    throw err
  }
  // the manifest records the final file name, not the temporary one
  for (const a of argsLog) {
    const i = a.indexOf(partial)
    if (i >= 0) a[i] = out
  }

  ops.unshift(...viewOperations(req, src.video.width, src.video.height))
  ops.unshift({
    type: 'trim',
    mode: canFastTrim(req) ? 'fast' : 'exact',
    requestedInSec: req.inSec,
    requestedOutSec: req.outSec,
    actualInSec: actualIn,
    actualOutSec: actualOut,
    wallClockIn: wall(src, actualIn),
    wallClockOut: wall(src, actualOut)
  })

  try {
    ctx.progress(0.99, 'Writing manifest')
    const st = await stat(out)
    const outHash = await hashPath(out)
    const m = buildManifest({
      appVersion: app.getVersion(),
      ffmpegVersion: getFfmpegVersion(),
      encoder: encoderName,
      createdAt: new Date(),
      osUser: osUser(),
      operatorName: getStore().get('settings').operatorName || null,
      source: src,
      sourceSha256: srcHash,
      signedVideo: getSignedResult(src.id),
      operations: ops,
      ffmpegArgs: argsLog,
      output: { fileName: out.split(/[\\/]/).pop()!, sizeBytes: st.size, sha256: outHash, width: outW, height: outH, fps, durationSec: actualOut - actualIn },
      notes: req.notes
    })
    await writeFile(manifest, JSON.stringify(m, null, 2), { encoding: 'utf8', flag: 'wx' })
  } catch (err) {
    await rm(out, { force: true })
    await rm(manifest, { force: true })
    throw err
  }
  return { outputPath: out, manifestPath: manifest }
}

/** Decide what the decoder should hand the renderer: the source region needed and at what size. */
export function planDecode(req: ExportRequest, srcW: number, srcH: number): { rect: Box; decW: number; decH: number } {
  const full: Box = { x: 0, y: 0, w: srcW, h: srcH }
  const cap = (r: Box, maxPixels: number) => {
    const scale = Math.min(1, Math.sqrt(maxPixels / (r.w * r.h)))
    return { rect: r, decW: even(r.w * scale), decH: even(r.h * scale) }
  }
  if (req.view.kind === 'original') return cap(full, Math.max(req.outW * req.outH * 2, 1))
  // Decode only the region the view samples, at only the detail it needs (frames cross IPC as RGBA, so
  // pixels decoded are the main export cost). Redaction boxes are in source px and the shader offsets by
  // srcRect, so cropping is safe with redactions; the pad covers pixelate/blur sampling at the crop edge.
  const fp = viewFootprint(req.view, srcW, srcH, even(req.outW), even(req.outH), req.inSec, req.outSec)
  const p = planFromFootprint(fp, srcW, srcH, 12e6, req.redactions.length ? 64 : 16)
  return { rect: p.rect, decW: even(p.rect.w * p.scale), decH: even(p.rect.h * p.scale) }
}

interface PipelineResult {
  decodeArgs: string[]
  encodeArgs: string[]
}

async function renderPipeline(req: ExportRequest, src: MediaInfo, enc: Parameters<typeof renderEncodeArgs>[0]['enc'], fps: number, out: string, ctx: JobContext): Promise<PipelineResult> {
  const v = src.video!
  const dur = req.outSec - req.inSec
  const plan = planDecode(req, v.width, v.height)
  const outW = even(req.outW)
  const outH = even(req.outH)
  const vf: string[] = []
  const decodeBase = renderDecodeArgs({ src: src.path, inSec: req.inSec + src.startTimeSec, durSec: dur, fps })
  // insert crop + scale ahead of the fps/format filters when we decode a sub-region or downscale
  const vfIndex = decodeBase.indexOf('-vf') + 1
  if (plan.rect.x !== 0 || plan.rect.y !== 0 || plan.rect.w !== v.width || plan.rect.h !== v.height) vf.push(`crop=${plan.rect.w}:${plan.rect.h}:${plan.rect.x}:${plan.rect.y}`)
  if (plan.decW !== plan.rect.w || plan.decH !== plan.rect.h) vf.push(`scale=${plan.decW}:${plan.decH}:flags=bicubic`)
  decodeBase[vfIndex] = [...vf, decodeBase[vfIndex]].join(',')
  const decodeArgs = decodeBase
  const encodeArgs = renderEncodeArgs({ src: src.path, out, inSec: req.inSec + src.startTimeSec, durSec: dur, w: outW, h: outH, fps, enc, includeAudio: req.includeAudio && !!src.audio })

  const spec: RenderSpec = {
    srcW: v.width,
    srcH: v.height,
    srcRect: plan.rect,
    decW: plan.decW,
    decH: plan.decH,
    outW,
    outH,
    fps,
    inSec: req.inSec,
    view: req.view,
    redactions: req.redactions,
    overlay: req.overlay,
    cameraName: src.cameraName ?? null,
    wallClockStart: src.wallClockStart ?? null,
    wallClockApprox: src.wallClockApprox
  }

  const totalFrames = Math.max(1, Math.round(dur * fps))
  const win = await openRenderWindow()
  const { port1, port2 } = new MessageChannelMain()
  win.webContents.postMessage('render:port', null, [port2])
  port1.start()

  log(`render decode ${JSON.stringify(decodeArgs)}`)
  log(`render encode ${JSON.stringify(encodeArgs)}`)
  const decoder = spawn(ffmpegPath(), decodeArgs, { ...WIN_OPTS, stdio: ['ignore', 'pipe', 'pipe'] })
  const encoder = spawn(ffmpegPath(), encodeArgs, { ...WIN_OPTS, stdio: ['pipe', 'ignore', 'pipe'] })
  const decErr: string[] = []
  const encErr: string[] = []
  decoder.stderr!.on('data', (d: Buffer) => decErr.push(d.toString()))
  encoder.stderr!.on('data', (d: Buffer) => encErr.push(d.toString()))

  const cleanup = () => {
    killTree(decoder)
    killTree(encoder)
    try {
      port1.close()
    } catch {
      /* ignore */
    }
    if (!win.isDestroyed()) win.destroy()
  }
  ctx.onCancel(cleanup)

  try {
    log('render: waiting for renderer ready')
    await sendAndWait(port1, { type: 'init', spec }, 'ready', 15000)
    log(`render: renderer ready; decode ${plan.rect.w}x${plan.rect.h}+${plan.rect.x}+${plan.rect.y} at ${plan.decW}x${plan.decH} -> ${outW}x${outH}`)
    const frameBytes = plan.decW * plan.decH * 4
    let chunks: Buffer[] = []
    let chunkBytes = 0
    let index = 0
    let decoderDone = false
    let decoderExit: number | null = null

    const frames: Buffer[] = []
    let wake: (() => void) | null = null
    decoder.stdout!.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      chunkBytes += chunk.length
      // assemble whole frames with a single copy each (avoid quadratic re-concatenation)
      while (chunkBytes >= frameBytes) {
        const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, chunkBytes)
        frames.push(Buffer.from(all.subarray(0, frameBytes)))
        const rest = all.subarray(frameBytes)
        chunks = rest.length ? [Buffer.from(rest)] : []
        chunkBytes = rest.length
      }
      if (frames.length >= 3) decoder.stdout!.pause()
      wake?.()
    })
    decoder.on('close', (code) => {
      decoderDone = true
      decoderExit = code
      wake?.()
    })
    const encoderClosed = new Promise<number | null>((res) => encoder.on('close', (c) => res(c)))

    // Keep two frames in flight so the copy into the renderer overlaps with rendering/readback of the previous one.
    const renderer = new FramePipe(port1)
    const inFlight: Promise<Msg>[] = []
    let sent = 0
    const t0 = Date.now()
    let waitDecode = 0
    let waitRender = 0
    let waitEncode = 0
    const writeOne = async () => {
      const a = Date.now()
      const rendered = await inFlight.shift()!
      waitRender += Date.now() - a
      const data = rendered.data as Uint8Array
      if (data.byteLength !== outW * outH * 4) throw new Error('Renderer returned a frame of the wrong size')
      const b = Date.now()
      const ok = encoder.stdin!.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
      if (!ok) await new Promise<void>((r) => encoder.stdin!.once('drain', () => r()))
      waitEncode += Date.now() - b
      index++
      ctx.progress(Math.min(0.98, index / totalFrames), `Rendering frame ${index}/${totalFrames}`)
    }
    try {
      while (true) {
        if (ctx.signal.aborted) throw new Error('Cancelled')
        if (!frames.length) {
          if (decoderDone) break
          const a = Date.now()
          await new Promise<void>((r) => {
            wake = r
          })
          waitDecode += Date.now() - a
          wake = null
          continue
        }
        const frame = frames.shift()!
        if (frames.length < 2) decoder.stdout!.resume()
        const t = req.inSec + sent / fps
        const job = renderer.render(sent, t, new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength))
        job.catch(() => undefined) // surfaced when awaited; avoid unhandled rejections if we bail out early
        inFlight.push(job)
        sent++
        if (inFlight.length >= 2) await writeOne()
      }
      while (inFlight.length) await writeOne()
    } finally {
      renderer.close()
    }
    const secs = (Date.now() - t0) / 1000
    log(`render: ${index} frames in ${secs.toFixed(1)} s (${(index / Math.max(secs, 1e-3)).toFixed(1)} fps); waited decode ${waitDecode} ms, render ${waitRender} ms, encode ${waitEncode} ms`)
    if (decoderExit !== 0 && decoderExit !== null) throw new Error('Decoder failed: ' + lastLines(decErr.join(''), 20))
    if (index === 0) throw new Error('No frames decoded in the selected range')
    encoder.stdin!.end()
    const code = await encoderClosed
    if (code !== 0) throw new Error('Encoder failed: ' + lastLines(encErr.join(''), 30))
  } finally {
    cleanup()
  }
  return { decodeArgs, encodeArgs }
}

let renderWindowUrl: { dev?: string; file: string } | null = null
export function configureRenderWindow(u: { dev?: string; file: string }) {
  renderWindowUrl = u
}

async function openRenderWindow(): Promise<BrowserWindow> {
  if (!renderWindowUrl) throw new Error('Render window not configured')
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: false,
      backgroundThrottling: false
    }
  })
  win.webContents.on('console-message', (e) => log(`render-window: ${(e as unknown as { message: string }).message}`))
  win.webContents.on('render-process-gone', (_e, d) => log(`render-window gone: ${d.reason}`))
  if (renderWindowUrl.dev) await win.loadURL(renderWindowUrl.dev)
  else await win.loadFile(renderWindowUrl.file)
  return win
}

type Msg = { type: string; [k: string]: unknown }

/** Frame requests to the export renderer, matched to replies by index so several can be in flight. */
class FramePipe {
  private pending = new Map<number, { resolve: (m: Msg) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private onMsg = (e: Electron.MessageEvent) => {
    const d = e.data as Msg
    if (d.type === 'error') {
      // the renderer handles frames in order, so an error belongs to the oldest pending frame; fail them all
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error(String(d.message)))
      }
      this.pending.clear()
    } else if (d.type === 'frame') {
      const p = this.pending.get(d.index as number)
      if (!p) return
      clearTimeout(p.timer)
      this.pending.delete(d.index as number)
      p.resolve(d)
    }
  }

  constructor(private port: MessagePortMain) {
    port.on('message', this.onMsg)
  }

  render(index: number, t: number, data: Uint8Array): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(index)
        reject(new Error('Renderer timed out waiting for frame'))
      }, 30000)
      this.pending.set(index, { resolve, reject, timer })
      this.port.postMessage({ type: 'frame', index, t, data })
    })
  }

  close() {
    this.port.removeListener('message', this.onMsg)
    for (const p of this.pending.values()) clearTimeout(p.timer)
    this.pending.clear()
  }
}

function sendAndWait(port: MessagePortMain, msg: Msg, expect: string, timeoutMs: number): Promise<Msg> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      port.removeListener('message', onMsg)
      reject(new Error(`Renderer timed out waiting for ${expect}`))
    }, timeoutMs)
    const onMsg = (e: Electron.MessageEvent) => {
      const d = e.data as Msg
      if (d.type === 'error') {
        clearTimeout(timer)
        port.removeListener('message', onMsg)
        reject(new Error(String(d.message)))
      } else if (d.type === expect) {
        clearTimeout(timer)
        port.removeListener('message', onMsg)
        resolve(d)
      }
    }
    port.on('message', onMsg)
    port.postMessage(msg)
  })
}

export async function exportSnapshot(req: SnapshotRequest): Promise<ExportResult> {
  const src = getRecording(req.recordingId)
  const { out, manifest } = resolveOutput(req.outputDir, req.fileStem, '.png')
  assertNotSource(out, src.path)
  const srcHash = await sha256File(src.id)
  await writeFile(out, Buffer.from(req.png), { flag: 'wx' })
  try {
    const ops: Operation[] = [{ type: 'snapshot', mediaTimeSec: req.mediaTimeSec, wallClock: wall(src, req.mediaTimeSec) }]
    if (req.view.mode !== 'normal') {
      const mode = req.view.mode
      ops.push({ type: 'dewarp', mode, calibration: { ...(req.calib ?? {}) }, view: mode === 'ptz' ? req.view.ptz : mode === 'quad' ? req.view.quad : req.view.pano })
    } else if (req.view.normal.zoom !== 1) {
      ops.push({ type: 'digital_zoom', view: { ...req.view.normal } })
    }
    const red = req.redactions.filter((r) => r.enabled && r.keyframes.length)
    if (red.length) ops.push({ type: 'redaction', tracks: red })
    const st = await stat(out)
    const m = buildManifest({
      appVersion: app.getVersion(),
      ffmpegVersion: getFfmpegVersion(),
      encoder: null,
      createdAt: new Date(),
      osUser: osUser(),
      operatorName: getStore().get('settings').operatorName || null,
      source: src,
      sourceSha256: srcHash,
      signedVideo: getSignedResult(src.id),
      operations: ops,
      ffmpegArgs: null,
      output: { fileName: out.split(/[\\/]/).pop()!, sizeBytes: st.size, sha256: await hashPath(out), width: req.width, height: req.height, fps: null, durationSec: null },
      notes: req.notes
    })
    await writeFile(manifest, JSON.stringify(m, null, 2), { encoding: 'utf8', flag: 'wx' })
  } catch (err) {
    await rm(out, { force: true })
    await rm(manifest, { force: true })
    throw err
  }
  return { outputPath: out, manifestPath: manifest }
}
