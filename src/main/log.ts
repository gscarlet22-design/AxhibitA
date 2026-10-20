import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { logsDir } from './paths'

let file: string | null = null
const MAX = 5 * 1024 * 1024

function rotate(f: string) {
  try {
    if (!existsSync(f) || statSync(f).size < MAX) return
    for (let i = 4; i >= 1; i--) {
      const a = `${f}.${i}`
      if (existsSync(a)) renameSync(a, `${f}.${i + 1}`)
    }
    renameSync(f, `${f}.1`)
  } catch {
    /* ignore */
  }
}

export function log(msg: string): void {
  try {
    if (!file) file = join(logsDir(), 'axhibit.log')
    rotate(file)
    appendFileSync(file, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* logging must never crash the app */
  }
  if (process.env.AXHIBIT_DEBUG) console.log(msg)
}
