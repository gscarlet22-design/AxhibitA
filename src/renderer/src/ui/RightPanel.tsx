import { useState } from 'react'
import { defaultQuad, defaultPtz, viewAvailable } from '@shared/dewarp/views'
import { evalBox, removeKeyframeNear, upsertKeyframe } from '@shared/tracks'
import { entryFromState, stateFromEntry, type ProjectEntry } from '@shared/project'
import { formatElapsed } from '@shared/time'
import { ZOOM_ASPECTS } from '@shared/zoom'
import type { Calibration, Recording, RedactStyle, ViewMode } from '@shared/types'
import { player } from '../player/player'
import { cameraKey, perFor, useApp, waitJob, type SignedState } from '../state/store'
import { Progress } from './Viewport'
import { IconCrosshair, IconDiamond, IconEye, IconFrame, IconInfo, IconPlus, IconRedact, IconScan, IconShield, Kbd, RecDot } from './Icons'

const TABS = [
  ['view', 'View', IconEye],
  ['redact', 'Redact', IconRedact],
  ['verify', 'Verify', IconShield],
  ['info', 'Info', IconInfo]
] as const

export function RightPanel() {
  const s = useApp()
  const rec = s.recordings.find((r) => r.id === s.selectedId)
  if (s.layout === 'grid') return <GridPanel />
  if (!rec) return <aside className="panel w-[316px] shrink-0" />
  return (
    <aside aria-label="Inspector" className="panel w-[316px] shrink-0 flex flex-col min-h-0 overflow-hidden">
      <div role="tablist" aria-label="Inspector sections" className="grid grid-cols-4 gap-0.5 m-2.5 p-[3px] rounded-[10px] bg-ink-900">
        {TABS.map(([k, label, Icon]) => (
          <button
            key={k}
            role="tab"
            aria-selected={s.rightTab === k}
            onClick={() => useApp.setState({ rightTab: k, tool: s.tool === 'calibrate' && k !== 'view' ? 'none' : s.tool })}
            className={`h-11 flex flex-col items-center justify-center gap-[3px] rounded-[7px] text-[11px] font-medium ${s.rightTab === k ? 'bg-ink-700 text-white' : 'text-ink-400 hover:text-ink-100'}`}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto px-2.5 pb-3 flex flex-col gap-2 text-[13px]">
        {s.rightTab === 'view' && <ViewTab rec={rec} />}
        {s.rightTab === 'redact' && <RedactTab rec={rec} />}
        {s.rightTab === 'verify' && <VerifyTab rec={rec} />}
        {s.rightTab === 'info' && <InfoTab rec={rec} />}
      </div>
    </aside>
  )
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="card flex flex-col gap-3">
      <div className="flex items-center gap-2 min-h-[22px]">
        <h3 className="card-title flex-1">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  )
}

const MODES: [ViewMode, string, string][] = [
  ['normal', 'Raw', '1'],
  ['ptz', 'PTZ', '2'],
  ['pano', 'Panorama', '3'],
  ['dualpano', 'Double', '4'],
  ['quad', 'Quad', '5']
]

export function setMode(rec: Recording, mode: ViewMode) {
  const s = useApp.getState()
  const c = player.calibFor(rec)
  if (!viewAvailable(mode, c.mount)) return
  s.updatePer(rec.id, (x) => ({ ...x, fisheye: true, view: { ...x.view, mode } }))
  if (!s.calibrations[cameraKey(rec)]) autoCalibrate(rec, true)
  if (s.tool === 'calibrate') useApp.setState({ tool: 'none' })
}

export function autoCalibrate(rec: Recording, silent = false) {
  const s = useApp.getState()
  const c = player.autoDetectCircle(rec)
  if (!c) {
    if (!silent) s.toast({ kind: 'info', text: "Couldn't find the lens circle automatically — drag the circle to fit in Calibrate." })
    if (!s.calibrations[cameraKey(rec)]) {
      const base = player.calibFor(rec)
      saveCalib(rec, base)
    }
    return
  }
  saveCalib(rec, c)
  if (!silent) s.toast({ kind: 'success', text: 'Lens circle detected' })
}

function saveCalib(rec: Recording, c: Calibration) {
  const key = cameraKey(rec)
  const calibrations = { ...useApp.getState().calibrations, [key]: c }
  useApp.setState({ calibrations })
  void window.axhibit.storeSet('calibrations', calibrations)
}

function ViewTab({ rec }: { rec: Recording }) {
  const s = useApp()
  const per = perFor(rec.id)
  const calib = player.calibFor(rec)
  const hasCalib = !!s.calibrations[cameraKey(rec)]
  const recording = player.isRecordingPath
  return (
    <>
      <Section title="Fisheye dewarp" right={<Toggle label="Fisheye dewarp" on={per.fisheye} onChange={(v) => { s.updatePer(rec.id, (x) => ({ ...x, fisheye: v, view: { ...x.view, mode: v && x.view.mode === 'normal' ? 'ptz' : x.view.mode } })); if (v && !hasCalib) autoCalibrate(rec, true) }} />}>
        {!per.fisheye && <p className="hint">{rec.axis?.isFisheye ? 'This camera reports a fisheye lens.' : 'Turn on for fisheye cameras to dewarp the image.'}</p>}
        {per.fisheye && <p className="hint">Pick a view on the video, or press <Kbd>1</Kbd>–<Kbd>5</Kbd>. Drag to look around; scroll to zoom.</p>}
      </Section>

      {per.fisheye && (
        <Section title="Lens" right={hasCalib ? <span className="text-[11.5px] text-[#6fe3ae]">Calibrated</span> : undefined}>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Mount">
              <select className="input" value={calib.mount} onChange={(e) => { const mount = e.target.value as Calibration['mount']; saveCalib(rec, { ...calib, mount }); s.updatePer(rec.id, (x) => ({ ...x, view: { ...x.view, ptz: defaultPtz(mount), quad: defaultQuad(mount), mode: !viewAvailable(x.view.mode, mount) ? 'pano' : x.view.mode } })) }}>
                <option value="ceiling">Ceiling</option>
                <option value="wall">Wall</option>
                <option value="desk">Desk / floor</option>
              </select>
            </Field>
            <Field label="Lens model">
              <select className="input" value={calib.model} onChange={(e) => saveCalib(rec, { ...calib, model: e.target.value as Calibration['model'] })}>
                <option value="equidistant">Equidistant</option>
                <option value="equisolid">Equisolid</option>
              </select>
            </Field>
            <Field label="Field of view °">
              <input className="input" type="number" min={150} max={220} step={1} value={Math.round(calib.fovDeg)} onChange={(e) => saveCalib(rec, { ...calib, fovDeg: Math.max(150, Math.min(220, Number(e.target.value) || 180)) })} />
            </Field>
            <Field label="Radius px">
              <input className="input" type="number" value={Math.round(calib.radiusPx)} onChange={(e) => saveCalib(rec, { ...calib, radiusPx: Math.max(20, Number(e.target.value) || calib.radiusPx) })} />
            </Field>
          </div>
          <div className="flex gap-1.5">
            <button className={`btn-xs flex-1 ${s.tool === 'calibrate' ? 'bg-amber-500 text-ink-950 border-amber-500 hover:bg-amber-400' : ''}`} onClick={() => useApp.setState({ tool: s.tool === 'calibrate' ? 'none' : 'calibrate' })}>
              <IconCrosshair size={14} />{s.tool === 'calibrate' ? 'Done' : 'Calibrate'}
            </button>
            <button className="btn-xs flex-1" onClick={() => autoCalibrate(rec)}><IconScan size={14} />Auto-detect</button>
          </div>
          {s.tool === 'calibrate' && <p className="hint -mt-1">Drag the center or the dashed edge of the circle.</p>}
        </Section>
      )}

      {per.fisheye && per.view.mode === 'ptz' && (
        <Section title="View path (animated PTZ)">
          <p className="hint">Record pan/tilt/zoom while playing, or add keyframes. Exports can follow the path.</p>
          <div className="flex flex-wrap gap-1.5">
            {!recording ? (
              <button className="btn-rec w-full" onClick={() => { player.startPathRecording(); useApp.setState({}) }}><RecDot />Record path</button>
            ) : (
              <button className="btn-rec w-full bg-evid-bad text-white hover:bg-[#e04459]" onClick={() => { player.pause(); useApp.setState({}) }}><span aria-hidden="true" className="w-2 h-2 rounded-[2px] bg-white" />Stop recording</button>
            )}
            <button className="btn-xs" onClick={() => s.updatePer(rec.id, (x) => ({ ...x, viewPath: upsertKeyframe(x.viewPath, player.currentMediaTime(), { ...x.view.ptz }) }))}><IconDiamond size={11} className="text-path-view" />Add keyframe <Kbd>K</Kbd></button>
            {per.viewPath.length > 0 && <button className="btn-xs" onClick={() => s.updatePer(rec.id, (x) => ({ ...x, viewPath: removeKeyframeNear(x.viewPath, player.currentMediaTime(), 0.25) }))}>Remove here</button>}
            {per.viewPath.length > 0 && <button className="btn-xs" onClick={() => s.updatePer(rec.id, (x) => ({ ...x, viewPath: [] }))}>Clear</button>}
          </div>
          {per.viewPath.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-ink-200">
              <input type="checkbox" className="accent-amber-500" checked={per.followPath} onChange={(e) => s.updatePer(rec.id, (x) => ({ ...x, followPath: e.target.checked }))} />
              Follow path during playback · {per.viewPath.length} keyframes
            </label>
          )}
        </Section>
      )}

      {(!per.fisheye || per.view.mode === 'normal') && (
        <Section title="Digital zoom">
          <p className="hint">Scroll to zoom, drag to pan. Exports of “Current view” keep exactly this framing.</p>
          {per.view.normal.zoom > 1 && <button className="btn-xs self-start" onClick={() => s.updatePer(rec.id, (x) => ({ ...x, followZoom: false, view: { ...x.view, normal: { zoom: 1, centerX: 0.5, centerY: 0.5 } } }))}>Reset zoom ({per.view.normal.zoom.toFixed(1)}×)</button>}
        </Section>
      )}

      {(!per.fisheye || per.view.mode === 'normal') && <ZoomPathSection rec={rec} />}
    </>
  )
}

/** Keyframe the zoom path at the current time with what the frame guide shows. */
export function addZoomKeyframe(rec: Recording) {
  const w = player.guideWindow(rec)
  if (!w) return
  useApp.getState().updatePer(rec.id, (x) => ({
    ...x,
    zoomPath: { aspect: x.zoomPath?.aspect ?? 16 / 9, keyframes: upsertKeyframe(x.zoomPath?.keyframes ?? [], player.currentMediaTime(), w) },
    followZoom: true
  }))
}

function ZoomPathSection({ rec }: { rec: Recording }) {
  const s = useApp()
  const per = perFor(rec.id)
  const path = per.zoomPath
  const n = path?.keyframes.length ?? 0
  const recording = player.isRecordingZoom
  const aspect = path?.aspect ?? 16 / 9
  const ensurePath = () => s.updatePer(rec.id, (x) => ({ ...x, zoomPath: x.zoomPath ?? { aspect, keyframes: [] } }))
  return (
    <Section title="Zoom path (follow a subject)">
      <p className="hint">
        Pan and zoom over time on the full frame. Record while playing (scroll to zoom, drag to pan), or pause and frame moments with keyframes. Exports can follow the path.
      </p>
      <div className="flex items-center gap-1">
        <span className="text-[11px] text-ink-400 mr-1">Frame</span>
        {ZOOM_ASPECTS.map((a) => (
          <button
            key={a.label}
            disabled={n > 0 && Math.abs(a.value - aspect) > 1e-6}
            title={n > 0 ? 'Clear the path to change its shape' : `Export frame ${a.label}`}
            onClick={() => s.updatePer(rec.id, (x) => ({ ...x, zoomPath: { aspect: a.value, keyframes: x.zoomPath?.keyframes ?? [] } }))}
            className={`h-6 px-2 rounded-md text-[11px] border ${path && Math.abs(a.value - aspect) < 1e-6 ? 'bg-path-zoom text-ink-950 border-path-zoom font-semibold' : 'border-ink-700 text-ink-300 hover:bg-ink-800 disabled:opacity-30'}`}
          >
            {a.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {!recording ? (
          <button className="btn-rec w-full" onClick={() => { ensurePath(); player.startZoomRecording(); useApp.setState({}) }}><RecDot />Record path</button>
        ) : (
          <button className="btn-rec w-full bg-evid-bad text-white hover:bg-[#e04459]" onClick={() => { player.pause(); useApp.setState({}) }}><span aria-hidden="true" className="w-2 h-2 rounded-[2px] bg-white" />Stop recording</button>
        )}
        <button className="btn-xs" onClick={() => addZoomKeyframe(rec)}><IconDiamond size={11} className="text-path-zoom" />Keyframe <Kbd>K</Kbd></button>
        <button className={`btn-xs ${s.tool === 'zoom-box' ? 'bg-path-zoom text-ink-950 border-path-zoom hover:bg-path-zoom' : ''}`} onClick={() => { ensurePath(); useApp.setState({ tool: s.tool === 'zoom-box' ? 'none' : 'zoom-box' }) }}>
          {s.tool === 'zoom-box' ? 'Drag a box on the video…' : <><IconFrame size={14} />Draw frame <Kbd>Z</Kbd></>}
        </button>
        {n > 0 && <button className="btn-xs" onClick={() => s.updatePer(rec.id, (x) => ({ ...x, zoomPath: x.zoomPath && { ...x.zoomPath, keyframes: removeKeyframeNear(x.zoomPath.keyframes, player.currentMediaTime(), 0.25) } }))}>Remove here</button>}
        {n > 0 && <button className="btn-xs" onClick={() => s.updatePer(rec.id, (x) => ({ ...x, zoomPath: x.zoomPath && { ...x.zoomPath, keyframes: [] } }))}>Clear</button>}
      </div>
      {n > 0 && (
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-xs text-ink-200">
            <input type="checkbox" className="accent-amber-500" checked={per.followZoom} onChange={(e) => s.updatePer(rec.id, (x) => ({ ...x, followZoom: e.target.checked }))} />
            Follow path during playback · {n} keyframe{n > 1 ? 's' : ''}
          </label>
          {!per.followZoom && !recording && (
            <div className="text-[11px] text-ink-400">
              Paused because you moved the view.{' '}
              <button className="text-path-zoom hover:underline" onClick={() => s.updatePer(rec.id, (x) => ({ ...x, followZoom: true }))}>Resume path</button>
            </div>
          )}
        </div>
      )}
      {path && (
        <label className="flex items-center gap-2 text-xs text-ink-200">
          <input type="checkbox" className="accent-amber-500" checked={per.frameGuide} onChange={(e) => s.updatePer(rec.id, (x) => ({ ...x, frameGuide: e.target.checked }))} />
          Show export frame
        </label>
      )}
    </Section>
  )
}

function RedactTab({ rec }: { rec: Recording }) {
  const s = useApp()
  const per = perFor(rec.id)
  const t = player.currentMediaTime()
  const sel = per.redactions.find((r) => r.id === s.selectedTrack)
  // boxes can be drawn, moved and followed in the raw view and in the PTZ / quad dewarped views
  const rawShown = !per.fisheye || per.view.mode === 'normal' || per.view.mode === 'ptz' || per.view.mode === 'quad'
  const update = (id: string, fn: (r: (typeof per.redactions)[number]) => (typeof per.redactions)[number]) => s.updatePer(rec.id, (x) => ({ ...x, redactions: x.redactions.map((r) => (r.id === id ? fn(r) : r)) }))
  const [followRate, setFollowRate] = useState(0.5)
  const following = player.redactFollow
  return (
    <>
      <Section title="Redaction boxes">
        <p className="hint">
          Draw a box over a face or plate. To keep it on someone who moves, select the box and click <b>Follow while playing</b>, then drag it along with them. Or move it at a few moments and it glides between them. Boxes apply in every view and are burned into exports.
        </p>
        {!rawShown && <div className="text-xs text-amber-400">Switch to the Raw, PTZ or Quad view to draw or move boxes.</div>}
        {rawShown && per.fisheye && per.view.mode !== 'normal' && <p className="text-[11px] text-ink-400">In this view, a box covers the curved shape shown by its outline. Scroll over the selected box to resize it.</p>}
        <button className={`btn-primary w-full ${s.tool === 'redact-draw' ? 'ring-2 ring-amber-300' : ''}`} disabled={!rawShown} onClick={() => useApp.setState({ tool: s.tool === 'redact-draw' ? 'none' : 'redact-draw' })}>
          {s.tool === 'redact-draw' ? 'Drag on the video to draw…' : <><IconPlus size={15} />Draw box <Kbd>B</Kbd></>}
        </button>
        <div className="mt-3">
          <span className="block text-[10.5px] text-ink-500 mb-1">Hide</span>
          <div role="radiogroup" aria-label="What to hide" className="grid grid-cols-2 gap-1">
            {([[null, 'Inside the boxes'], ['blur', 'Everything else']] as const).map(([v, label]) => {
              const on = v === null ? per.redactOutside === null : per.redactOutside !== null
              return (
                <button key={label} role="radio" aria-checked={on} onClick={() => s.updatePer(rec.id, (x) => ({ ...x, redactOutside: v === null ? null : x.redactOutside ?? 'blur' }))}
                  className={`py-1.5 rounded text-[11.5px] border ${on ? 'bg-amber-500 text-ink-950 border-amber-500 font-semibold' : 'border-ink-700 text-ink-300 hover:bg-ink-800'}`}>
                  {label}
                </button>
              )
            })}
          </div>
          {per.redactOutside !== null && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[11px] text-ink-400 flex-1">Only the boxes stay visible. The rest is</span>
              <select className="input w-24 h-7" value={per.redactOutside} onChange={(e) => s.updatePer(rec.id, (x) => ({ ...x, redactOutside: e.target.value as RedactStyle }))}>
                <option value="blur">Blurred</option>
                <option value="pixelate">Pixelated</option>
                <option value="solid">Blacked out</option>
              </select>
            </div>
          )}
          {per.redactOutside !== null && per.redactions.length === 0 && <p className="text-[11px] text-amber-400 mt-1.5">With no boxes, the whole picture is hidden.</p>}
        </div>
      </Section>
      {per.redactions.length > 0 && (
        <div className="space-y-2">
          {per.redactions.map((r, i) => {
            const b = evalBox(r.keyframes, t)
            const sorted = [...r.keyframes].sort((a, c) => a.tSec - c.tSec)
            return (
              <div key={r.id} onClick={() => useApp.setState({ selectedTrack: r.id })} className={`rounded-card border p-3 cursor-pointer ${s.selectedTrack === r.id ? 'border-amber-500 bg-ink-800' : 'border-ink-700 bg-ink-800/60 hover:bg-ink-800'}`}>
                <div className="flex items-center gap-2">
                  <input type="checkbox" className="accent-amber-500" checked={r.enabled} onChange={(e) => update(r.id, (x) => ({ ...x, enabled: e.target.checked }))} onClick={(e) => e.stopPropagation()} />
                  <span className="text-xs font-medium flex-1">Box {i + 1}</span>
                  {per.redactOutside === null ? (
                    <select className="input w-24 h-7" value={r.style} onChange={(e) => update(r.id, (x) => ({ ...x, style: e.target.value as RedactStyle }))} onClick={(e) => e.stopPropagation()}>
                      <option value="pixelate">Pixelate</option>
                      <option value="blur">Blur</option>
                      <option value="solid">Solid</option>
                    </select>
                  ) : (
                    <span className="text-[11px] text-evid-ok">Stays visible</span>
                  )}
                </div>
                <div className="text-[11px] text-ink-400 mt-1.5">
                  {sorted.length} keyframe{sorted.length > 1 ? 's' : ''} · {rangeLabel(r.range, sorted)}
                  {b && ` · ${Math.round(b.w)}×${Math.round(b.h)} px`}
                </div>
                {s.selectedTrack === r.id && (
                  <label className="flex items-center gap-2 mt-2 text-[11px] text-ink-300" onClick={(e) => e.stopPropagation()}>
                    <span className="text-ink-500">Shows</span>
                    <select className="input flex-1 h-7" value={r.range ?? 'all'} onChange={(e) => update(r.id, (x) => ({ ...x, range: e.target.value as 'all' | 'from' | 'keyframes' }))}>
                      <option value="from">From its first keyframe on</option>
                      <option value="keyframes">Only between first and last keyframe</option>
                      <option value="all">For the whole recording</option>
                    </select>
                  </label>
                )}
                {s.selectedTrack === r.id && (
                  <div className="mt-2.5" onClick={(e) => e.stopPropagation()}>
                    {following?.trackId === r.id ? (
                      <button className="btn-rec w-full h-8" onClick={() => { player.pause(); useApp.setState({}) }}>■ Stop following</button>
                    ) : (
                      <div className="flex gap-1.5">
                        <button
                          className="btn-rec flex-1 h-8"
                          disabled={!rawShown || !!following}
                          title="Plays the video; drag the box to keep it on the subject, scroll to resize. Space or Stop ends it."
                          onClick={() => { player.startRedactFollow(r.id, followRate); useApp.setState({}) }}
                        >
                          ● Follow while playing
                        </button>
                        <label>
                          <span className="sr-only">Speed while following</span>
                          <select className="input w-[68px] h-8" value={followRate} onChange={(e) => setFollowRate(Number(e.target.value))} title="Playback speed while following">
                            <option value={1}>1×</option>
                            <option value={0.5}>½×</option>
                            <option value={0.25}>¼×</option>
                          </select>
                        </label>
                      </div>
                    )}
                    {following?.trackId === r.id && <p className="text-[11px] text-ink-400 mt-1.5">Drag anywhere on the video to steer the box; scroll to resize. The path is saved when you stop.</p>}
                  </div>
                )}
                {s.selectedTrack === r.id && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    <button className="btn-xs" onClick={() => b && update(r.id, (x) => ({ ...x, keyframes: upsertKeyframe(x.keyframes, t, b) }))}><IconDiamond size={11} className="text-evid-bad" />Keyframe here</button>
                    <button className="btn-xs" onClick={() => update(r.id, (x) => ({ ...x, keyframes: x.keyframes.length > 1 ? removeKeyframeNear(x.keyframes, t, 0.25) : x.keyframes }))}>Remove here</button>
                    <button className="btn-xs" onClick={() => sorted[0] && player.seek(sorted[0].tSec)}>Go to start</button>
                    <button className="btn-xs text-evid-bad" onClick={() => s.updatePer(rec.id, (x) => ({ ...x, redactions: x.redactions.filter((y) => y.id !== r.id) }))}>Delete</button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      <Section title="Project">
        <p className="hint">Save redactions, view paths and zoom paths to reopen later. Saved next to your exports, never next to the original.</p>
        <div className="flex gap-1.5">
          <button className="btn-xs flex-1" onClick={() => void saveProject()}>Save project…</button>
          <button className="btn-xs flex-1" onClick={() => void loadProject()}>Load project…</button>
        </div>
      </Section>
    </>
  )
}

function rangeLabel(range: 'all' | 'from' | 'keyframes' | undefined, sorted: { tSec: number }[]) {
  if (!sorted.length || (range ?? 'all') === 'all') return 'whole recording'
  const first = formatElapsed(sorted[0].tSec, true)
  if (range === 'keyframes' && sorted.length > 1) return `${first} – ${formatElapsed(sorted[sorted.length - 1].tSec, true)}`
  return `from ${first}`
}

async function saveProject() {
  const s = useApp.getState()
  const dir = s.settings?.defaultOutputDir ?? (await window.axhibit.pickOutputDir())
  if (!dir) return
  const recordings: Record<string, ProjectEntry> = {}
  for (const r of s.recordings) {
    const p = s.per[r.id]
    const e = p && entryFromState(p)
    if (e) recordings[r.fileName] = e
  }
  try {
    const path = await window.axhibit.saveProject(dir, `${s.recordings[0]?.cameraName ?? 'axhibit'} project`, {
      schema: '', savedAt: '', sources: s.recordings.map((r) => ({ fileName: r.fileName, sizeBytes: r.sizeBytes })), recordings
    })
    s.toast({ kind: 'success', text: 'Project saved', action: { label: 'Show', run: () => void window.axhibit.reveal(path) } })
  } catch (err) {
    s.toast({ kind: 'error', text: 'Save failed', detail: String(err) })
  }
}

async function loadProject() {
  const s = useApp.getState()
  try {
    const p = await window.axhibit.loadProject()
    if (!p) return
    let n = 0
    for (const r of s.recordings) {
      const saved = p.recordings[r.fileName]
      if (!saved) continue
      n++
      s.updatePer(r.id, (x) => ({ ...x, ...stateFromEntry(saved), followZoom: true }))
    }
    s.toast({ kind: n ? 'success' : 'info', text: n ? `Restored edits for ${n} recording${n > 1 ? 's' : ''}` : 'No open recordings match this project. Open the same export first.' })
  } catch (err) {
    s.toast({ kind: 'error', text: 'Could not load project', detail: String(err) })
  }
}

const SV_LABEL: Record<string, { text: string; cls: string; help: string }> = {
  verified: { text: 'Verified', cls: 'text-evid-ok', help: 'Every frame group carries a valid camera signature. The video has not been altered since it left the camera.' },
  partially_verified: { text: 'Partially verified', cls: 'text-evid-warn', help: 'Some parts are signed and valid; other parts carry no signature.' },
  failed: { text: 'Failed — possible tampering', cls: 'text-evid-bad', help: 'Signatures do not match in the ranges below. Frames there were altered, removed or reordered.' },
  not_signed: { text: 'Not signed', cls: 'text-ink-300', help: 'This recording carries no signed-video data. Enable signed video on the camera and in ACS to protect future recordings.' },
  unsupported: { text: 'Cannot verify', cls: 'text-evid-warn', help: '' }
}

function VerifyTab({ rec }: { rec: Recording }) {
  const s = useApp()
  const st: SignedState | undefined = s.signed[rec.id]
  const available = s.appInfo?.signedVideoValidator
  const run = async () => {
    useApp.setState((x) => ({ signed: { ...x.signed, [rec.id]: { status: 'checking', progress: 0 } } }))
    try {
      const jobId = await window.axhibit.verifySigned(rec.id)
      useApp.setState((x) => ({ jobs: { ...x.jobs, [jobId]: { id: jobId, label: `Verifying ${rec.fileName}`, progress: 0, status: 'running', kind: 'verify', recordingId: rec.id } } }))
      const res = await waitJob<SignedState>(jobId)
      useApp.setState((x) => ({ signed: { ...x.signed, [rec.id]: res } }))
    } catch (err) {
      useApp.setState((x) => {
        const n = { ...x.signed }
        delete n[rec.id]
        return { signed: n }
      })
      s.toast({ kind: 'error', text: 'Verification failed to run', detail: String(err) })
    }
  }
  return (
    <>
      <Section title="Signed video (camera signature)">
        <p className="hint">Checks the cryptographic signatures Axis cameras embed in the video stream (signed video). It proves frames weren't changed after leaving the camera.</p>
        {!available && <div className="text-xs text-evid-warn">The validator isn't included in this build.</div>}
        {st?.status === 'checking' ? (
          <Progress value={Object.values(s.jobs).find((j) => j.recordingId === rec.id && j.kind === 'verify' && j.status === 'running')?.progress ?? 0} />
        ) : (
          <button className="btn-primary w-full" disabled={!available} onClick={() => void run()}>{st ? 'Verify again' : 'Verify signatures'}</button>
        )}
        {st && st.status !== 'checking' && (
          <div className="rounded-card bg-ink-900 border border-ink-700 p-3">
            <div className={`flex items-center gap-2 text-[15px] font-semibold ${SV_LABEL[st.status]?.cls}`}>{st.status === 'verified' && <IconShield size={17} />}{SV_LABEL[st.status]?.text ?? st.status}</div>
            <p className="text-xs text-ink-400 mt-1">{SV_LABEL[st.status]?.help}</p>
            {st.detail && <p className="text-xs text-ink-300 mt-1.5">{st.detail}</p>}
            {st.gopsTotal > 0 && <div className="text-xs text-ink-300 mt-2">{st.gopsValid} of {st.gopsTotal} frame groups valid</div>}
            {st.publicKeySha256 && <div className="text-[11px] text-ink-400 mt-1 font-mono break-all">Key SHA-256 {st.publicKeySha256}</div>}
            {st.invalidRanges.length > 0 && (
              <ul className="mt-2 space-y-1">
                {st.invalidRanges.map((r, i) => (
                  <li key={i}>
                    <button className="text-xs text-evid-bad hover:underline" onClick={() => player.seek(r.fromSec)}>{formatElapsed(r.fromSec, true)} – {formatElapsed(r.toSec, true)} · {r.reason}</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="text-[11px] text-ink-400 mt-2">Included in the manifest of every export from this recording.</div>
          </div>
        )}
      </Section>
      <Section title="ACS export signature">
        <p className="hint">The separate digital signature ACS adds to exports is proprietary. Verify it with the AXIS File Player included in the export folder (Tools → Verify digital signature). Axhibit never modifies the original files.</p>
      </Section>
    </>
  )
}

function InfoTab({ rec }: { rec: Recording }) {
  const rows: [string, string][] = [
    ['File', rec.fileName],
    ['Folder', rec.path.replace(/[\\/][^\\/]+$/, '')],
    ['Camera', `${rec.cameraName ?? '—'}  (${rec.cameraNameSource})`],
    ['Camera ID', rec.cameraId ?? '—'],
    ['Start', rec.wallClockStart ? `${new Date(rec.wallClockStart).toLocaleString()}${rec.wallClockApprox ? ' (approx.)' : ''}` : '—'],
    ['Time source', rec.wallClockSource],
    ['Duration', formatElapsed(rec.durationSec, true)],
    ['Container', rec.container],
    ['Video', rec.video ? `${rec.video.codec} ${rec.video.width}×${rec.video.height} @ ${rec.video.fps.toFixed(2)} fps` : '—'],
    ['Audio', rec.audio ? `${rec.audio.codec} ${rec.audio.sampleRate} Hz ${rec.audio.channels} ch` : 'none'],
    ['Size', `${(rec.sizeBytes / 1e6).toFixed(1)} MB`],
    ['Fisheye (camera)', rec.axis?.isFisheye === undefined ? 'unknown' : rec.axis.isFisheye ? 'yes' : 'no'],
    ['Lens profile', rec.axis?.lensProfile ? rec.axis.lensProfile.map((n) => n.toFixed(4)).join(', ') : '—'],
    ['Trigger', rec.axis?.triggerName ?? '—']
  ]
  const s = useApp()
  const hashJob = Object.values(s.jobs).find((j) => j.recordingId === rec.id && j.kind === 'hash')
  return (
    <>
      <dl className="card text-xs space-y-2">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[96px_1fr] gap-2">
            <dt className="text-ink-400">{k}</dt>
            <dd className="text-ink-200 break-words">{v}</dd>
          </div>
        ))}
      </dl>
      <Section title="SHA-256">
        {hashJob?.status === 'done' ? (
          <div className="font-mono text-[10.5px] break-all text-ink-200 select-text">{String(hashJob.result)}</div>
        ) : hashJob?.status === 'running' ? (
          <Progress value={hashJob.progress} />
        ) : (
          <button className="btn-xs" onClick={async () => {
            const id = await window.axhibit.hashSource(rec.id)
            useApp.setState((x) => ({ jobs: { ...x.jobs, [id]: { id, label: `Hashing ${rec.fileName}`, progress: 0, status: 'running', kind: 'hash', recordingId: rec.id } } }))
          }}>Compute hash</button>
        )}
      </Section>
    </>
  )
}

function GridPanel() {
  const s = useApp()
  return (
    <aside aria-label="Synced cameras" className="panel w-[316px] shrink-0 p-2.5 flex flex-col gap-2 text-[13px] overflow-y-auto">
      <Section title="Synced cameras">
        <p className="hint">Cameras are aligned by recorded time. If one is off (e.g. MP4 times come from file names), nudge it here.</p>
        <div className="space-y-3">
          {player.tiles.map((t) => (
            <div key={t.cameraKey}>
              <div className="text-xs text-ink-200 mb-1 flex justify-between">
                <span className="truncate">{t.label}</span>
                <span className="font-mono text-ink-400">{(s.gridOffsets[t.cameraKey] ?? 0).toFixed(1)} s</span>
              </div>
              <input type="range" min={-10} max={10} step={0.1} value={s.gridOffsets[t.cameraKey] ?? 0} className="w-full accent-amber-500"
                onChange={(e) => { useApp.setState({ gridOffsets: { ...s.gridOffsets, [t.cameraKey]: Number(e.target.value) } }); player.rebuildSync() }} />
              <div className="text-[11px] text-ink-400">{t.segments.length} recording{t.segments.length > 1 ? 's' : ''}{t.segments.some((x) => x.wallClockApprox) ? ' · time from file name (≈)' : ''}</div>
            </div>
          ))}
        </div>
      </Section>
    </aside>
  )
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button onClick={() => onChange(!on)} className={`w-10 h-[22px] rounded-full relative transition-colors shrink-0 ${on ? 'bg-amber-500' : 'bg-ink-600'}`} role="switch" aria-checked={on} aria-label={label}>
      <span className={`absolute top-0.5 w-[18px] h-[18px] rounded-full bg-white shadow transition-all ${on ? 'left-5' : 'left-0.5'}`} />
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-ink-400 mb-1">{label}</span>
      {children}
    </label>
  )
}
