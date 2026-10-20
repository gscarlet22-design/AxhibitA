import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { parseProgress } from '../shared/ffmpeg/args'
import type { JobContext } from './jobs'
import { log } from './log'
import { toolPath } from './paths'

export function ffmpegPath(): string {
  const p = toolPath('ffmpeg')
  if (!p) throw new Error('FFmpeg not found. The app package is incomplete.')
  return p
}

export function ffprobePath(): string {
  const p = toolPath('ffprobe')
  if (!p) throw new Error('ffprobe not found. The app package is incomplete.')
  return p
}

const WIN_OPTS: SpawnOptions = { windowsHide: true, shell: false }

/** Kill a process tree (Windows needs taskkill for children). */
export function killTree(cp: ChildProcess): void {
  if (cp.exitCode !== null || cp.killed) return
  if (process.platform === 'win32' && cp.pid) {
    spawn('taskkill', ['/pid', String(cp.pid), '/T', '/F'], WIN_OPTS)
  } else {
    cp.kill('SIGKILL')
  }
}

/** Run a tool to completion and collect stdout (string). */
export function runCapture(bin: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const cp = spawn(bin, args, { ...WIN_OPTS, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: string[] = []
    cp.stdout!.on('data', (d: Buffer) => out.push(d))
    cp.stderr!.on('data', (d: Buffer) => {
      err.push(d.toString())
      if (err.length > 200) err.shift()
    })
    signal?.addEventListener('abort', () => killTree(cp), { once: true })
    cp.on('error', reject)
    cp.on('close', (code) => {
      if (signal?.aborted) return reject(new Error('Cancelled'))
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'))
      else reject(new Error(lastLines(err.join(''), 20) || `${bin} exited with code ${code}`))
    })
  })
}

export function lastLines(s: string, n: number): string {
  return s.trim().split(/\r?\n/).slice(-n).join('\n')
}

/** Run ffmpeg with `-progress pipe:1`, reporting progress against a known duration. */
export function runFfmpegWithProgress(args: string[], durationSec: number, ctx: JobContext): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`ffmpeg ${JSON.stringify(args)}`)
    const cp = spawn(ffmpegPath(), args, { ...WIN_OPTS, stdio: ['ignore', 'pipe', 'pipe'] })
    const err: string[] = []
    cp.stdout!.on('data', (d: Buffer) => {
      const t = parseProgress(d.toString())
      if (t !== undefined && durationSec > 0) ctx.progress(t / durationSec)
    })
    cp.stderr!.on('data', (d: Buffer) => {
      err.push(d.toString())
      if (err.length > 200) err.shift()
    })
    ctx.onCancel(() => killTree(cp))
    cp.on('error', reject)
    cp.on('close', (code) => {
      if (ctx.signal.aborted) return reject(new Error('Cancelled'))
      if (code === 0) resolve()
      else reject(new Error(lastLines(err.join(''), 50) || `ffmpeg exited with code ${code}`))
    })
  })
}

export { spawn, WIN_OPTS }
