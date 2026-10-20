import { useEffect, useRef } from 'react'
import { formatElapsed, formatWallClock, wallClockAt } from '@shared/time'
import { player } from '../player/player'
import { perFor, useApp } from '../state/store'
import { IconBack10, IconCamera, IconExport, IconFrameNext, IconFramePrev, IconFwd10, IconPause, IconPlay, IconX } from './Icons'

const RATES = [0.25, 0.5, 1, 2, 4, 8]

export function Transport() {
  const s = useApp()
  const rec = s.recordings.find((r) => r.id === s.selectedId)
  const single = s.layout === 'single'
  const per = single && rec ? perFor(rec.id) : null

  useEffect(() => {
    if (single && rec && !s.keyframes[rec.id] && !rec.error) {
      window.axhibit
        .keyframes(rec.id)
        .then((k) => useApp.setState((st) => ({ keyframes: { ...st.keyframes, [rec.id]: k } })))
        .catch(() => undefined)
    }
  }, [rec?.id, single])

  const dur = single ? s.duration || rec?.durationSec || 0 : s.duration
  const pos = single ? s.time : (s.time - player.gridSpan.startMs) / 1000
  const label = (() => {
    if (single) {
      const d = wallClockAt(rec?.wallClockStart, s.time)
      return { main: d ? formatWallClock(d, true) : formatElapsed(s.time, true), sub: `${formatElapsed(s.time, true)} / ${formatElapsed(dur)}` }
    }
    return { main: formatWallClock(new Date(s.time), true), sub: `${formatElapsed(pos)} / ${formatElapsed(dur)}` }
  })()

  return (
    <section aria-label="Playback" className="panel shrink-0 px-3.5 py-3 flex flex-col gap-2.5 select-none">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-col gap-0.5 shrink-0 leading-tight whitespace-nowrap">
          <span className="font-mono text-[17px] font-medium text-white tabular-nums tracking-tight">
            {label.main}
            {single && rec?.wallClockApprox && rec.wallClockStart && <span className="text-amber-400" title="From file name — approximate"> ≈</span>}
          </span>
          <span className="font-mono text-[11px] text-ink-400 tabular-nums">{label.sub}</span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <button className="icon-btn" aria-label="Back 10 seconds" title="Back 10 s (Shift+←)" onClick={() => player.jump(-10)}><IconBack10 size={18} /></button>
          <button className="icon-btn" aria-label="Previous frame" title="Previous frame (←)" onClick={() => player.step(-1)}><IconFramePrev size={18} /></button>
          <button className="w-11 h-11 rounded-full bg-amber-500 hover:bg-amber-400 text-ink-950 grid place-items-center" aria-label={s.playing ? 'Pause' : 'Play'} title="Play / pause (Space)" onClick={() => player.toggle()}>
            {s.playing ? <IconPause size={17} /> : <IconPlay size={18} className="translate-x-px" />}
          </button>
          <button className="icon-btn" aria-label="Next frame" title="Next frame (→)" onClick={() => player.step(1)}><IconFrameNext size={18} /></button>
          <button className="icon-btn" aria-label="Forward 10 seconds" title="Forward 10 s (Shift+→)" onClick={() => player.jump(10)}><IconFwd10 size={18} /></button>
          <label className="ml-1.5">
            <span className="sr-only">Playback speed</span>
            <select className="h-7 rounded-[7px] border border-ink-600 bg-transparent px-1.5 font-mono text-xs text-ink-100 outline-none focus:border-amber-500" value={s.rate} onChange={(e) => player.setRate(Number(e.target.value))} title="Playback speed (J / L)">
              {RATES.map((r) => (
                <option key={r} value={r} className="bg-ink-850">{r}×</option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex-1" />
        {single && per && (
          <div className="flex items-center gap-1.5 whitespace-nowrap ml-auto">
            <div role="group" aria-label="Clip range" className="flex rounded-lg border border-ink-600 overflow-hidden">
              <button className="h-8 px-2.5 bg-ink-800 hover:bg-ink-700 font-mono text-xs text-ink-100 tabular-nums border-r border-ink-600" title="Set in point (I)" onClick={() => setIn()}>
                <span className="text-amber-400">[</span> {per.inSec !== null ? formatElapsed(per.inSec) : 'In'}
              </button>
              <button className="h-8 px-2.5 bg-ink-800 hover:bg-ink-700 font-mono text-xs text-ink-100 tabular-nums" title="Set out point (O)" onClick={() => setOut()}>
                {per.outSec !== null ? formatElapsed(per.outSec) : 'Out'} <span className="text-amber-400">]</span>
              </button>
              {(per.inSec !== null || per.outSec !== null) && (
                <button className="h-8 w-8 grid place-items-center bg-ink-800 hover:bg-ink-700 text-ink-400 hover:text-white border-l border-ink-600" aria-label="Clear in and out" title="Clear in/out" onClick={() => rec && s.updatePer(rec.id, (x) => ({ ...x, inSec: null, outSec: null }))}>
                  <IconX size={13} />
                </button>
              )}
            </div>
            <button className="btn-sm" title="Snapshot (S)" aria-label="Snapshot" onClick={() => void takeSnapshot()}><IconCamera size={15} /><span className="hidden 2xl:inline">Snapshot</span></button>
            <button className="btn-primary h-8 px-3.5" title="Export clip (E)" onClick={() => useApp.setState({ exportOpen: true })}><IconExport size={15} strokeWidth={2.2} />Export clip</button>
          </div>
        )}
        {!single && <div className="text-xs text-ink-400">Synced playback · double-click a camera to open it</div>}
      </div>
      <Timeline dur={dur} pos={pos} />
    </section>
  )
}

export function setIn() {
  const s = useApp.getState()
  if (!s.selectedId) return
  const t = player.currentMediaTime()
  s.updatePer(s.selectedId, (x) => ({ ...x, inSec: t, outSec: x.outSec !== null && x.outSec <= t ? null : x.outSec }))
}

export function setOut() {
  const s = useApp.getState()
  if (!s.selectedId) return
  const t = player.currentMediaTime()
  s.updatePer(s.selectedId, (x) => ({ ...x, outSec: t, inSec: x.inSec !== null && x.inSec >= t ? null : x.inSec }))
}

export async function takeSnapshot() {
  const s = useApp.getState()
  const rec = s.recordings.find((r) => r.id === s.selectedId)
  if (!rec?.video) return
  const dir = s.settings?.defaultOutputDir ?? (await window.axhibit.pickOutputDir())
  if (!dir) return
  try {
    const per = perFor(rec.id)
    const view = per.fisheye ? player.effectiveView(rec.id, player.currentMediaTime()) : { ...per.view, mode: 'normal' as const }
    const [w, h] = view.mode === 'normal' ? normalOutSize(rec.video.width, rec.video.height, view.normal.zoom) : [1920, 1080]
    const png = await player.snapshot(rec, w, h)
    const t = player.currentMediaTime()
    const d = wallClockAt(rec.wallClockStart, t)
    const stem = `${rec.cameraName ?? 'snapshot'} ${d ? formatWallClock(d).replace(/:/g, '-') : formatElapsed(t).replace(/:/g, '-')}`
    const res = await window.axhibit.exportSnapshot({
      recordingId: rec.id, png, width: w, height: h, mediaTimeSec: t, view, calib: per.fisheye ? player.calibFor(rec) : null,
      redactions: per.redactions, outputDir: dir, fileStem: stem, notes: null
    })
    s.toast({ kind: 'success', text: 'Snapshot saved', action: { label: 'Show', run: () => void window.axhibit.reveal(res.outputPath) } })
  } catch (err) {
    s.toast({ kind: 'error', text: 'Snapshot failed', detail: err instanceof Error ? err.message : String(err) })
  }
}

/** Output size that keeps source detail for the visible region of the normal view (screen aspect). */
export function normalOutSize(srcW: number, srcH: number, zoom: number): [number, number] {
  const vp = player.cssViewport()
  const scale = Math.min(vp.w / srcW, vp.h / srcH) * zoom
  let w = Math.min(srcW, vp.w / scale)
  let h = Math.min(srcH, vp.h / scale)
  const cap = 3840
  if (w > cap) {
    h = (h * cap) / w
    w = cap
  }
  return [Math.max(2, Math.round(w / 2) * 2), Math.max(2, Math.round(h / 2) * 2)]
}

function Timeline({ dur, pos }: { dur: number; pos: number }) {
  const s = useApp()
  const ref = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const single = s.layout === 'single'
  const rec = s.recordings.find((r) => r.id === s.selectedId)
  const per = single && rec ? perFor(rec.id) : null
  const keys = single && rec ? s.keyframes[rec.id] ?? [] : []
  const pct = (t: number) => (dur > 0 ? Math.max(0, Math.min(100, (t / dur) * 100)) : 0)

  const seekAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    if (single) player.seek(f * dur)
    else player.seek(player.gridSpan.startMs + f * dur * 1000)
  }

  const signed = single && rec ? s.signed[rec.id] : undefined

  const ticks = rulerTicks(dur)
  const lanes = per && (per.redactions.length > 0 || per.viewPath.length > 0 || !!per.zoomPath?.keyframes.length)

  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-2.5 gap-y-1 items-center">
      <span />
      <div className="relative h-4 font-mono text-[10px] text-ink-500" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t} className="absolute -translate-x-0" style={{ left: `${pct(t)}%` }}>{formatElapsed(t)}</span>
        ))}
      </div>

      <span className="text-[11.5px] text-ink-300">{single ? 'Video' : 'Cameras'}</span>
      <div
        ref={ref}
        role="slider"
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(pos)}
        tabIndex={0}
        className="relative h-[34px] rounded-[7px] bg-ink-900 border border-ink-700 cursor-pointer overflow-hidden"
        onMouseDown={(e) => {
          dragging.current = true
          seekAt(e.clientX)
          const mv = (ev: MouseEvent) => dragging.current && seekAt(ev.clientX)
          const up = () => {
            dragging.current = false
            window.removeEventListener('mousemove', mv)
            window.removeEventListener('mouseup', up)
          }
          window.addEventListener('mousemove', mv)
          window.addEventListener('mouseup', up)
        }}
      >
        {ticks.map((t) => (
          <div key={t} className="absolute top-0 bottom-0 w-px bg-ink-800" style={{ left: `${pct(t)}%` }} />
        ))}
        {!single && <GridCoverage dur={dur} />}
        {keys.map((k, i) => (
          <div key={i} className="absolute top-0 h-1.5 w-px bg-ink-600" style={{ left: `${pct(k)}%` }} />
        ))}
        {per && per.inSec !== null && (
          <div className="absolute top-0 bottom-0 bg-amber-500/[0.16] border-l-2 border-amber-500" style={{ left: `${pct(per.inSec)}%`, right: `${100 - pct(per.outSec ?? dur)}%` }} />
        )}
        {per && per.outSec !== null && <div className="absolute top-0 bottom-0 border-r-2 border-amber-500" style={{ left: 0, width: `${pct(per.outSec)}%` }} />}
        {signed && 'invalidRanges' in signed &&
          signed.invalidRanges.map((r, i) => (
            <div key={i} className="absolute bottom-0 h-1.5 bg-evid-bad" style={{ left: `${pct(r.fromSec)}%`, width: `${pct(r.toSec) - pct(r.fromSec)}%` }} title={r.reason} />
          ))}
        {signed && 'status' in signed && signed.status === 'verified' && <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-evid-ok/80" title="Signed video verified" />}
        <div className="absolute -top-px -bottom-px w-0.5 bg-white shadow-[0_0_8px_rgba(255,255,255,0.5)]" style={{ left: `${pct(pos)}%` }} />
      </div>

      {lanes && per && (
        <>
          {per.viewPath.length > 0 && <TrackLane label="View path" color="#6ea8ff" times={per.viewPath.map((k) => k.tSec)} pct={pct} onDiamond={(t) => player.seek(t)} />}
          {!!per.zoomPath?.keyframes.length && <TrackLane label="Zoom path" color="#8b95ff" times={per.zoomPath.keyframes.map((k) => k.tSec)} pct={pct} onDiamond={(t) => player.seek(t)} onClick={() => useApp.setState({ rightTab: 'view' })} />}
          {per.redactions.map((tr, i) => (
            <TrackLane
              key={tr.id}
              label={`Redaction ${i + 1}`}
              color={s.selectedTrack === tr.id ? '#ffcc33' : '#f0566a'}
              times={tr.keyframes.map((k) => k.tSec)}
              pct={pct}
              span={tr.range === 'keyframes' && tr.keyframes.length > 1}
              onClick={() => useApp.setState({ selectedTrack: tr.id, rightTab: 'redact' })}
            />
          ))}
        </>
      )}
    </div>
  )
}

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600, 7200]

/** Evenly spaced ruler labels: about 5–8 across the duration. */
function rulerTicks(dur: number): number[] {
  if (!(dur > 0)) return []
  const step = TICK_STEPS.find((st) => dur / st <= 7) ?? Math.ceil(dur / 7 / 3600) * 3600
  const out: number[] = []
  for (let t = 0; t < dur - step * 0.4; t += step) out.push(t)
  return out
}

function TrackLane({ label, color, times, pct, span = true, onClick, onDiamond }: { label: string; color: string; times: number[]; pct: (t: number) => number; span?: boolean; onClick?: () => void; onDiamond?: (t: number) => void }) {
  const sorted = [...times].sort((a, b) => a - b)
  return (
    <>
      <button className="flex items-center gap-1.5 text-[11.5px] text-ink-400 hover:text-ink-100 text-left truncate" onClick={onClick} title={label}>
        <span aria-hidden="true" className="w-2 h-2 rounded-sm shrink-0" style={{ background: color }} />
        <span className="truncate">{label}</span>
      </button>
      <div className="relative h-3.5 cursor-pointer" onClick={onClick} title={label}>
        {span && sorted.length > 1 && <div className="absolute top-1.5 h-0.5" style={{ left: `${pct(sorted[0])}%`, width: `${pct(sorted[sorted.length - 1]) - pct(sorted[0])}%`, background: color, opacity: 0.6 }} />}
        {!span && <div className="absolute top-1.5 h-0.5 left-0 right-0" style={{ background: color, opacity: 0.35 }} />}
        {sorted.map((t, i) => (
          <div
            key={i}
            className="absolute top-[3px] w-2 h-2 rotate-45 -ml-1 hover:scale-150 transition-transform"
            style={{ left: `${pct(t)}%`, background: color }}
            title={onDiamond ? `${label}: go to keyframe` : label}
            onClick={onDiamond ? (e) => { e.stopPropagation(); onDiamond(t) } : undefined}
          />
        ))}
      </div>
    </>
  )
}

function GridCoverage({ dur }: { dur: number }) {
  const span = player.gridSpan
  const rows = player.tiles
  if (!rows.length || dur <= 0) return null
  const h = 100 / rows.length
  return (
    <>
      {rows.map((t, i) =>
        t.segments.map((seg) => {
          if (!seg.wallClockStart) return null
          const off = (useApp.getState().gridOffsets[t.cameraKey] ?? 0) * 1000
          const a = (Date.parse(seg.wallClockStart) + off - span.startMs) / 1000
          return (
            <div key={seg.id} className="absolute bg-amber-500/25 border-x border-amber-500/40" style={{ top: `${i * h}%`, height: `${h}%`, left: `${(a / dur) * 100}%`, width: `${(seg.durationSec / dur) * 100}%` }} title={`${t.label}: ${seg.fileName}`} />
          )
        })
      )}
    </>
  )
}
