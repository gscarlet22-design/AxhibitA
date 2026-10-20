import type { AudioStreamInfo, MediaInfo, VideoStreamInfo } from '../types'

/** Arguments for probing a file with ffprobe (JSON output). */
export function probeArgs(path: string): string[] {
  return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]
}

export function parseRate(r?: string): number {
  if (!r) return 0
  const [n, d] = r.split('/').map(Number)
  if (!d) return Number.isFinite(n) ? n : 0
  const v = n / d
  return Number.isFinite(v) ? v : 0
}

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  pix_fmt?: string
  color_space?: string
  color_range?: string
  channels?: number
  sample_rate?: string
  tags?: Record<string, string>
  disposition?: Record<string, number>
}

export interface ProbeJson {
  format?: {
    format_name?: string
    duration?: string
    start_time?: string
    tags?: Record<string, string>
  }
  streams?: ProbeStream[]
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Find a timestamp embedded in a file name, e.g. "Cam_2026-10-12_08-30-00" or "20261012_083000". */
export function timestampFromName(name: string): { iso: string; index: number; length: number } | undefined {
  const patterns: RegExp[] = [
    /(\d{4})[-_.](\d{2})[-_.](\d{2})[ _T-](\d{2})[-_.:h](\d{2})[-_.:m](\d{2})(?:[-_.](\d{3}))?/,
    /(\d{4})(\d{2})(\d{2})[ _T-]?(\d{2})(\d{2})(\d{2})()/
  ]
  for (const re of patterns) {
    const m = re.exec(name)
    if (!m) continue
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number)
    const ms = m[7] && m[7].length === 3 ? Number(m[7]) : 0
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) continue
    // File-name times carry no zone; treat as local time and say so via the source label.
    const iso = `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}.${String(ms).padStart(3, '0')}`
    return { iso, index: m.index, length: m[0].length }
  }
  return undefined
}

function lowerKeys(t?: Record<string, string>): Record<string, string> {
  const o: Record<string, string> = {}
  for (const [k, v] of Object.entries(t ?? {})) o[k.toLowerCase()] = String(v)
  return o
}

function validIso(v?: string): string | undefined {
  if (!v) return undefined
  const t = Date.parse(v)
  if (!Number.isFinite(t)) return undefined
  // ffmpeg reports 1970 or 1601 epochs for missing values
  if (new Date(t).getUTCFullYear() < 2000) return undefined
  return new Date(t).toISOString()
}

/**
 * Turn raw ffprobe JSON + file facts into a MediaInfo.
 * Rules for wall-clock / camera name are heuristics until docs/FINDINGS.md confirms ACS specifics.
 */
export function deriveRecordingMeta(
  probe: ProbeJson,
  file: { path: string; fileName: string; sizeBytes: number; modifiedAt: string; parentDir?: string }
): MediaInfo {
  const streams = probe.streams ?? []
  const vs = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const as = streams.find((s) => s.codec_type === 'audio')
  const fmtTags = lowerKeys(probe.format?.tags)
  const vTags = lowerKeys(vs?.tags)

  const video: VideoStreamInfo | undefined = vs
    ? {
        codec: vs.codec_name ?? 'unknown',
        width: vs.width ?? 0,
        height: vs.height ?? 0,
        fps: parseRate(vs.avg_frame_rate) || parseRate(vs.r_frame_rate),
        pixFmt: vs.pix_fmt,
        colorSpace: vs.color_space,
        colorRange: vs.color_range
      }
    : undefined
  const audio: AudioStreamInfo | undefined = as
    ? { codec: as.codec_name ?? 'unknown', channels: as.channels ?? 0, sampleRate: Number(as.sample_rate ?? 0) }
    : undefined

  // Axis tags: ASF "Axis/StartTime", MKV "_AXIS_START_TIME" (see docs/FINDINGS.md)
  const ax = (asfKey: string, mkvKey: string) => fmtTags[`axis/${asfKey}`] ?? fmtTags[`_axis_${mkvKey}`]

  let wallClockStart: string | undefined
  let wallClockSource = 'unavailable'
  let wallClockApprox = false
  const tagCandidates: [string, string | undefined][] = [
    ['axis:start_time', ax('starttime', 'start_time')],
    ['format:creation_time', fmtTags['creation_time']],
    ['stream:creation_time', vTags['creation_time']],
    ['format:date', fmtTags['date']]
  ]
  for (const [src, val] of tagCandidates) {
    const iso = validIso(val)
    if (iso) {
      wallClockStart = iso
      wallClockSource = src
      break
    }
  }
  const stem = file.fileName.replace(/\.[^.]+$/, '')
  const nameTs = timestampFromName(stem)
  if (!wallClockStart && nameTs) {
    wallClockStart = new Date(Date.parse(nameTs.iso)).toISOString()
    wallClockSource = 'filename (local time, approximate)'
    wallClockApprox = true
  }
  const wallClockStop = validIso(ax('stoptime', 'stop_time'))

  let cameraName: string | undefined
  let cameraNameSource = 'unavailable'
  const axName = ax('cameraname', 'camera_name')
  const titleTag = fmtTags['title'] || vTags['title']
  if (axName && axName.trim()) {
    cameraName = axName.trim()
    cameraNameSource = 'axis:camera_name'
  } else if (titleTag && titleTag.trim()) {
    cameraName = titleTag.trim()
    cameraNameSource = 'tag:title'
  } else if (nameTs && nameTs.index > 0) {
    const prefix = stem.slice(0, nameTs.index).replace(/[\s_\-.]+$/, '').trim()
    if (prefix) {
      cameraName = prefix
      cameraNameSource = 'filename prefix'
    }
  }
  if (!cameraName && file.parentDir) {
    cameraName = file.parentDir
    cameraNameSource = 'folder name'
  }

  const isFisheyeRaw = ax('isfisheye', 'is_fisheye')
  const lensRaw = ax('lensprofile', 'lens_profile')
  let lensProfile: number[] | undefined
  if (lensRaw) {
    try {
      const v = JSON.parse(lensRaw)
      if (Array.isArray(v) && v.every((n) => typeof n === 'number')) lensProfile = v
    } catch {
      /* keep undefined */
    }
  }
  const tiltRaw = ax('tiltorientation', 'tilt_orientation')
  const axisInfo =
    isFisheyeRaw || lensProfile || tiltRaw
      ? {
          isFisheye: isFisheyeRaw ? isFisheyeRaw === '1' || isFisheyeRaw.toLowerCase() === 'true' : undefined,
          lensProfile,
          tiltOrientation: tiltRaw !== undefined && tiltRaw !== '' ? Number(tiltRaw) : undefined,
          triggerName: ax('triggername', 'trigger_name')
        }
      : undefined

  return {
    path: file.path,
    fileName: file.fileName,
    sizeBytes: file.sizeBytes,
    modifiedAt: file.modifiedAt,
    container: (probe.format?.format_name ?? '').split(',')[0] || 'unknown',
    durationSec: Number(probe.format?.duration ?? 0) || 0,
    video,
    audio,
    tags: { ...fmtTags },
    wallClockStart,
    wallClockSource,
    wallClockApprox,
    wallClockStop,
    cameraName,
    cameraNameSource,
    cameraId: ax('cameraid', 'camera_id'),
    axis: axisInfo,
    startTimeSec: Number(probe.format?.start_time ?? 0) || 0
  }
}
