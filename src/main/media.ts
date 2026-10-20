import { createReadStream, existsSync, statSync } from 'node:fs'
import { readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { MEDIA_SCHEME } from '../shared/constants'
import { proxyArgs, remuxArgsFor, thumbnailArgs, thumbnailTime } from '../shared/ffmpeg/args'
import type { JobContext } from './jobs'
import { chooseEncoder, getRecording } from './library'
import { log } from './log'
import { cacheDir } from './paths'
import { ffmpegPath, runCapture, runFfmpegWithProgress } from './proc'
import { getStore } from './store'

/** token → absolute file path. Only files registered here are served. */
const served = new Map<string, string>()

export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }
  ])
}

const MIME: Record<string, string> = { mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm' }

/** Serve cache files with HTTP range support (required for seeking). */
export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (req) => {
    const url = new URL(req.url)
    const token = url.pathname.replace(/^\/+/, '')
    const path = served.get(token)
    if (!path || !existsSync(path)) return new Response('Not found', { status: 404 })
    const size = statSync(path).size
    const type = MIME[path.split('.').pop() ?? ''] ?? 'application/octet-stream'
    const range = req.headers.get('range')
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      let start = m && m[1] ? Number(m[1]) : 0
      let end = m && m[2] ? Number(m[2]) : size - 1
      if (m && !m[1] && m[2]) {
        start = size - Number(m[2])
        end = size - 1
      }
      end = Math.min(end, size - 1)
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
      return new Response(stream, {
        status: 206,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' }
      })
    }
    const stream = Readable.toWeb(createReadStream(path)) as ReadableStream
    return new Response(stream, { status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } })
  })
}

function cacheKey(path: string, size: number, mtimeMs: number, kind: string): string {
  const s = `${path}|${size}|${mtimeMs}|${kind}`
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0
  return `${kind}-${h.toString(16)}-${size.toString(16)}`
}

/** Remux (lossless) or proxy-transcode a recording into the cache and return a playable URL. */
export async function prepareMedia(id: string, needProxy: boolean, ctx: JobContext): Promise<string> {
  const r = getRecording(id)
  if (!r.video) throw new Error('No video stream')
  const st = await stat(r.path)
  const kind = needProxy ? 'proxy' : 'remux'
  const out = join(cacheDir(), cacheKey(r.path, st.size, st.mtimeMs, kind) + '.mp4')
  if (!existsSync(out)) {
    const tmp = out.replace(/\.mp4$/, `.part-${Date.now()}.mp4`)
    try {
      const hasAudio = !!r.audio
      const args = needProxy
        ? proxyArgs(r.path, tmp, await chooseEncoder(), r.video.width, r.video.height, r.video.fps || 15, hasAudio)
        : remuxArgsFor(r.video.codec, r.path, tmp, hasAudio)
      await runFfmpegWithProgress(args, r.durationSec, ctx)
      await rename(tmp, out)
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
    void enforceCacheLimit()
  } else {
    const now = new Date()
    await utimes(out, now, now).catch(() => undefined) // LRU touch (cache file only)
  }
  const token = `${id}-${kind}`
  served.set(token, out)
  return `${MEDIA_SCHEME}://media/${token}`
}

const thumbs = new Map<string, Promise<string | null>>()
let thumbActive = 0
const thumbWaiters: (() => void)[] = []

/**
 * Library thumbnail as a data URL, cached in the cache dir (keyed by path + size + mtime, so a changed
 * file gets a new one). Two grabs at a time so opening a large export doesn't flood the disk. null when
 * the frame can't be read; the library then keeps its placeholder.
 */
export function thumbnail(id: string): Promise<string | null> {
  const existing = thumbs.get(id)
  if (existing) return existing
  const p = (async () => {
    const r = getRecording(id)
    if (!r.video) return null
    const st = await stat(r.path)
    const out = join(cacheDir(), cacheKey(r.path, st.size, st.mtimeMs, 'thumb') + '.jpg')
    if (!existsSync(out)) {
      while (thumbActive >= 2) await new Promise<void>((res) => thumbWaiters.push(res))
      thumbActive++
      const tmp = out.replace(/\.jpg$/, `.part-${Date.now()}.jpg`)
      try {
        await runCapture(ffmpegPath(), thumbnailArgs(r.path, tmp, thumbnailTime(r.durationSec, r.startTimeSec)))
        await rename(tmp, out)
      } catch (err) {
        await rm(tmp, { force: true })
        log(`thumbnail failed for ${r.fileName}: ${String(err).slice(0, 200)}`)
        return null
      } finally {
        thumbActive--
        thumbWaiters.shift()?.()
      }
    }
    return `data:image/jpeg;base64,${(await readFile(out)).toString('base64')}`
  })()
  thumbs.set(id, p)
  return p
}

export async function enforceCacheLimit(): Promise<void> {
  try {
    const limit = getStore().get('settings').cacheLimitGb * 1024 ** 3
    const dir = cacheDir()
    const files = await Promise.all(
      (await readdir(dir)).map(async (f) => {
        const p = join(dir, f)
        const s = await stat(p)
        return { p, size: s.size, at: s.mtimeMs }
      })
    )
    let total = files.reduce((a, f) => a + f.size, 0)
    const inUse = new Set(served.values())
    for (const f of files.sort((a, b) => a.at - b.at)) {
      if (total <= limit) break
      if (inUse.has(f.p)) continue
      await rm(f.p, { force: true })
      total -= f.size
    }
  } catch (err) {
    log(`cache cleanup failed: ${String(err)}`)
  }
}
