const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0')

/** 754.25 → "12:34.25" or "1:02:34" style elapsed label. */
export function formatElapsed(sec: number, withFrac = false): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const ss = withFrac ? s.toFixed(2).padStart(5, '0') : pad(s)
  return h > 0 ? `${h}:${pad(m)}:${ss}` : `${pad(m)}:${ss}`
}

/** Wall-clock label for a media time given an ISO start. Local time of the viewing machine. */
export function wallClockAt(startIso: string | undefined, mediaSec: number): Date | undefined {
  if (!startIso) return undefined
  const t = Date.parse(startIso)
  if (!Number.isFinite(t)) return undefined
  return new Date(t + mediaSec * 1000)
}

export function formatWallClock(d: Date, withMs = false): string {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return withMs ? `${date} ${time}.${pad(d.getMilliseconds(), 3)}` : `${date} ${time}`
}

/** ISO string with the local UTC offset, e.g. 2026-10-12T08:30:00.000-05:00 */
export function toLocalIso(d: Date): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(abs / 60)}:${pad(abs % 60)}`
  )
}

export function compactStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
