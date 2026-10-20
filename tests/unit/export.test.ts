import { describe, expect, it } from 'vitest'
import { fastTrimArgs, keyframeAtOrBefore, parseKeyframes, parseProgress, remuxArgsFor, renderDecodeArgs, renderEncodeArgs, thumbnailArgs, thumbnailTime } from '@shared/ffmpeg/args'
import { encoderOptions, parseEncoderList } from '@shared/ffmpeg/encoders'
import { sanitizeStem, uniqueStem } from '@shared/files'
import { buildManifest } from '@shared/manifest/build'
import type { MediaInfo } from '@shared/types'

describe('ffmpeg args', () => {
  it('never overwrites outputs', () => {
    const a = fastTrimArgs({ src: 's.asf', out: 'o.mp4', inSec: 1.5, durSec: 10, includeAudio: true })
    expect(a).toContain('-n')
    expect(a).not.toContain('-y')
    expect(a.at(-1)).toBe('o.mp4')
    expect(a).toContain('0:a:0?')
  })
  it('tags HEVC remux as hvc1 and drops tag for other codecs', () => {
    expect(remuxArgsFor('hevc', 's', 'o', false)).toContain('hvc1')
    expect(remuxArgsFor('h264', 's', 'o', false)).toContain('avc1')
    expect(remuxArgsFor('mpeg4', 's', 'o', false)).not.toContain('-tag:v')
  })
  it('decodes constant-rate RGBA for the render pipeline', () => {
    const a = renderDecodeArgs({ src: 's', inSec: 2, durSec: 5, fps: 15 })
    expect(a.join(' ')).toContain('fps=15,format=rgba')
    expect(a.at(-1)).toBe('pipe:1')
  })
  it('encodes from stdin with optional audio from the original', () => {
    const a = renderEncodeArgs({ src: 's', out: 'o.mp4', inSec: 1, durSec: 2, w: 1920, h: 1080, fps: 15, enc: 'h264_mf', includeAudio: true })
    expect(a).toContain('pipe:0')
    expect(a).toContain('1:a:0?')
    expect(a).toContain('yuv420p')
  })
  it('parses keyframes from pts or dts (ASF)', () => {
    const k = parseKeyframes('N/A,0.000000,K__\nN/A,0.066,__\nN/A,4.133000,K__\n2.13,2.1,K_\n')
    expect(k).toEqual([0, 2.13, 4.133])
    expect(keyframeAtOrBefore(k, 4.0)).toBe(2.13)
    expect(keyframeAtOrBefore(k, 4.133)).toBe(4.133)
  })
  it('grabs a library thumbnail without ever overwriting, reading only the source', () => {
    const a = thumbnailArgs('C:\\ev\\a.asf', 'C:\\cache\\t.part.jpg', 2)
    expect(a).toContain('-n')
    expect(a).not.toContain('-y')
    expect(a[a.indexOf('-i') + 1]).toBe('C:\\ev\\a.asf')
    expect(a.at(-1)).toBe('C:\\cache\\t.part.jpg')
    expect(a.join(' ')).toContain('-frames:v 1')
  })
  it('picks a thumbnail moment inside short clips and offsets by the container start', () => {
    expect(thumbnailTime(60)).toBe(2)
    expect(thumbnailTime(5)).toBe(0.5)
    expect(thumbnailTime(0)).toBe(0)
    expect(thumbnailTime(60, 1.5)).toBe(3.5)
  })
  it('parses progress', () => {
    expect(parseProgress('frame=10\nout_time_us=2500000\nprogress=continue')).toBe(2.5)
  })
})

describe('encoders', () => {
  it('lists available H.264 encoders in priority order', () => {
    const out = ` V....D h264_mf              H264 via MediaFoundation\n V....D libopenh264 OpenH264\n V....D h264_nvenc NVIDIA\n A....D aac AAC`
    expect(parseEncoderList(out)).toEqual(['h264_nvenc', 'h264_mf', 'libopenh264'])
  })
  it('gives every encoder a GOP setting', () => {
    for (const e of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264', 'libopenh264'] as const) {
      expect(encoderOptions(e, 1920, 1080, 15)).toContain('-g')
    }
  })
})

describe('file naming', () => {
  it('sanitizes Windows-hostile names', () => {
    expect(sanitizeStem('Front: Door / 2026?')).toBe('Front_ Door _ 2026_')
    expect(sanitizeStem('con')).toBe('_con')
    expect(sanitizeStem('name. . ')).toBe('name')
    expect(sanitizeStem('')).toBe('export')
  })
  it('finds a free stem across all suffixes', () => {
    const existing = new Set(['clip.mp4', 'clip (2).mp4.manifest.json'])
    expect(uniqueStem('clip', ['.mp4', '.mp4.manifest.json'], (f) => existing.has(f))).toBe('clip (3)')
  })
})

describe('manifest', () => {
  const src: MediaInfo = {
    path: 'C:\\x\\a.asf', fileName: 'a.asf', sizeBytes: 10, modifiedAt: '2026-10-19T00:00:00Z', container: 'asf',
    durationSec: 51, video: { codec: 'h264', width: 2880, height: 2880, fps: 15 }, tags: {},
    wallClockStart: '2026-10-19T15:34:33.153Z', wallClockSource: 'axis:start_time', wallClockApprox: false,
    cameraName: 'Lobby Fisheye', cameraNameSource: 'axis:camera_name', cameraId: 'x', axis: { isFisheye: true }, startTimeSec: 0
  }
  const h = 'a'.repeat(64)
  it('builds a valid manifest that never claims ACS signature verification', () => {
    const m = buildManifest({
      appVersion: '1.0.0', ffmpegVersion: 'n8.1', encoder: 'h264_mf', createdAt: new Date('2026-10-19T20:00:00Z'),
      osUser: 'g', operatorName: null, source: src, sourceSha256: h, signedVideo: null,
      operations: [{ type: 'overlay', timestamp: true, cameraName: true, customText: null }],
      ffmpegArgs: [['-i', 'x']], output: { fileName: 'o.mp4', sizeBytes: 5, sha256: h, width: 1920, height: 1080, fps: 15, durationSec: 3 },
      notes: '  '
    })
    expect(m.integrity.acsDigitalSignature).toBe('not_verified_by_this_tool')
    expect(m.integrity.signedVideo.status).toBe('not_checked')
    expect(m.notes).toBeNull()
  })
  it('records whether boxes were hidden or were the only thing left visible', () => {
    const m = buildManifest({
      appVersion: '1.1.0', ffmpegVersion: 'n8.1', encoder: 'h264_nvenc', createdAt: new Date('2026-10-20T20:00:00Z'),
      osUser: 'g', operatorName: null, source: src, sourceSha256: h, signedVideo: null,
      operations: [{ type: 'redaction', tracks: [], mode: 'outside', outsideStyle: 'blur' }],
      ffmpegArgs: [['-i', 'x']], output: { fileName: 'o.mp4', sizeBytes: 5, sha256: h, width: 1920, height: 1080, fps: 15, durationSec: 3 },
      notes: null
    })
    expect(m.operations[0]).toMatchObject({ type: 'redaction', mode: 'outside', outsideStyle: 'blur' })
  })
  it('rejects malformed hashes', () => {
    expect(() =>
      buildManifest({
        appVersion: '1', ffmpegVersion: 'x', encoder: null, createdAt: new Date(), osUser: 'g', operatorName: null, source: src,
        sourceSha256: 'nope', signedVideo: null, operations: [], ffmpegArgs: null,
        output: { fileName: 'o', sizeBytes: 1, sha256: h, width: 1, height: 1, fps: null, durationSec: null }, notes: null
      })
    ).toThrow()
  })
})
