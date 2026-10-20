import { app } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Settings, StoreShape } from '../shared/ipc'

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  cacheLimitGb: 20,
  defaultOutputDir: null,
  defaultTrimMode: 'exact',
  encoderOverride: null,
  operatorName: '',
  integrityNoticeAcknowledged: false
}

const DEFAULTS: StoreShape = { settings: DEFAULT_SETTINGS, calibrations: {}, recent: [] }

/** Tiny JSON store in userData (atomic write via rename). */
class JsonStore {
  private data: StoreShape
  private file: string
  private extra: Record<string, unknown> = {}

  constructor() {
    this.file = join(app.getPath('userData'), 'axhibit-store.json')
    this.data = structuredClone(DEFAULTS)
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'))
        this.data = {
          settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
          calibrations: raw.calibrations ?? {},
          recent: Array.isArray(raw.recent) ? raw.recent : []
        }
        this.extra = raw.extra ?? {}
      }
    } catch {
      /* corrupt store → defaults */
    }
  }

  get<K extends keyof StoreShape>(k: K): StoreShape[K] {
    return this.data[k]
  }

  set<K extends keyof StoreShape>(k: K, v: StoreShape[K]): void {
    this.data[k] = v
    this.flush()
  }

  getExtra<T>(k: string): T | undefined {
    return this.extra[k] as T | undefined
  }

  setExtra(k: string, v: unknown): void {
    this.extra[k] = v
    this.flush()
  }

  private flush() {
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify({ ...this.data, extra: this.extra }, null, 2))
    renameSync(tmp, this.file)
  }
}

let store: JsonStore | null = null
export function getStore(): JsonStore {
  if (!store) store = new JsonStore()
  return store
}
