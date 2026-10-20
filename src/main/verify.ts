import { createInterface } from 'node:readline'
import { annexBArgs } from '../shared/ffmpeg/args'
import type { SignedVideoResult } from '../shared/types'
import type { JobContext } from './jobs'
import { getRecording, keyframes } from './library'
import { log } from './log'
import { toolPath } from './paths'
import { ffmpegPath, killTree, lastLines, spawn, WIN_OPTS } from './proc'

const results = new Map<string, SignedVideoResult>()

export function getSignedResult(id: string): SignedVideoResult | null {
  return results.get(id) ?? null
}

export function validatorAvailable(): boolean {
  return !!toolPath('sv-validate')
}

/** NDJSON emitted by native/sv-tool (see sv_tool.c header). */
export interface GopLine {
  type: 'gop'
  gop: number
  status: 'valid' | 'invalid' | 'missing' | 'unsigned' | 'pending' | 'version_mismatch' | 'unknown'
  expected: number
  received: number
}
export interface SummaryLine {
  type: 'summary'
  signed?: boolean
  authenticity?: string
  frames?: number
  pubkey_validation?: 'ok' | 'not_ok' | 'not_feasible'
  public_key_changed?: boolean
  version?: string
  signer_version?: string
  serial?: string
  firmware?: string
  manufacturer?: string
  hardware?: string
  error?: string
}

const REASON: Record<string, string> = {
  invalid: 'signature mismatch (frames altered, removed or reordered)',
  missing: 'frames missing',
  unsigned: 'not signed',
  version_mismatch: 'signed with a newer format than this validator supports',
  unknown: 'could not be validated'
}

/**
 * Turn per-GOP reports into time ranges. Frame counts from the validator place each GOP on the timeline
 * (frames / fps); the keyframe index is used when counts are unavailable.
 */
export function summarize(gops: GopLine[], summary: SummaryLine | null, keys: number[], duration: number, fpsHint: number, validator: string): SignedVideoResult {
  const checkedAt = new Date().toISOString()
  if (!summary || summary.error) {
    return { status: 'unsupported', checkedAt, gopsTotal: 0, gopsValid: 0, invalidRanges: [], validator, detail: summary?.error ?? 'Validator produced no result' }
  }
  if (!summary.signed) return { status: 'not_signed', checkedAt, gopsTotal: 0, gopsValid: 0, invalidRanges: [], validator }
  const counted = gops.filter((g) => g.status !== 'pending')
  const total = counted.length
  const valid = counted.filter((g) => g.status === 'valid').length
  let frame = 0
  let fps = fpsHint
  // Camera recordings are variable-rate and container headers can be wrong: prefer frames counted / duration.
  if (summary.frames && summary.frames > 0 && duration > 0) fps = summary.frames / duration
  const useFrames = fps > 0 && counted.every((g) => g.received >= 0)
  const invalidRanges: SignedVideoResult['invalidRanges'] = []
  counted.forEach((g, i) => {
    const r = useFrames
      ? { fromSec: frame / fps, toSec: Math.min(duration, (frame + Math.max(g.received, 0)) / fps) }
      : { fromSec: keys[i] ?? 0, toSec: keys[i + 1] ?? duration }
    frame += Math.max(g.received, 0)
    if (g.status === 'valid') return
    const reason = REASON[g.status] ?? REASON.unknown
    const last = invalidRanges[invalidRanges.length - 1]
    if (last && last.reason === reason && Math.abs(last.toSec - r.fromSec) < 1e-3) last.toSec = r.toSec
    else invalidRanges.push({ ...r, reason })
  })
  const bad = counted.some((g) => g.status === 'invalid' || g.status === 'missing' || g.status === 'unknown') || !!summary.public_key_changed
  const mismatch = counted.some((g) => g.status === 'version_mismatch')
  let status: SignedVideoResult['status'] = bad ? 'failed' : valid === total && total > 0 ? 'verified' : 'partially_verified'
  if (mismatch && !bad) status = 'unsupported'
  const signer = [summary.manufacturer, summary.hardware, summary.serial && `serial ${summary.serial}`, summary.firmware && `firmware ${summary.firmware}`].filter(Boolean).join(', ')
  const keyNote = summary.pubkey_validation === 'ok' ? 'Signing key attested by the manufacturer.' : summary.pubkey_validation === 'not_ok' ? 'Signing key attestation FAILED.' : 'Signing key not attested in the stream; confirm it belongs to the camera.'
  const parts = [signer && `Signed by ${signer}.`, keyNote, summary.public_key_changed ? 'The signing key changed during the recording.' : '', mismatch ? 'Part of the video uses a newer signing format; update Axhibit A.' : '']
  return { status, checkedAt, gopsTotal: total, gopsValid: valid, invalidRanges, validator, detail: parts.filter(Boolean).join(' ') }
}

export async function verifySigned(id: string, ctx: JobContext): Promise<SignedVideoResult> {
  const r = getRecording(id)
  const sv = toolPath('sv-validate')
  if (!sv) throw new Error('Signed-video validator is not included in this build')
  const codec = r.video?.codec ?? 'h264'
  if (codec !== 'h264' && codec !== 'hevc') {
    const res: SignedVideoResult = { status: 'unsupported', checkedAt: new Date().toISOString(), gopsTotal: 0, gopsValid: 0, invalidRanges: [], validator: 'sv-validate', detail: `Codec ${codec} not supported` }
    results.set(id, res)
    return res
  }
  const keys = await keyframes(id)
  const ff = spawn(ffmpegPath(), annexBArgs(r.path, codec), { ...WIN_OPTS, stdio: ['ignore', 'pipe', 'pipe'] })
  const val = spawn(sv, ['--codec', codec === 'hevc' ? 'h265' : 'h264'], { ...WIN_OPTS, stdio: ['pipe', 'pipe', 'pipe'] })
  ff.stdout!.pipe(val.stdin!)
  const errs: string[] = []
  ff.stderr!.on('data', (d: Buffer) => errs.push(d.toString()))
  val.stderr!.on('data', (d: Buffer) => errs.push(d.toString()))
  ctx.onCancel(() => {
    killTree(ff)
    killTree(val)
  })
  const gops: GopLine[] = []
  let summary: SummaryLine | null = null
  let version = 'signed-video-framework'
  const rl = createInterface({ input: val.stdout! })
  rl.on('line', (line) => {
    try {
      const o = JSON.parse(line)
      if (o.type === 'gop') {
        gops.push(o)
        if (keys.length) ctx.progress(Math.min(0.99, gops.length / keys.length))
      } else if (o.type === 'summary') {
        summary = o
        if (o.version) version = `signed-video-framework ${o.version}`
        if (o.error) summary = o
      }
    } catch {
      /* ignore non-JSON */
    }
  })
  const code = await new Promise<number | null>((res) => val.on('close', (c) => res(c)))
  if (ctx.signal.aborted) throw new Error('Cancelled')
  if (code !== 0 && !summary) throw new Error('Validator failed: ' + lastLines(errs.join(''), 20))
  const res = summarize(gops, summary, keys, r.durationSec, r.video?.fps ?? 0, version)
  log(`signed video ${r.fileName}: ${res.status} ${res.gopsValid}/${res.gopsTotal}`)
  results.set(id, res)
  return res
}
