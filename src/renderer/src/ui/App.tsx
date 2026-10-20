import { useEffect } from 'react'
import { upsertKeyframe } from '@shared/tracks'
import { DEFAULT_SETTINGS_RENDERER } from '../state/defaults'
import { player } from '../player/player'
import { perFor, useApp } from '../state/store'
import { ExportDialog } from './ExportDialog'
import { IconGrid, IconHelp, IconLock, IconSliders, IconSquare, IconX } from './Icons'
import { addZoomKeyframe, RightPanel, setMode } from './RightPanel'
import { Sidebar, startGrid } from './Sidebar'
import { setIn, setOut, takeSnapshot, Transport } from './Transport'
import { openPathsInto, Viewport } from './Viewport'

export function App() {
  const s = useApp()

  useEffect(() => {
    const api = window.axhibit
    void api.appInfo().then((appInfo) => useApp.setState({ appInfo }))
    void api.storeGet('settings').then((settings) => useApp.setState({ settings: { ...DEFAULT_SETTINGS_RENDERER, ...settings } }))
    void api.storeGet('calibrations').then((calibrations) => useApp.setState({ calibrations: calibrations ?? {} }))
    const offJobs = api.onJobEvent((e) => {
      useApp.setState((st) => {
        const j = st.jobs[e.jobId] ?? { id: e.jobId, label: 'Working', progress: 0, status: 'running' as const, kind: 'prepare' as const }
        const next = { ...j }
        if (e.kind === 'progress') {
          next.progress = e.progress ?? j.progress
          next.message = e.message ?? j.message
        } else if (e.kind === 'done') {
          next.status = 'done'
          next.progress = 1
          next.result = e.result
        } else {
          next.status = 'error'
          next.error = e.message
        }
        return { jobs: { ...st.jobs, [e.jobId]: next } }
      })
    })
    const offOpen = api.onOpenPaths((p) => void openPathsInto(p))
    return () => {
      offJobs()
      offOpen()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const st = useApp.getState()
      if (st.exportOpen || st.settingsOpen) {
        if (e.key === 'Escape') useApp.setState({ exportOpen: false, settingsOpen: false, shortcutsOpen: false })
        return
      }
      const rec = st.recordings.find((r) => r.id === st.selectedId)
      const k = e.key
      const single = st.layout === 'single'
      if (k === ' ') {
        e.preventDefault()
        player.toggle()
      } else if (k === 'ArrowLeft') {
        e.preventDefault()
        if (e.shiftKey) player.jump(-10)
        else player.step(-1)
      } else if (k === 'ArrowRight') {
        e.preventDefault()
        if (e.shiftKey) player.jump(10)
        else player.step(1)
      } else if (k === 'j' || k === 'J') player.setRate(Math.max(0.25, st.rate / 2))
      else if (k === 'l' || k === 'L') player.setRate(Math.min(8, st.rate * 2))
      else if ((k === 'i' || k === 'I') && single) setIn()
      else if ((k === 'o' || k === 'O') && single) setOut()
      else if ((k === 's' || k === 'S') && single && !e.ctrlKey) void takeSnapshot()
      else if ((k === 'e' || k === 'E') && single && rec) useApp.setState({ exportOpen: true })
      else if ((k === 'f' || k === 'F') && rec) st.updatePer(rec.id, (x) => ({ ...x, fisheye: !x.fisheye, view: { ...x.view, mode: !x.fisheye && x.view.mode === 'normal' ? 'ptz' : x.view.mode } }))
      else if (/^[1-5]$/.test(k) && rec) setMode(rec, (['normal', 'ptz', 'pano', 'dualpano', 'quad'] as const)[Number(k) - 1])
      else if ((k === 'b' || k === 'B') && single) useApp.setState({ rightTab: 'redact', tool: st.tool === 'redact-draw' ? 'none' : 'redact-draw' })
      else if ((k === 'k' || k === 'K') && rec && single) {
        const per = perFor(rec.id)
        if (per.fisheye && per.view.mode === 'ptz') st.updatePer(rec.id, (x) => ({ ...x, viewPath: upsertKeyframe(x.viewPath, player.currentMediaTime(), { ...x.view.ptz }) }))
        else if (!per.fisheye || per.view.mode === 'normal') addZoomKeyframe(rec)
      } else if ((k === 'z' || k === 'Z') && rec && single && !e.ctrlKey) {
        const per = perFor(rec.id)
        if (!per.fisheye || per.view.mode === 'normal') useApp.setState({ rightTab: 'view', tool: st.tool === 'zoom-box' ? 'none' : 'zoom-box' })
      } else if ((k === 'r' || k === 'R') && rec) {
        st.updatePer(rec.id, (x) => ({ ...x, view: { ...x.view, normal: { zoom: 1, centerX: 0.5, centerY: 0.5 } } }))
      } else if (k === '?') useApp.setState({ shortcutsOpen: !st.shortcutsOpen })
      else if (k === 'Escape') useApp.setState({ tool: 'none', shortcutsOpen: false })
      else if ((k === 'Delete' || k === 'Backspace') && rec && st.selectedTrack) {
        st.updatePer(rec.id, (x) => ({ ...x, redactions: x.redactions.filter((r) => r.id !== st.selectedTrack) }))
        useApp.setState({ selectedTrack: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault()
    const drop = (e: DragEvent) => {
      e.preventDefault()
      const files = [...(e.dataTransfer?.files ?? [])]
      const paths = files.map((f) => window.axhibit.pathForFile(f)).filter(Boolean)
      if (paths.length) void openPathsInto(paths)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  const rec = s.recordings.find((r) => r.id === s.selectedId)
  const grid = s.layout === 'grid'
  const folder = rec ? rec.path.replace(/[\\/][^\\/]+$/, '').split(/[\\/]/).pop() : undefined
  const clipTime = rec?.wallClockStart ? new Date(rec.wallClockStart).toLocaleTimeString([], { hour12: false }) : rec?.fileName
  return (
    <div className="h-screen flex flex-col gap-2 p-2 bg-ink-950 text-ink-200 font-sans">
      <header className="h-11 shrink-0 flex items-center gap-4 pl-2.5 pr-1">
        <div className="flex items-center gap-2.5">
          <div className="w-[26px] h-[26px] rounded-[7px] bg-amber-500 text-ink-950 grid place-items-center font-extrabold text-sm">A</div>
          <span className="font-semibold text-[14px] text-ink-100 tracking-tight">Axhibit A</span>
        </div>
        <nav aria-label="Location" className="flex items-center gap-1.5 text-[12.5px] text-ink-400 min-w-0 truncate">
          {grid ? (
            <span>Synced view · {s.gridCameras.length} cameras</span>
          ) : rec ? (
            <>
              {folder && <span className="truncate">{folder}</span>}
              {folder && <span aria-hidden="true" className="text-ink-600">/</span>}
              <span className="truncate">{rec.cameraName ?? rec.fileName}</span>
              <span aria-hidden="true" className="text-ink-600">/</span>
              <span className="font-mono text-xs text-ink-100">{clipTime}</span>
            </>
          ) : null}
        </nav>
        <div className="flex-1" />
        {s.recordings.length > 0 && (
          <div role="group" aria-label="Layout" className="seg">
            <button className={`seg-item ${!grid ? 'seg-item-on' : ''}`} onClick={() => useApp.setState({ layout: 'single' })}>
              <IconSquare size={14} />Single
            </button>
            <button
              className={`seg-item ${grid ? 'seg-item-on' : ''}`}
              disabled={s.gridCameras.length < 2}
              title={s.gridCameras.length < 2 ? 'Tick Sync on two or more cameras' : 'Play the ticked cameras in sync'}
              onClick={() => startGrid(s.gridCameras)}
            >
              <IconGrid size={14} />Synced{s.gridCameras.length >= 2 ? ` · ${s.gridCameras.length}` : ''}
            </button>
          </div>
        )}
        {s.recordings.length > 0 && (
          <div className="flex items-center gap-2 h-[30px] px-2.5 rounded-lg bg-evid-ok/10 text-[#6fe3ae] text-xs font-medium" title="Axhibit A never writes to, renames or re-muxes source files">
            <IconLock size={14} />
            Originals read-only
          </div>
        )}
        <JobsIndicator />
        <div className="flex gap-0.5">
          <button className="icon-btn w-8 h-8 text-ink-400" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => useApp.setState({ shortcutsOpen: true })}><IconHelp size={17} /></button>
          <button className="icon-btn w-8 h-8 text-ink-400" aria-label="Settings" title="Settings" onClick={() => useApp.setState({ settingsOpen: true })}><IconSliders size={17} /></button>
        </div>
      </header>
      <div className="flex-1 flex gap-2 min-h-0">
        <Sidebar />
        <main className="flex-1 flex flex-col gap-2 min-w-0">
          <Viewport />
          {(rec || grid) && <Transport />}
        </main>
        <RightPanel />
      </div>
      {s.exportOpen && rec?.video && <ExportDialog />}
      {s.settingsOpen && <SettingsDialog />}
      {s.shortcutsOpen && <ShortcutsDialog />}
      <Toasts />
    </div>
  )
}

function JobsIndicator() {
  const jobs = useApp((s) => s.jobs)
  const running = Object.values(jobs).filter((j) => j.status === 'running' && j.kind !== 'prepare')
  if (!running.length) return null
  const j = running[0]
  return (
    <div className="flex items-center gap-2 text-xs text-ink-400">
      <div className="w-[72px] h-1 bg-ink-700 rounded-full overflow-hidden">
        <div className="h-full bg-amber-500" style={{ width: `${Math.round(j.progress * 100)}%` }} />
      </div>
      <span className="truncate max-w-48">{j.label} · {Math.round(j.progress * 100)}%</span>
      {running.length > 1 && <span className="text-ink-500">+{running.length - 1}</span>}
    </div>
  )
}

function Toasts() {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  return (
    <div className="fixed bottom-24 right-4 z-50 flex flex-col gap-2 w-80">
      {toasts.map((t) => (
        <div key={t.id} className={`rounded-xl border px-3.5 py-3 text-[13px] shadow-2xl bg-ink-800 ${t.kind === 'error' ? 'border-evid-bad/60' : t.kind === 'success' ? 'border-evid-ok/50' : 'border-ink-600'}`}>
          <div className="flex gap-2 items-start">
            <span className="flex-1 text-ink-100">{t.text}</span>
            {t.action && <button className="text-amber-400 text-xs hover:underline" onClick={t.action.run}>{t.action.label}</button>}
            <button className="text-ink-400 hover:text-white" aria-label="Dismiss" onClick={() => dismiss(t.id)}><IconX size={14} /></button>
          </div>
          {t.detail && (
            <div className="mt-1.5">
              <pre className="text-[10.5px] text-ink-400 whitespace-pre-wrap break-words max-h-28 overflow-y-auto">{t.detail}</pre>
              <button className="text-[11px] text-ink-400 hover:text-white mt-1" onClick={() => void navigator.clipboard.writeText(t.detail ?? '')}>Copy details</button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function SettingsDialog() {
  const s = useApp()
  const settings = s.settings ?? DEFAULT_SETTINGS_RENDERER
  const info = s.appInfo
  const save = (patch: Partial<typeof settings>) => {
    const next = { ...settings, ...patch }
    useApp.setState({ settings: next })
    void window.axhibit.storeSet('settings', next)
  }
  return (
    <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm grid place-items-center" onMouseDown={() => useApp.setState({ settingsOpen: false })}>
      <div className="w-[480px] bg-ink-850 border border-ink-700 rounded-2xl shadow-2xl p-6 space-y-4 text-[13px]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center">
          <h2 className="font-semibold text-[15px] text-ink-100 flex-1">Settings</h2>
          <button className="icon-btn w-8 h-8" aria-label="Close" onClick={() => useApp.setState({ settingsOpen: false })}><IconX size={16} /></button>
        </div>
        <label className="block">
          <span className="text-xs text-ink-400">Your name (recorded in export manifests)</span>
          <input className="input mt-1" value={settings.operatorName} onChange={(e) => save({ operatorName: e.target.value })} placeholder={info?.osUser} />
        </label>
        <div>
          <span className="text-xs text-ink-400">Default export folder</span>
          <div className="flex gap-2 mt-1">
            <div className="input flex-1 truncate text-xs">{settings.defaultOutputDir ?? 'Ask each time'}</div>
            <button className="btn-xs" onClick={async () => { const d = await window.axhibit.pickOutputDir(); if (d) save({ defaultOutputDir: d }) }}>Browse…</button>
            {settings.defaultOutputDir && <button className="btn-xs" onClick={() => save({ defaultOutputDir: null })}>Clear</button>}
          </div>
        </div>
        <label className="block">
          <span className="text-xs text-ink-400">Default trim mode</span>
          <select className="input mt-1" value={settings.defaultTrimMode} onChange={(e) => save({ defaultTrimMode: e.target.value as 'fast' | 'exact' })}>
            <option value="exact">Exact (frame-accurate)</option>
            <option value="fast">Fast (copy, snaps to keyframes)</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-ink-400">Video encoder</span>
          <select className="input mt-1" value={settings.encoderOverride ?? ''} onChange={(e) => save({ encoderOverride: e.target.value || null })}>
            <option value="">Automatic ({info?.encoders[0] ?? 'detecting…'})</option>
            {info?.encoders.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-ink-400">Playback cache limit (GB)</span>
          <input type="number" min={2} max={500} className="input mt-1" value={settings.cacheLimitGb} onChange={(e) => save({ cacheLimitGb: Math.max(2, Number(e.target.value) || 20) })} />
        </label>
        <div className="pt-3 border-t border-ink-800 text-[11px] text-ink-500 space-y-1">
          <div>{info?.name} {info?.version} · FFmpeg {info?.ffmpegVersion} (LGPL) · Signed-video validator {info?.signedVideoValidator ? 'included' : 'not included'}</div>
          <div>Not an Axis product. Uses FFmpeg (LGPL v2.1) and the Axis signed-video-framework (MIT). Licenses are in the app's resources folder.</div>
        </div>
      </div>
    </div>
  )
}

function ShortcutsDialog() {
  const rows: [string, string][] = [
    ['Space', 'Play / pause'], ['← / →', 'Previous / next frame'], ['Shift + ← / →', 'Back / forward 10 s'], ['J / L', 'Slower / faster'],
    ['I / O', 'Set in / out point'], ['E', 'Export clip'], ['S', 'Snapshot'], ['F', 'Fisheye on / off'], ['1 – 5', 'Raw / PTZ / Panorama / Double / Quad'],
    ['B', 'Draw redaction box'], ['K', 'Add path keyframe (zoom or PTZ)'], ['Z', 'Draw a zoom-path frame'], ['R', 'Reset zoom'], ['Delete', 'Delete selected box'], ['Double-click', 'Center PTZ / open camera from grid']
  ]
  return (
    <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm grid place-items-center" onMouseDown={() => useApp.setState({ shortcutsOpen: false })}>
      <div className="w-[440px] bg-ink-850 border border-ink-700 rounded-2xl shadow-2xl p-6" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="font-semibold text-[15px] text-ink-100 mb-4">Keyboard shortcuts</h2>
        <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-[13px]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt><kbd className="px-1.5 py-0.5 rounded-md bg-ink-800 border border-ink-600 text-[11px] font-mono text-ink-200">{k}</kbd></dt>
              <dd className="text-ink-300">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
