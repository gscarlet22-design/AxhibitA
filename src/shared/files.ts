/** Windows-safe file naming and collision handling (pure; caller supplies an exists() check). */

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export function sanitizeStem(name: string, maxLen = 120): string {
  let s = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim()
  s = s.replace(/[. ]+$/g, '')
  if (!s) s = 'export'
  if (RESERVED.test(s)) s = `_${s}`
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/[. ]+$/g, '')
  return s
}

/**
 * Pick a stem such that none of `${stem}${suffix}` exists for every suffix (e.g. ".mp4" and ".mp4.manifest.json").
 * Appends " (2)", " (3)", …
 */
export function uniqueStem(stem: string, suffixes: string[], exists: (fileName: string) => boolean): string {
  const clash = (s: string) => suffixes.some((suf) => exists(s + suf))
  if (!clash(stem)) return stem
  for (let i = 2; i < 10000; i++) {
    const s = `${stem} (${i})`
    if (!clash(s)) return s
  }
  throw new Error('Could not find a free file name')
}
