import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { argvPaths } from '@shared/argv'

const existing = new Set(['/cases/export1', '/home/g/clip.asf'])
const exists = (p: string) => existing.has(p)

describe('command-line paths', () => {
  it('skips the exe (packaged) and switches Chromium inserts anywhere', () => {
    expect(argvPaths(['Axhibit A.exe', '--allow-file-access-from-files', '/cases/export1', '--flag'], true, '/', exists, posix.resolve)).toEqual(['/cases/export1'])
  })
  it('skips electron and the app path when unpackaged', () => {
    expect(argvPaths(['electron', '.', '/cases/export1'], false, '/', exists, posix.resolve)).toEqual(['/cases/export1'])
  })
  it('resolves relative paths against the launching directory and drops missing or duplicate ones', () => {
    expect(argvPaths(['a.exe', 'clip.asf', '/home/g/clip.asf', 'nope'], true, '/home/g', exists, posix.resolve)).toEqual(['/home/g/clip.asf'])
  })
})
