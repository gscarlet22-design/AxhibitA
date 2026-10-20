import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { MAX_SCAN_DEPTH, SUPPORTED_EXTENSIONS } from '../shared/constants'
import { keyframeProbeArgs, parseKeyframes } from '../shared/ffmpeg/args'
import { encoderSmokeTestArgs, parseEncoderList, type H264Encoder } from '../shared/ffmpeg/encoders'
import { deriveRecordingMeta, probeArgs } from '../shared/ffmpeg/probe'
import type { Recording } from '../shared/types'
import type { JobContext } from './jobs'
import { log } from './log'
import { ffmpegPath, ffprobePath, runCapture } from './proc'
import { getStore } from './store'

const recordings = new Map<string, Recording>()
const byPath = new Map<string, string>()
const keyframeCache = new Map<string, number[]>()

export function getRecording(id: string): Recording {
  const r = recordings.get(id)
  if (!r) throw new Error('Unknown recording')
  return r
}

async function walk(p: string, depth: number, out: string[]): Promise<void> {
  let st
  try {
    st = await stat(p)
  } catch {
    return
  }
  if (st.isFile()) {
    if (SUPPORTED_EXTENSIONS.includes(extname(p).toLowerCase())) out.push(p)
    return
  }
  if (!st.isDirectory() || depth > MAX_SCAN_DEPTH) return
  let entries: string[] = []
  try {
    entries = await readdir(p)
  } catch {
    return
  }
  for (const e of entries.sort()) await walk(join(p, e), depth + 1, out)
}

/** Scan paths (files or folders) and probe each supported media file. */
export async function openPaths(paths: string[]): Promise<Recording[]> {
  const files: string[] = []
  for (const p of paths) await walk(p, 0, files)
  const out: Recording[] = []
  const queue = [...new Set(files)]
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const f = queue.shift()!
      out.push(await probeOne(f))
    }
  })
  await Promise.all(workers)
  const recent = getStore().get('recent').filter((r) => !paths.includes(r))
  getStore().set('recent', [...paths, ...recent].slice(0, 10))
  return out.sort((a, b) => (a.cameraName ?? '').localeCompare(b.cameraName ?? '') || (a.wallClockStart ?? '').localeCompare(b.wallClockStart ?? ''))
}

async function probeOne(path: string): Promise<Recording> {
  const existing = byPath.get(path)
  const st = await stat(path)
  const file = { path, fileName: basename(path), sizeBytes: st.size, modifiedAt: st.mtime.toISOString(), parentDir: basename(dirname(path)) }
  const id = existing ?? randomUUID()
  try {
    const json = JSON.parse(await runCapture(ffprobePath(), probeArgs(path)))
    const meta = deriveRecordingMeta(json, file)
    if (!meta.video) throw new Error('No video stream')
    const rec: Recording = { ...meta, id }
    recordings.set(id, rec)
    byPath.set(path, id)
    return rec
  } catch (err) {
    const rec: Recording = {
      ...file, id, container: extname(path).slice(1), durationSec: 0, tags: {}, wallClockSource: 'unavailable', wallClockApprox: false,
      cameraNameSource: 'unavailable', cameraName: file.parentDir, startTimeSec: 0,
      error: err instanceof Error ? err.message.split('\n')[0] : String(err)
    }
    recordings.set(id, rec)
    byPath.set(path, id)
    log(`probe failed ${path}: ${rec.error}`)
    return rec
  }
}

export async function keyframes(id: string): Promise<number[]> {
  const r = getRecording(id)
  const cached = keyframeCache.get(r.path)
  if (cached) return cached
  const csv = await runCapture(ffprobePath(), keyframeProbeArgs(r.path))
  const k = parseKeyframes(csv).map((t) => t - r.startTimeSec)
  keyframeCache.set(r.path, k)
  return k
}

/** Streamed SHA-256 with a cache keyed by path + size + mtime. */
export async function sha256File(id: string, ctx?: JobContext): Promise<string> {
  const r = getRecording(id)
  const st = await stat(r.path)
  const key = `${r.path}|${st.size}|${st.mtimeMs}`
  const cache = getStore().getExtra<Record<string, string>>('hashCache') ?? {}
  if (cache[key]) return cache[key]
  const h = await hashPath(r.path, ctx, st.size)
  cache[key] = h
  const keys = Object.keys(cache)
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete cache[k]
  getStore().setExtra('hashCache', cache)
  return h
}

export function hashPath(path: string, ctx?: JobContext, size?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    let done = 0
    const s = createReadStream(path, { flags: 'r', highWaterMark: 4 * 1024 * 1024 })
    ctx?.onCancel(() => s.destroy(new Error('Cancelled')))
    s.on('data', (c) => {
      h.update(c)
      done += c.length
      if (ctx && size) ctx.progress(done / size)
    })
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

let encoderInfo: Promise<{ list: H264Encoder[]; working: H264Encoder[] }> | null = null
let ffmpegVersion = 'unknown'

/** Detect H.264 encoders and prove each works with a tiny test encode. */
export function detectEncoders(): Promise<{ list: H264Encoder[]; working: H264Encoder[] }> {
  // one detection per run, shared by concurrent callers (app info, first export)
  encoderInfo ??= runDetectEncoders()
  return encoderInfo
}

async function runDetectEncoders(): Promise<{ list: H264Encoder[]; working: H264Encoder[] }> {
  try {
    const v = await runCapture(ffmpegPath(), ['-hide_banner', '-version'])
    ffmpegVersion = (/ffmpeg version (\S+)/.exec(v)?.[1] ?? 'unknown').slice(0, 60)
    const list = parseEncoderList(await runCapture(ffmpegPath(), ['-hide_banner', '-encoders']))
    const working: H264Encoder[] = []
    for (const e of list) {
      try {
        await runCapture(ffmpegPath(), encoderSmokeTestArgs(e))
        working.push(e)
      } catch {
        /* listed but unusable on this machine */
      }
    }
    log(`ffmpeg ${ffmpegVersion}; encoders listed ${list.join(',')} working ${working.join(',')}`)
    return { list, working }
  } catch (err) {
    log(`encoder detection failed: ${String(err)}`)
    return { list: [], working: [] }
  }
}

export function getFfmpegVersion(): string {
  return ffmpegVersion
}

export async function chooseEncoder(): Promise<H264Encoder> {
  const { working } = await detectEncoders()
  const override = getStore().get('settings').encoderOverride as H264Encoder | null
  if (override && working.includes(override)) return override
  if (!working.length) throw new Error('No working H.264 encoder found in FFmpeg on this computer.')
  return working[0]
}
