/**
 * Pure FFmpeg argument builders. Always arrays; never shell strings.
 * Exports always read the ORIGINAL source path (never cache/proxy).
 */
import { encoderOptions, type H264Encoder } from './encoders'

const BASE = ['-nostdin', '-hide_banner', '-loglevel', 'error']
const num = (n: number) => (Math.round(n * 1e6) / 1e6).toString()

/** Library thumbnail: one frame, `height` px tall, JPEG into the cache (source is only read). */
export function thumbnailArgs(src: string, out: string, atSec: number, height = 144): string[] {
  return [...BASE, '-n', '-ss', num(Math.max(0, atSec)), '-i', src, '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=-2:${height}:flags=bicubic`, '-q:v', '5', '-f', 'image2', out]
}

/** Where to grab a thumbnail: a moment in, past any black/blank opening frames, but within short clips. */
export function thumbnailTime(durationSec: number, startTimeSec = 0): number {
  return startTimeSec + Math.min(2, Math.max(0, durationSec) * 0.1)
}

/** Lossless remux to a seekable MP4 in the cache (for playback only). */
export function remuxArgs(src: string, out: string, hasAudio: boolean): string[] {
  return [
    ...BASE, '-n', '-i', src,
    '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0?'] : []),
    '-c', 'copy', '-movflags', '+faststart', '-tag:v', 'avc1',
    '-progress', 'pipe:1', '-nostats', out
  ]
}

/** HEVC remux needs the hvc1 tag for Chromium. */
export function remuxArgsFor(codec: string, src: string, out: string, hasAudio: boolean): string[] {
  const a = remuxArgs(src, out, hasAudio)
  const i = a.indexOf('avc1')
  if (codec === 'hevc' || codec === 'h265') a[i] = 'hvc1'
  else if (codec !== 'h264') {
    a.splice(i - 1, 2)
  }
  return a
}

/** H.264 proxy for playback when the source codec can't be decoded by Chromium. */
export function proxyArgs(src: string, out: string, enc: H264Encoder, w: number, h: number, fps: number, hasAudio: boolean): string[] {
  const maxW = 3840
  const scale = w > maxW ? ['-vf', `scale=${maxW}:-2:flags=bicubic`] : []
  const ow = w > maxW ? maxW : w
  const oh = w > maxW ? Math.round((h * maxW) / w / 2) * 2 : h
  return [
    ...BASE, '-n', '-i', src,
    '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '128k'] : []),
    ...scale, '-c:v', enc, ...encoderOptions(enc, ow, oh, fps), '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out
  ]
}

/** Keyframe index via packets (fast, no decode). ASF has no pts → use dts. */
export function keyframeProbeArgs(src: string): string[] {
  return ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'csv=p=0', src]
}

export function parseKeyframes(csv: string): number[] {
  const out: number[] = []
  for (const line of csv.split(/\r?\n/)) {
    if (!line) continue
    const [pts, dts, flags] = line.split(',')
    if (!flags || !flags.includes('K')) continue
    const t = Number(pts !== 'N/A' ? pts : dts)
    if (Number.isFinite(t)) out.push(t)
  }
  return out.sort((a, b) => a - b)
}

/** Keyframe at or before t. */
export function keyframeAtOrBefore(keys: number[], t: number): number {
  let best = keys.length ? keys[0] : 0
  for (const k of keys) {
    if (k <= t + 1e-6) best = k
    else break
  }
  return best
}

export interface FastTrimOpts {
  src: string
  out: string
  inSec: number
  durSec: number
  includeAudio: boolean
}

/** Stream-copy trim (snaps to the keyframe at or before inSec). */
export function fastTrimArgs(o: FastTrimOpts): string[] {
  return [
    ...BASE, '-n', '-ss', num(o.inSec), '-i', o.src, '-t', num(o.durSec),
    '-map', '0:v:0', ...(o.includeAudio ? ['-map', '0:a:0?'] : []),
    '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', o.out
  ]
}

export interface DecodeOpts {
  src: string
  inSec: number
  durSec: number
  fps: number
  /** optional downscale before sending frames (when output is much smaller than source) */
  scaleTo?: { w: number; h: number }
  /** frame format on stdout (default rgba) */
  pixFmt?: FramePixFmt
}

/** Raw frame formats between FFmpeg and the export renderer. */
export type FramePixFmt = 'rgba' | 'yuv420p' | 'yuvj420p'

export interface YuvTransport {
  /** planar 4:2:0 as FFmpeg should emit it: the source's own range, so no range conversion happens */
  pixFmt: 'yuv420p' | 'yuvj420p'
  fullRange: boolean
  matrix: 'bt709' | 'bt601'
}

/**
 * How to carry a source's frames as YUV 4:2:0 without changing them: keep the stream's range (full 'pc' /
 * yuvj*, as Axis cameras send, or limited), and the matrix the browser uses to show it (BT.601 when the
 * stream says so or for SD, BT.709 otherwise).
 */
export function yuvTransportFor(v: { pixFmt?: string; colorRange?: string; colorSpace?: string; height: number }): YuvTransport {
  const fullRange = v.colorRange === 'pc' || (v.colorRange !== 'tv' && !!v.pixFmt?.startsWith('yuvj'))
  const cs = v.colorSpace ?? ''
  const matrix = cs === 'bt470bg' || cs === 'smpte170m' || ((cs === '' || cs === 'unknown') && v.height < 720) ? 'bt601' : 'bt709'
  return { pixFmt: fullRange ? 'yuvj420p' : 'yuv420p', fullRange, matrix }
}

/** Bytes in one raw frame. */
export function frameBytes(pixFmt: FramePixFmt, w: number, h: number): number {
  return pixFmt === 'rgba' ? w * h * 4 : (w * h * 3) / 2
}

/**
 * Whether rendered frames can come back as packed YUV 4:2:0: the GPU packs 4 luma samples per RGBA texel
 * and two chroma rows per texture row, which needs width % 8 == 0 and height % 4 == 0.
 */
export function canPackYuvOutput(w: number, h: number): boolean {
  return w % 8 === 0 && h % 4 === 0
}

/** Decoder for the render pipeline: constant-rate raw frames (RGBA or planar YUV 4:2:0) on stdout. */
export function renderDecodeArgs(o: DecodeOpts): string[] {
  const fmt = o.pixFmt ?? 'rgba'
  const vf = [`fps=${num(o.fps)}`]
  if (o.scaleTo) vf.push(`scale=${o.scaleTo.w}:${o.scaleTo.h}:flags=bicubic`)
  vf.push(`format=${fmt}`)
  return [
    ...BASE, '-ss', num(o.inSec), '-i', o.src, '-t', num(o.durSec),
    '-map', '0:v:0', '-vf', vf.join(','), '-f', 'rawvideo', '-pix_fmt', fmt, 'pipe:1'
  ]
}

export interface EncodeOpts {
  src: string
  out: string
  inSec: number
  durSec: number
  w: number
  h: number
  fps: number
  enc: H264Encoder
  includeAudio: boolean
  /**
   * frames on stdin: rgba (converted by FFmpeg), or yuv420p already in BT.709 limited range (the GPU
   * converts; matches the output tags so FFmpeg passes it straight to the encoder). Default rgba.
   */
  inPixFmt?: 'rgba' | 'yuv420p'
}

/** Encoder for the render pipeline: raw frames on stdin (+ audio from the original source). */
export function renderEncodeArgs(o: EncodeOpts): string[] {
  const inFmt = o.inPixFmt ?? 'rgba'
  return [
    ...BASE, '-n',
    '-f', 'rawvideo', '-pix_fmt', inFmt,
    ...(inFmt === 'yuv420p' ? ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'] : []),
    '-s', `${o.w}x${o.h}`, '-r', num(o.fps), '-i', 'pipe:0',
    ...(o.includeAudio ? ['-ss', num(o.inSec), '-t', num(o.durSec), '-i', o.src, '-map', '1:a:0?', '-c:a', 'aac', '-b:a', '128k'] : []),
    '-map', '0:v:0', '-c:v', o.enc, ...encoderOptions(o.enc, o.w, o.h, o.fps),
    '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-movflags', '+faststart', '-shortest', o.out
  ]
}

/** Annex-B elementary stream for signed-video validation. */
export function annexBArgs(src: string, codec: string): string[] {
  const hevc = codec === 'hevc' || codec === 'h265'
  return [
    ...BASE, '-i', src, '-map', '0:v:0', '-c', 'copy',
    '-bsf:v', hevc ? 'hevc_mp4toannexb' : 'h264_mp4toannexb',
    '-f', hevc ? 'hevc' : 'h264', 'pipe:1'
  ]
}

/** Parse `-progress pipe:1` output → seconds processed (or undefined). */
export function parseProgress(chunk: string): number | undefined {
  let last: number | undefined
  for (const line of chunk.split(/\r?\n/)) {
    const m = /^out_time_us=(\d+)/.exec(line) ?? /^out_time_ms=(\d+)/.exec(line)
    if (m) last = Number(m[1]) / 1e6
  }
  return last
}

/** Even dimensions (yuv420p requirement). */
export function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}
