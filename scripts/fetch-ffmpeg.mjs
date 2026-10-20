// Download a pinned LGPL FFmpeg build for Windows x64 into resources/bin (ffmpeg.exe, ffprobe.exe + license).
// LGPL build: no GPL components (no libx264). Encoders used at runtime: h264_mf / nvenc / qsv / amf.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PINNED = {
  // BtbN FFmpeg-Builds, release branch n8.1, LGPL static (no shared libraries to ship)
  name: 'ffmpeg-n8.1-latest-win64-lgpl-8.1.zip',
  sha256: process.env.FFMPEG_SHA256 || '602a1b4f1aaf6d2344cba2ffd44dd3ccc9cf0ba956f7b63baa3e9e4871af9452',
  base: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/'
}

const root = resolve(import.meta.dirname, '..')
const bin = join(root, 'resources', 'bin')
const tmp = join(root, '.cache', 'ffmpeg-dl')
mkdirSync(bin, { recursive: true })
mkdirSync(tmp, { recursive: true })

if (existsSync(join(bin, 'ffmpeg.exe')) && existsSync(join(bin, 'ffprobe.exe')) && !process.argv.includes('--force')) {
  console.log('ffmpeg.exe already present (use --force to refetch)')
  process.exit(0)
}

const zip = join(tmp, PINNED.name)
if (!existsSync(zip)) {
  console.log('Downloading', PINNED.name)
  const res = await fetch(PINNED.base + PINNED.name)
  if (!res.ok) throw new Error(`Download failed: ${res.status}`)
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
}
const hash = createHash('sha256').update(readFileSync(zip)).digest('hex')
if (hash !== PINNED.sha256) {
  throw new Error(`SHA-256 mismatch for ${PINNED.name}: got ${hash}. The "latest" asset may have been rebuilt; verify it and set FFMPEG_SHA256.`)
}
// Windows 10/11 ship bsdtar, which reads zips; call it by full path so Git Bash's GNU tar (no zip support) isn't picked up.
if (process.platform === 'win32') execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', tmp])
else execFileSync('unzip', ['-o', '-q', zip, '-d', tmp])
const dir = readdirSync(tmp).map((d) => join(tmp, d)).find((d) => statSync(d).isDirectory() && existsSync(join(d, 'bin', 'ffmpeg.exe')))
if (!dir) throw new Error('Unexpected archive layout')
copyFileSync(join(dir, 'bin', 'ffmpeg.exe'), join(bin, 'ffmpeg.exe'))
copyFileSync(join(dir, 'bin', 'ffprobe.exe'), join(bin, 'ffprobe.exe'))
mkdirSync(join(bin, 'LICENSES'), { recursive: true })
copyFileSync(join(dir, 'LICENSE.txt'), join(bin, 'LICENSES', 'FFmpeg-LGPL.txt'))
writeFileSync(join(bin, 'LICENSES', 'FFmpeg-SOURCE.txt'), `FFmpeg binaries from ${PINNED.base}${PINNED.name} (sha256 ${hash}).\nSource: https://github.com/BtbN/FFmpeg-Builds and https://ffmpeg.org/\n`)
console.log('Installed ffmpeg.exe and ffprobe.exe into resources/bin')
