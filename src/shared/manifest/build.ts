import { APP_NAME, INTEGRITY_STATEMENT, MANIFEST_SCHEMA } from '../constants'
import type { MediaInfo, SignedVideoResult } from '../types'
import { ManifestSchema, type Manifest, type Operation } from './schema'

export interface BuildManifestInput {
  appVersion: string
  ffmpegVersion: string
  encoder: string | null
  createdAt: Date
  osUser: string
  operatorName: string | null
  source: MediaInfo
  sourceSha256: string
  signedVideo: SignedVideoResult | null
  operations: Operation[]
  ffmpegArgs: string[][] | null
  output: Manifest['output']
  notes: string | null
}

/** Strip tool-path prefixes from args so manifests don't leak local install paths except source/output. */
export function buildManifest(i: BuildManifestInput): Manifest {
  const sv = i.signedVideo
  const m: Manifest = {
    schema: MANIFEST_SCHEMA,
    tool: { name: APP_NAME, version: i.appVersion, ffmpegVersion: i.ffmpegVersion, encoder: i.encoder },
    createdAt: i.createdAt.toISOString(),
    createdBy: { osUser: i.osUser, operatorName: i.operatorName },
    source: {
      fileName: i.source.fileName,
      absolutePath: i.source.path,
      sizeBytes: i.source.sizeBytes,
      modifiedAt: i.source.modifiedAt,
      sha256: i.sourceSha256,
      container: i.source.container,
      videoCodec: i.source.video?.codec ?? 'unknown',
      width: i.source.video?.width ?? 0,
      height: i.source.video?.height ?? 0,
      fps: i.source.video?.fps ?? 0,
      durationSec: i.source.durationSec,
      cameraName: i.source.cameraName ?? null,
      cameraId: i.source.cameraId ?? null,
      wallClockStart: i.source.wallClockStart ?? null,
      wallClockSource: i.source.wallClockSource,
      axisMetadata: i.source.axis ? { ...i.source.axis } : null
    },
    integrity: {
      acsDigitalSignature: 'not_verified_by_this_tool',
      signedVideo: sv
        ? { ...sv }
        : { status: 'not_checked', invalidRanges: [] },
      statement: INTEGRITY_STATEMENT
    },
    operations: i.operations,
    ffmpegArgs: i.ffmpegArgs,
    output: i.output,
    notes: i.notes && i.notes.trim() ? i.notes.trim() : null
  }
  return ManifestSchema.parse(m)
}
