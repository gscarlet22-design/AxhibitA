import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveRecordingMeta, parseRate, timestampFromName } from '@shared/ffmpeg/probe'

const dir = join(__dirname, '../fixtures/probe')
const load = (name: string) => {
  const probe = JSON.parse(readFileSync(join(dir, name + '.json'), 'utf8'))
  return deriveRecordingMeta(probe, { path: '/x/' + name, fileName: name, sizeBytes: 1, modifiedAt: '2026-10-19T00:00:00Z' })
}

describe('timestampFromName', () => {
  it('parses ACS file names with milliseconds as local time', () => {
    const r = timestampFromName('Lobby Fisheye 2026-10-19_10_34_35_604')
    expect(r?.iso).toBe('2026-10-19T10:34:35.604')
    expect(r?.index).toBe('Lobby Fisheye '.length)
  })
  it('parses compact stamps', () => {
    expect(timestampFromName('cam_20261012_083000')?.iso).toBe('2026-10-12T08:30:00.000')
  })
  it('rejects nonsense', () => {
    expect(timestampFromName('clip 2026-13-45_99_99_99')).toBeUndefined()
  })
})

describe('parseRate', () => {
  it('handles fractions and zero denominators', () => {
    expect(parseRate('30000/1001')).toBeCloseTo(29.97, 2)
    expect(parseRate('0/0')).toBe(0)
    expect(parseRate(undefined)).toBe(0)
  })
})

describe('deriveRecordingMeta on real ACS exports', () => {
  it('reads Axis ASF tags', () => {
    const m = load('Lobby Fisheye 2026-10-19_10_34_35_604.asf')
    expect(m.cameraName).toBe('Lobby Fisheye')
    expect(m.cameraNameSource).toBe('axis:camera_name')
    expect(m.wallClockStart).toBe('2026-10-19T15:34:33.153Z')
    expect(m.wallClockApprox).toBe(false)
    expect(m.cameraId).toBe('28753-000000000001')
    expect(m.axis?.isFisheye).toBe(true)
    expect(m.axis?.lensProfile).toHaveLength(3)
    expect(m.axis?.tiltOrientation).toBe(2)
    expect(m.video).toMatchObject({ codec: 'h264', width: 2880, height: 2880 })
    expect(m.audio?.codec).toBe('aac')
  })
  it('reads Axis MKV tags', () => {
    const m = load('Lobby Fisheye 2026-10-19_10_34_35_604.mkv')
    expect(m.cameraName).toBe('Lobby Fisheye')
    expect(m.wallClockSource).toBe('axis:start_time')
    expect(m.axis?.isFisheye).toBe(true)
  })
  it('falls back to the file name for MP4', () => {
    const m = load('P3738_Loading Dock 2026-10-19_15_21_58_689.mp4')
    expect(m.cameraName).toBe('P3738_Loading Dock')
    expect(m.cameraNameSource).toBe('filename prefix')
    expect(m.wallClockApprox).toBe(true)
    expect(new Date(m.wallClockStart!).getMilliseconds()).toBe(689)
    expect(m.axis).toBeUndefined()
  })
  it('parses every fixture without throwing', () => {
    for (const f of readdirSync(dir)) {
      const m = load(f.replace(/\.json$/, ''))
      expect(m.video?.width).toBeGreaterThan(0)
      expect(m.durationSec).toBeGreaterThan(0)
    }
  })
})
