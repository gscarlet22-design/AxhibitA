import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: {}, protocol: {}, BrowserWindow: {} }))
import { summarize, type GopLine } from '../../src/main/verify'

const g = (gop: number, status: GopLine['status'], received = 32): GopLine => ({ type: 'gop', gop, status, expected: 32, received })
const sum = { type: 'summary' as const, signed: true, pubkey_validation: 'not_feasible' as const, serial: 'X1' }

describe('signed video summary', () => {
  it('verified when every GOP is valid', () => {
    const r = summarize([g(0, 'valid'), g(1, 'valid')], sum, [], 10, 16, 'v')
    expect(r.status).toBe('verified')
    expect(r.gopsValid).toBe(2)
  })
  it('places a tampered GOP on the timeline from frame counts', () => {
    const r = summarize([g(0, 'valid'), g(1, 'invalid'), g(2, 'invalid'), g(3, 'valid')], sum, [], 10, 16, 'v')
    expect(r.status).toBe('failed')
    expect(r.invalidRanges).toEqual([{ fromSec: 2, toSec: 6, reason: expect.stringContaining('mismatch') }])
  })
  it('not signed', () => {
    expect(summarize([], { type: 'summary', signed: false }, [], 10, 15, 'v').status).toBe('not_signed')
  })
  it('never claims verified when there are no GOP results', () => {
    expect(summarize([], sum, [], 10, 15, 'v').status).not.toBe('verified')
  })
  it('a changed key fails the recording', () => {
    expect(summarize([g(0, 'valid')], { ...sum, public_key_changed: true }, [], 10, 15, 'v').status).toBe('failed')
  })
})

describe('signed video timing', () => {
  it('derives the frame rate from counted frames when the header is wrong', () => {
    const gops = [0, 1, 2, 3, 4, 5].map((i) => g(i, i === 4 ? 'invalid' : 'valid'))
    const r = summarize(gops, { ...sum, frames: 192 }, [], 12.8, 25, 'v') // 192 frames over 12.8 s = 15 fps
    expect(r.invalidRanges[0].fromSec).toBeCloseTo(128 / 15)
    expect(r.invalidRanges[0].toSec).toBeCloseTo(160 / 15)
  })
})
