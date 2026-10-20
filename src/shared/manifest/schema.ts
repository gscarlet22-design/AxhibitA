import { z } from 'zod'
import { MANIFEST_SCHEMA } from '../constants'

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)

export const SignedVideoSchema = z.object({
  status: z.enum(['not_checked', 'verified', 'partially_verified', 'failed', 'not_signed', 'unsupported']),
  checkedAt: z.string().optional(),
  publicKeySha256: z.string().optional(),
  gopsTotal: z.number().optional(),
  gopsValid: z.number().optional(),
  invalidRanges: z.array(z.object({ fromSec: z.number(), toSec: z.number(), reason: z.string() })).default([]),
  validator: z.string().optional(),
  detail: z.string().optional()
})

export const OperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('trim'),
    mode: z.enum(['fast', 'exact']),
    requestedInSec: z.number(),
    requestedOutSec: z.number(),
    actualInSec: z.number(),
    actualOutSec: z.number(),
    wallClockIn: z.string().nullable(),
    wallClockOut: z.string().nullable()
  }),
  z.object({ type: z.literal('crop'), rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }) }),
  z.object({ type: z.literal('digital_zoom'), view: z.record(z.string(), z.unknown()) }),
  z.object({
    type: z.literal('dewarp'),
    mode: z.enum(['ptz', 'pano', 'dualpano', 'quad', 'view_path']),
    calibration: z.record(z.string(), z.unknown()),
    view: z.unknown()
  }),
  z.object({
    type: z.literal('zoom_path'),
    aspect: z.number(),
    keyframes: z.array(z.object({ tSec: z.number(), cxPx: z.number(), cyPx: z.number(), hPx: z.number() })),
    interpolation: z.string(),
    maxUpscale: z.number()
  }),
  z.object({
    type: z.literal('redaction'),
    tracks: z.array(z.unknown()),
    /** inside: the boxes are hidden; outside: everything except the boxes is hidden with outsideStyle */
    mode: z.enum(['inside', 'outside']).optional(),
    outsideStyle: z.enum(['blur', 'pixelate', 'solid']).nullable().optional()
  }),
  z.object({ type: z.literal('overlay'), timestamp: z.boolean(), cameraName: z.boolean(), customText: z.string().nullable() }),
  z.object({ type: z.literal('encode'), videoCodec: z.string(), encoder: z.string(), normalizedFps: z.number(), audio: z.string().nullable() }),
  z.object({ type: z.literal('snapshot'), mediaTimeSec: z.number(), wallClock: z.string().nullable() })
])

export const ManifestSchema = z.object({
  schema: z.literal(MANIFEST_SCHEMA),
  tool: z.object({ name: z.string(), version: z.string(), ffmpegVersion: z.string(), encoder: z.string().nullable() }),
  createdAt: z.string(),
  createdBy: z.object({ osUser: z.string(), operatorName: z.string().nullable() }),
  source: z.object({
    fileName: z.string(),
    absolutePath: z.string(),
    sizeBytes: z.number(),
    modifiedAt: z.string(),
    sha256,
    container: z.string(),
    videoCodec: z.string(),
    width: z.number(),
    height: z.number(),
    fps: z.number(),
    durationSec: z.number(),
    cameraName: z.string().nullable(),
    cameraId: z.string().nullable(),
    wallClockStart: z.string().nullable(),
    wallClockSource: z.string(),
    axisMetadata: z.record(z.string(), z.unknown()).nullable()
  }),
  integrity: z.object({
    acsDigitalSignature: z.literal('not_verified_by_this_tool'),
    signedVideo: SignedVideoSchema,
    statement: z.string()
  }),
  operations: z.array(OperationSchema),
  ffmpegArgs: z.array(z.array(z.string())).nullable(),
  output: z.object({
    fileName: z.string(),
    sizeBytes: z.number(),
    sha256,
    width: z.number(),
    height: z.number(),
    fps: z.number().nullable(),
    durationSec: z.number().nullable()
  }),
  notes: z.string().nullable()
})

export type Manifest = z.infer<typeof ManifestSchema>
export type Operation = z.infer<typeof OperationSchema>
