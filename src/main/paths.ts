import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const exe = (n: string) => (process.platform === 'win32' ? `${n}.exe` : n)

function binDirCandidates(): string[] {
  const c: string[] = []
  if (process.env.AXHIBIT_FFMPEG_DIR) c.push(process.env.AXHIBIT_FFMPEG_DIR)
  if (app.isPackaged) c.push(join(process.resourcesPath, 'bin'))
  else c.push(join(app.getAppPath(), 'resources', 'bin'))
  return c
}

/** Resolve a bundled tool; in dev fall back to PATH. */
export function toolPath(name: 'ffmpeg' | 'ffprobe' | 'sv-validate'): string | null {
  for (const d of binDirCandidates()) {
    const p = join(d, exe(name))
    if (existsSync(p)) return p
  }
  if (!app.isPackaged && name !== 'sv-validate') return name // system PATH during development
  return null
}

export function cacheDir(): string {
  const d = join(app.getPath('userData'), 'cache')
  mkdirSync(d, { recursive: true })
  return d
}

export function logsDir(): string {
  const d = join(app.getPath('userData'), 'logs')
  mkdirSync(d, { recursive: true })
  return d
}
