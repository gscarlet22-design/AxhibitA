import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC } from '../shared/ipc'
import type { JobEvent } from '../shared/types'
import { log } from './log'

export interface JobContext {
  id: string
  signal: AbortSignal
  progress(p: number, message?: string): void
  onCancel(fn: () => void): void
}

const jobs = new Map<string, AbortController>()

function broadcast(e: JobEvent) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.jobEvent, e)
}

/** Start a cancellable background job. Returns the job id immediately; result arrives as a 'done' event. */
export function startJob<T>(label: string, fn: (ctx: JobContext) => Promise<T>): string {
  const id = randomUUID()
  const ac = new AbortController()
  jobs.set(id, ac)
  let lastSent = 0
  const ctx: JobContext = {
    id,
    signal: ac.signal,
    progress(p, message) {
      const now = Date.now()
      if (now - lastSent < 100 && p < 1) return
      lastSent = now
      broadcast({ jobId: id, kind: 'progress', progress: Math.max(0, Math.min(1, p)), message })
    },
    onCancel(f) {
      ac.signal.addEventListener('abort', f, { once: true })
    }
  }
  log(`job ${label} ${id} started`)
  queueMicrotask(async () => {
    try {
      const result = await fn(ctx)
      if (ac.signal.aborted) throw new Error('Cancelled')
      broadcast({ jobId: id, kind: 'done', result })
      log(`job ${label} ${id} done`)
    } catch (err) {
      const message = ac.signal.aborted ? 'Cancelled' : err instanceof Error ? err.message : String(err)
      broadcast({ jobId: id, kind: 'error', message })
      log(`job ${label} ${id} error: ${message}`)
    } finally {
      jobs.delete(id)
    }
  })
  return id
}

export function cancelJob(id: string): void {
  jobs.get(id)?.abort()
}

export function cancelAll(): void {
  for (const ac of jobs.values()) ac.abort()
}
