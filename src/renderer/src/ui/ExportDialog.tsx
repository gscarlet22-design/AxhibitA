import { useEffect, useMemo, useState } from 'react'
import { sampleTimes } from '@shared/export/footprint'
import { even, keyframeAtOrBefore } from '@shared/ffmpeg/args'
import type { ExportRequest, ExportResult, ExportView } from '@shared/ipc'
import { formatElapsed, formatWallClock, wallClockAt } from '@shared/time'
import { maxUpscale } from '@shared/zoom'
import { player } from '../player/player'
import { perFor, useApp, waitJob } from '../state/store'
import { normalOutSize } from './Transport'
import { Progress } from './Viewport'
import { IconExport, IconX } from './Icons'

type ViewChoice = 'original' | 'current' | 'path' | 'zoompath'
const ZOOM_HEIGHTS = [720, 1080, 1440, 2160]
const PRESETS: [number, number][] = [[1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]]

export function ExportDialog() {
  const s = useApp()
  const rec = s.recordings.find((r) => r.id === s.selectedId)!
  const per = perFor(rec.id)
  const v = rec.video!
  const dewarped = per.fisheye && per.view.mode !== 'normal'
  const zoomed = !dewarped && per.view.normal.zoom > 1.001
  const hasPath = per.fisheye && per.view.mode === 'ptz' && per.viewPath.length >= 2
  const zoomPath = (!per.fisheye || per.view.mode === 'normal') && per.zoomPath && per.zoomPath.keyframes.length >= 2 ? per.zoomPath : null
  const zoomSize = (h: number): [number, number] => [even(h * (zoomPath?.aspect ?? 16 / 9)), h]
  const activeRedactions = per.redactions.filter((r) => r.enabled && r.keyframes.length)

  const [choice, setChoice] = useState<ViewChoice>(zoomPath && per.followZoom ? 'zoompath' : hasPath ? 'path' : dewarped || zoomed ? 'current' : 'original')
  const [size, setSize] = useState<[number, number]>([v.width, v.height])
  const [trim, setTrim] = useState<'exact' | 'fast'>(s.settings?.defaultTrimMode ?? 'exact')
  const [ts, setTs] = useState(true)
  const [cam, setCam] = useState(true)
  const [custom, setCustom] = useState('')
  const [redact, setRedact] = useState(activeRedactions.length > 0)
  const [audio, setAudio] = useState(!!rec.audio)
  const [dir, setDir] = useState<string | null>(s.settings?.defaultOutputDir ?? null)
  // settings can arrive after the dialog opens; pick up the default folder unless the user already chose one
  useEffect(() => {
    if (!dir && s.settings?.defaultOutputDir) setDir(s.settings.defaultOutputDir)
  }, [s.settings?.defaultOutputDir])
  const [notes, setNotes] = useState('')
  const [ack, setAck] = useState(!!s.settings?.integrityNoticeAcknowledged)
  const [job, setJob] = useState<string | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const inSec = per.inSec ?? 0
  const outSec = per.outSec ?? (s.duration || rec.durationSec)
  const keys = s.keyframes[rec.id] ?? []
  const snappedIn = keys.length ? keyframeAtOrBefore(keys, inSec) : inSec

  // sensible default sizes per view
  useEffect(() => {
    if (choice === 'original') setSize([v.width, v.height])
    else if (choice === 'path') setSize([1920, 1080])
    else if (choice === 'zoompath') setSize(zoomSize(1080))
    else if (!dewarped) setSize(normalOutSize(v.width, v.height, per.view.normal.zoom))
    else if (per.view.mode === 'pano') setSize([3840, 1080])
    else if (per.view.mode === 'dualpano') setSize([1920, 1440])
    else setSize([1920, 1080])
  }, [choice])

  const overlayOn = ts || cam || !!custom.trim()
  const pixelOps = choice !== 'original' || (redact && activeRedactions.length > 0) || overlayOn
  const fastAllowed = !pixelOps
  const effectiveTrim = fastAllowed ? trim : 'exact'

  const d0 = wallClockAt(rec.wallClockStart, inSec)
  // export zooms past the source's native detail: say so (it adds no information)
  const upscale = choice === 'zoompath' && zoomPath ? maxUpscale(zoomPath, size[1], sampleTimes(zoomPath.keyframes.map((k) => k.tSec), inSec, outSec), v.width, v.height) : 0

  const stemDefault = useMemo(() => `${rec.cameraName ?? 'clip'} ${d0 ? formatWallClock(d0).replace(/:/g, '-') : formatElapsed(inSec).replace(/:/g, '-')} ${Math.round(outSec - inSec)}s`, [rec.id, inSec, outSec])
  const [stem, setStem] = useState(stemDefault)

  const job_ = job ? s.jobs[job] : undefined
  const running = job_?.status === 'running'

  const go = async () => {
    setError(null)
    let outDir = dir
    if (!outDir) {
      outDir = await window.axhibit.pickOutputDir()
      if (!outDir) return
      setDir(outDir)
    }
    if (!ack) return
    if (!s.settings?.integrityNoticeAcknowledged && s.settings) {
      const settings = { ...s.settings, integrityNoticeAcknowledged: true }
      useApp.setState({ settings })
      void window.axhibit.storeSet('settings', settings)
    }
    const calib = per.fisheye ? player.calibFor(rec) : null
    let view: ExportView
    if (choice === 'original') view = { kind: 'original' }
    else if (choice === 'path') view = { kind: 'view-path', keyframes: per.viewPath, calib: calib! }
    else if (choice === 'zoompath' && zoomPath) view = { kind: 'zoom-path', path: zoomPath }
    else view = { kind: 'current', view: dewarped ? per.view : { ...per.view, mode: 'normal' }, calib }
    const viewForExport: ExportView = view.kind === 'current' && view.view.mode === 'normal'
      ? { ...view, view: { ...view.view, normal: { ...view.view.normal, zoom: zoomFor(size) } } }
      : view
    const req: ExportRequest = {
      recordingId: rec.id,
      inSec,
      outSec,
      trimMode: effectiveTrim,
      view: viewForExport,
      outW: size[0],
      outH: size[1],
      redactions: redact ? activeRedactions : [],
      overlay: { timestamp: ts, cameraName: cam, customText: custom.trim() || null },
      includeAudio: audio,
      outputDir: outDir,
      fileStem: stem,
      notes: notes.trim() || null
    }
    try {
      const id = await window.axhibit.exportClip(req)
      useApp.setState((x) => ({ jobs: { ...x.jobs, [id]: { id, label: `Exporting ${stem}`, progress: 0, status: 'running', kind: 'export', recordingId: rec.id } } }))
      setJob(id)
      const res = await waitJob<ExportResult>(id)
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** Normal-view zoom that reproduces the on-screen framing at the chosen output size. */
  const zoomFor = ([w, h]: [number, number]) => {
    const vp = player.cssViewport()
    const screenScale = Math.min(vp.w / v.width, vp.h / v.height) * per.view.normal.zoom
    const visW = vp.w / screenScale
    const fit = Math.min(w / v.width, h / v.height)
    return w / visW / fit
  }

  const close = () => !running && useApp.setState({ exportOpen: false })

  return (
    <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm grid place-items-center" onMouseDown={close}>
      <div className="w-[560px] max-h-[calc(100vh-32px)] flex flex-col bg-ink-850 border border-ink-700 rounded-2xl shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="px-5 py-3.5 border-b border-ink-750 flex items-center shrink-0">
          <h2 className="font-semibold text-[15px] text-ink-100 flex-1">Export clip</h2>
          <button className="icon-btn w-8 h-8" aria-label="Close" onClick={close}><IconX size={16} /></button>
        </div>

        {result ? (
          <div className="p-5 space-y-4">
            <div className="text-evid-ok font-semibold">Export complete</div>
            <div className="text-xs text-ink-300 break-all">{result.outputPath}</div>
            <div className="text-xs text-ink-400">A manifest with hashes and every processing step was saved beside it ({result.manifestPath.split(/[\\/]/).pop()}). Send both files together.</div>
            <div className="flex gap-2">
              <button className="btn-primary" onClick={() => void window.axhibit.reveal(result.outputPath)}>Show in folder</button>
              <button className="btn" onClick={() => useApp.setState({ exportOpen: false })}>Done</button>
            </div>
          </div>
        ) : (
          <>
          <div className="px-5 py-4 space-y-4 text-sm overflow-y-auto min-h-0 flex-1">
            <Row label="Range">
              <div className="font-mono text-xs text-ink-200">
                {formatElapsed(inSec, true)} → {formatElapsed(outSec, true)} <span className="text-ink-400">({(outSec - inSec).toFixed(1)} s)</span>
              </div>
              {per.inSec === null && per.outSec === null && <div className="text-[11px] text-ink-500">Whole recording. Set In/Out (I / O) on the timeline to export part of it.</div>}
            </Row>

            <Row label="Picture">
              <div className="flex flex-col gap-1.5">
                <Radio checked={choice === 'original'} onChange={() => setChoice('original')} label="Original frame" sub={`${v.width}×${v.height}, as recorded`} />
                <Radio checked={choice === 'current'} onChange={() => setChoice('current')} label="Current view" sub={dewarped ? `Dewarped ${labelFor(per.view.mode)}` : zoomed ? `Zoomed region (${per.view.normal.zoom.toFixed(1)}×)` : 'Same as original'} />
                {hasPath && <Radio checked={choice === 'path'} onChange={() => setChoice('path')} label="Follow view path" sub={`Animated PTZ, ${per.viewPath.length} keyframes`} />}
                {zoomPath && <Radio checked={choice === 'zoompath'} onChange={() => setChoice('zoompath')} label="Follow zoom path" sub={`Pans and zooms with the path, ${zoomPath.keyframes.length} keyframes`} />}
              </div>
            </Row>

            {choice !== 'original' && (
              <Row label="Size">
                <div className="flex flex-wrap gap-1.5 items-center">
                  {choice === 'zoompath'
                    ? ZOOM_HEIGHTS.map((h) => (
                        <button key={h} className={`btn-xs ${size[1] === h ? 'bg-amber-500 text-ink-950 border-amber-500 hover:bg-amber-400' : ''}`} onClick={() => setSize(zoomSize(h))}>{h}p</button>
                      ))
                    : (dewarped || choice === 'path') && per.view.mode !== 'pano' && per.view.mode !== 'dualpano'
                    ? PRESETS.map((p) => (
                        <button key={p[0]} className={`btn-xs ${size[0] === p[0] && size[1] === p[1] ? 'bg-amber-500 text-ink-950 border-amber-500 hover:bg-amber-400' : ''}`} onClick={() => setSize(p)}>{p[1]}p</button>
                      ))
                    : null}
                  <span className="font-mono text-xs text-ink-300 ml-1">{size[0]}×{size[1]}</span>
                </div>
                {upscale > 1.05 && (
                  <div className="text-[11px] text-evid-warn mt-1.5">
                    Upscaled up to ×{upscale.toFixed(1)} where the path zooms in closest. Enlarging adds no detail; a smaller size shows the same information.
                  </div>
                )}
              </Row>
            )}

            <Row label="Trim">
              <div className="flex flex-col gap-1.5">
                <Radio checked={effectiveTrim === 'exact'} onChange={() => setTrim('exact')} label="Exact (re-encode)" sub="Frame-accurate. Required for overlays, redaction, zoom or dewarp." />
                <Radio checked={effectiveTrim === 'fast'} disabled={!fastAllowed} onChange={() => setTrim('fast')} label="Fast (copy, no re-encode)" sub={fastAllowed ? `Untouched video. Starts at the keyframe at ${formatElapsed(snappedIn, true)}${snappedIn < inSec - 0.01 ? ` (${(inSec - snappedIn).toFixed(1)} s early)` : ''}.` : 'Turn off overlays and redaction, and use Original frame.'} />
              </div>
            </Row>

            <Row label="Burn in">
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                <Check checked={ts} onChange={setTs} label="Date & time" />
                <Check checked={cam} onChange={setCam} label="Camera name" />
                {activeRedactions.length > 0 && <Check checked={redact} onChange={setRedact} label={`Redactions (${activeRedactions.length})`} />}
                {rec.audio && <Check checked={audio} onChange={setAudio} label="Audio" />}
              </div>
              <input className="input mt-2" placeholder="Extra text, e.g. case number (optional)" value={custom} onChange={(e) => setCustom(e.target.value)} />
            </Row>

            <Row label="Save to">
              <div className="flex gap-2 items-center">
                <div className="input flex-1 truncate text-xs" title={dir ?? ''}>{dir ?? 'Choose a folder…'}</div>
                <button className="btn-xs" onClick={async () => { const d = await window.axhibit.pickOutputDir(); if (d) setDir(d) }}>Browse…</button>
              </div>
              <input className="input mt-2" value={stem} onChange={(e) => setStem(e.target.value)} />
              <div className="text-[11px] text-ink-500 mt-1">.mp4 + .mp4.manifest.json · existing files are never overwritten</div>
            </Row>

            <Row label="Notes">
              <textarea className="input h-14 resize-none" placeholder="Recorded in the manifest (who asked for it, case number…)" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Row>

            {!s.settings?.integrityNoticeAcknowledged && (
              <label className="flex gap-2.5 items-start rounded-md border border-amber-600/50 bg-amber-500/5 p-3 text-xs text-ink-200">
                <input type="checkbox" className="accent-amber-500 mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I understand an exported clip is a <b>copy derived from</b> the original evidence, not the original itself. The original export stays unchanged and should be kept. The manifest records exactly how this clip was made.</span>
              </label>
            )}
          </div>

          <div className="px-5 py-3.5 border-t border-ink-750 shrink-0 space-y-2 text-sm">
            {error && <div className="text-xs text-evid-bad whitespace-pre-wrap break-words max-h-32 overflow-y-auto">{error}</div>}

            {running && job_ ? (
              <div className="space-y-2">
                <Progress value={job_.progress} />
                <div className="flex items-center text-xs text-ink-400">
                  <span className="flex-1">{job_.message ?? 'Working…'}</span>
                  <button className="btn-xs" onClick={() => job && void window.axhibit.cancelJob(job)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex justify-end gap-2">
                <button className="btn" onClick={close}>Cancel</button>
                <button className="btn-primary" disabled={!ack || outSec <= inSec} onClick={() => void go()}><IconExport size={15} strokeWidth={2.2} />Export</button>
              </div>
            )}
          </div>
          </>
        )}
      </div>
    </div>
  )
}

function labelFor(m: string) {
  return { ptz: 'PTZ view', pano: 'panorama', dualpano: 'double panorama', quad: 'quad view', normal: 'view' }[m] ?? m
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_1fr] gap-3">
      <div className="text-[11px] uppercase tracking-wider text-ink-400 pt-0.5">{label}</div>
      <div>{children}</div>
    </div>
  )
}

function Radio({ checked, onChange, label, sub, disabled }: { checked: boolean; onChange: () => void; label: string; sub?: string; disabled?: boolean }) {
  return (
    <label className={`flex gap-2 items-start ${disabled ? 'opacity-40' : 'cursor-pointer'}`}>
      <input type="radio" className="accent-amber-500 mt-1" checked={checked} disabled={disabled} onChange={onChange} />
      <span>
        <span className="text-ink-100 text-[13px]">{label}</span>
        {sub && <span className="block text-[11px] text-ink-400">{sub}</span>}
      </span>
    </label>
  )
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex gap-1.5 items-center text-[13px] text-ink-200 cursor-pointer">
      <input type="checkbox" className="accent-amber-500" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}
