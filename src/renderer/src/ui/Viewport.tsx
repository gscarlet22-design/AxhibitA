import { useEffect, useRef, useState } from 'react'
import { ptzToSource, screenRectToSourceBox, sourceBoxOutline } from '@shared/dewarp/boxmap'
import { ptzLookAt, ptzRay } from '@shared/dewarp/project'
import { upsertKeyframe, evalBox, activeRedactions } from '@shared/tracks'
import type { Box, PtzState, Recording, RedactionTrack } from '@shared/types'
import { quadViewports } from '../gl/compose'
import { normalMapping, screenToSource, sourceToScreen, type Viewport as VP } from '../gl/renderer'
import { player } from '../player/player'
import { cameraKey, perFor, useApp } from '../state/store'
import { formatWallClock, wallClockAt } from '@shared/time'
import { normalFromWindow, windowForBox, windowFromNormal, windowRect } from '@shared/zoom'
import { viewAvailable } from '@shared/dewarp/views'
import type { ViewMode } from '@shared/types'
import { autoCalibrate, setMode } from './RightPanel'
import { IconFolderOpen, IconPlus } from './Icons'

type Drag =
  | { kind: 'pan'; x: number; y: number; cx: number; cy: number }
  | { kind: 'ptz'; x: number; y: number; pan: number; tilt: number; quad: number }
  | { kind: 'pano'; x: number; offset: number }
  | { kind: 'draw'; sx: number; sy: number; ex: number; ey: number }
  /** q: the dewarped viewport the drag started in (PTZ = 0, quad 0–3), -1 in the raw view */
  | { kind: 'move'; trackId: string; sx: number; sy: number; box: Box; q: number }
  /** drawing a redaction box on a dewarped view, in screen px */
  | { kind: 'draw-ptz'; q: number; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'resize'; trackId: string; corner: number; box: Box }
  | { kind: 'calib-center'; sx: number; sy: number; cx: number; cy: number }
  | { kind: 'calib-radius' }
  /** steering a redaction box while the video plays; (ox, oy) keeps the grab point under the cursor */
  | { kind: 'follow'; ox: number; oy: number; q: number }

export function Viewport() {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [, force] = useState(0)
  const drag = useRef<Drag | null>(null)
  const s = useApp()
  const rec = s.recordings.find((r) => r.id === s.selectedId)

  useEffect(() => {
    if (!canvasRef.current || !hostRef.current) return
    player.attach(canvasRef.current, hostRef.current)
    player.onTilesChanged = () => force((n) => n + 1)
    return () => player.detach()
  }, [])

  useEffect(() => {
    if (s.layout === 'single') void player.load(rec)
  }, [rec?.id, s.layout])

  if (player.glError) {
    return <div className="flex-1 panel grid place-items-center text-evid-bad p-8 text-center">Graphics acceleration is unavailable: {player.glError}</div>
  }

  const per = rec ? perFor(rec.id) : null
  const showRaw = !!per && (!per.fisheye || s.tool === 'calibrate' || per.view.mode === 'normal')
  const vp = player.cssViewport()
  // the raw view may be driven by a zoom path; overlays and hit-testing must use what's on screen
  const liveNormal = rec && per ? player.rawNormal(rec.id, player.currentMediaTime()) : null
  const mapping = rec?.video && per && liveNormal ? normalMapping(rec.video.width, rec.video.height, vp, liveNormal) : null
  const followingZoom = !!per?.zoomPath?.keyframes.length && !!per.followZoom && !player.isRecordingZoom

  /** Manual pan/zoom while a zoom path plays: take over from the path's current framing and pause following. */
  const takeOverZoom = () => {
    if (!rec || !per || !followingZoom || !liveNormal) return per?.view.normal
    s.updatePer(rec.id, (x) => ({ ...x, followZoom: false, view: { ...x.view, normal: { ...liveNormal } } }))
    return liveNormal
  }

  const local = (e: React.MouseEvent | React.WheelEvent) => {
    const r = hostRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const quadIndex = (x: number, y: number) => quadViewports(vp).findIndex((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h)

  const updateView = (fn: (p: ReturnType<typeof perFor>) => ReturnType<typeof perFor>) => rec && s.updatePer(rec.id, fn)

  /**
   * Dewarped viewports redaction boxes can be edited in: the PTZ view (following its view path), or each
   * quarter of the quad view. Boxes are stored in raw source px; these map the interaction (boxmap.ts).
   */
  const dewarpTargets = (): { vp: VP; ptz: PtzState }[] => {
    if (!rec || !per || showRaw) return []
    if (per.view.mode === 'ptz') return [{ vp, ptz: player.effectiveView(rec.id, player.currentMediaTime()).ptz }]
    if (per.view.mode === 'quad') return quadViewports(vp).map((q, i) => ({ vp: q, ptz: per.view.quad[i] }))
    return []
  }
  const targetAt = (p: { x: number; y: number }) => dewarpTargets().findIndex((t) => p.x >= t.vp.x && p.x <= t.vp.x + t.vp.w && p.y >= t.vp.y && p.y <= t.vp.y + t.vp.h)
  /** Source px under a screen point, in dewarped viewport q (or the raw view when q = -1). */
  const srcIn = (p: { x: number; y: number }, q: number): { x: number; y: number } | null => {
    if (showRaw) return mapping ? screenToSource(p.x, p.y, vp, mapping) : null
    const t = dewarpTargets()[q]
    return t && rec ? ptzToSource(p.x, p.y, t.vp, t.ptz, player.calibFor(rec)) : null
  }
  const addRedaction = (b: Box) => {
    if (!rec) return
    const id = `r${Date.now().toString(36)}`
    const t = player.currentMediaTime()
    s.updatePer(rec.id, (x) => ({ ...x, redactions: [...x.redactions, { id, style: 'pixelate', enabled: true, range: 'from', keyframes: [{ tSec: t, value: b }] }] }))
    useApp.setState({ selectedTrack: id, tool: 'none' })
  }

  const onWheel = (e: React.WheelEvent) => {
    if (s.layout !== 'single' || !rec?.video || !per) return
    const f = e.deltaY > 0 ? 1 / 1.12 : 1.12
    const p = local(e)
    const follow = player.redactFollow
    const scaled = (b: Box) => {
      const w = Math.max(8, Math.min(rec.video!.width, b.w * f))
      const h = Math.max(8, Math.min(rec.video!.height, b.h * f))
      return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h }
    }
    if (follow) {
      // while following, the wheel sizes the box (around its center) instead of zooming the view
      player.setRedactLive(scaled(follow.live))
      force((n) => n + 1)
      return
    }
    if (!showRaw && s.rightTab === 'redact' && s.selectedTrack) {
      // dewarped views have no corner handles: scroll over the selected box to resize it
      const q = targetAt(p)
      const sp = q >= 0 ? srcIn(p, q) : null
      const tr = sp ? hitTrack(sp.x, sp.y) : null
      const b = tr?.id === s.selectedTrack ? evalBox(tr.keyframes, player.currentMediaTime()) : null
      if (tr && b) {
        setBoxAtNow(rec, tr.id, scaled(b))
        return
      }
    }
    if (showRaw) {
      const base = takeOverZoom() ?? per.view.normal
      const m = normalMapping(rec.video.width, rec.video.height, vp, base)
      const before = screenToSource(p.x, p.y, vp, m)
      const zoom = Math.max(1, Math.min(32, base.zoom * f))
      const m2 = normalMapping(rec.video.width, rec.video.height, vp, { ...base, zoom })
      // keep the point under the cursor fixed
      const cx = before.x - (p.x - vp.w / 2) / m2.scale
      const cy = before.y - (p.y - vp.h / 2) / m2.scale
      updateView((x) => ({ ...x, view: { ...x.view, normal: clampNormal(zoom, cx / rec.video!.width, cy / rec.video!.height) } }))
    } else if (per.view.mode === 'ptz') {
      updateView((x) => ({ ...x, view: { ...x.view, ptz: player.clampPtzFor(rec, { ...x.view.ptz, hfovDeg: x.view.ptz.hfovDeg / f }) } }))
    } else if (per.view.mode === 'quad') {
      const qi = quadIndex(p.x, p.y)
      if (qi < 0) return
      updateView((x) => ({ ...x, view: { ...x.view, quad: x.view.quad.map((q, i) => (i === qi ? player.clampPtzFor(rec, { ...q, hfovDeg: q.hfovDeg / f }) : q)) } }))
    }
  }

  const hitTrack = (sx: number, sy: number): RedactionTrack | null => {
    if (!per) return null
    const t = player.currentMediaTime()
    for (const tr of [...per.redactions].reverse()) {
      const b = evalBox(tr.keyframes, t)
      if (b && sx >= b.x && sy >= b.y && sx <= b.x + b.w && sy <= b.y + b.h) return tr
    }
    return null
  }

  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !rec?.video || !per || s.layout !== 'single') return
    const p = local(e)
    const m = mapping!
    const src = screenToSource(p.x, p.y, vp, m)
    if (s.tool === 'calibrate') {
      const c = player.calibFor(rec)
      const center = sourceToScreen(c.cxPx, c.cyPx, vp, m)
      const rim = Math.hypot(p.x - center.x, p.y - center.y) - c.radiusPx * m.scale
      if (Math.abs(rim) < 12) drag.current = { kind: 'calib-radius' }
      else drag.current = { kind: 'calib-center', sx: src.x, sy: src.y, cx: c.cxPx, cy: c.cyPx }
      return
    }
    const follow = player.redactFollow
    if (follow) {
      // grab anywhere: the box keeps its offset from the cursor, so it doesn't jump
      const q = showRaw ? -1 : targetAt(p)
      const sp = srcIn(p, q)
      if (sp) drag.current = { kind: 'follow', ox: follow.live.x + follow.live.w / 2 - sp.x, oy: follow.live.y + follow.live.h / 2 - sp.y, q }
      return
    }
    if (showRaw && (s.tool === 'redact-draw' || s.tool === 'zoom-box')) {
      drag.current = { kind: 'draw', sx: src.x, sy: src.y, ex: src.x, ey: src.y }
      return
    }
    if (showRaw) {
      const tr = hitTrack(src.x, src.y)
      if (tr && s.rightTab === 'redact') {
        useApp.setState({ selectedTrack: tr.id })
        drag.current = { kind: 'move', trackId: tr.id, sx: src.x, sy: src.y, box: evalBox(tr.keyframes, player.currentMediaTime())!, q: -1 }
        return
      }
      const base = takeOverZoom() ?? per.view.normal
      drag.current = { kind: 'pan', x: p.x, y: p.y, cx: base.centerX, cy: base.centerY }
      return
    }
    if (per.view.mode === 'ptz' || per.view.mode === 'quad') {
      const q = targetAt(p)
      if (q >= 0 && s.tool === 'redact-draw') {
        drag.current = { kind: 'draw-ptz', q, x0: p.x, y0: p.y, x1: p.x, y1: p.y }
        return
      }
      const sp = q >= 0 && s.rightTab === 'redact' ? srcIn(p, q) : null
      const tr = sp ? hitTrack(sp.x, sp.y) : null
      if (tr && sp) {
        useApp.setState({ selectedTrack: tr.id })
        drag.current = { kind: 'move', trackId: tr.id, sx: sp.x, sy: sp.y, box: evalBox(tr.keyframes, player.currentMediaTime())!, q }
        return
      }
    }
    if (per.view.mode === 'ptz') drag.current = { kind: 'ptz', x: p.x, y: p.y, pan: per.view.ptz.panDeg, tilt: per.view.ptz.tiltDeg, quad: -1 }
    else if (per.view.mode === 'quad') {
      const qi = quadIndex(p.x, p.y)
      if (qi >= 0) drag.current = { kind: 'ptz', x: p.x, y: p.y, pan: per.view.quad[qi].panDeg, tilt: per.view.quad[qi].tiltDeg, quad: qi }
    } else drag.current = { kind: 'pano', x: p.x, offset: per.view.pano.offsetDeg }
  }

  const onMove = (e: React.MouseEvent) => {
    const d = drag.current
    if (!d || !rec?.video || !per) return
    const p = local(e)
    const m = mapping!
    const src = screenToSource(p.x, p.y, vp, m)
    const W = rec.video.width
    const H = rec.video.height
    switch (d.kind) {
      case 'follow': {
        const b = player.redactFollow?.live
        const sp = srcIn(p, d.q)
        if (!b || !sp) break
        player.setRedactLive({ ...b, x: sp.x + d.ox - b.w / 2, y: sp.y + d.oy - b.h / 2 })
        force((n) => n + 1)
        break
      }
      case 'draw-ptz':
        drag.current = { ...d, x1: p.x, y1: p.y }
        force((n) => n + 1)
        break
      case 'pan': {
        const dx = (p.x - d.x) / m.scale / W
        const dy = (p.y - d.y) / m.scale / H
        updateView((x) => ({ ...x, view: { ...x.view, normal: clampNormal(x.view.normal.zoom, d.cx - dx, d.cy - dy) } }))
        break
      }
      case 'ptz': {
        const hfov = d.quad >= 0 ? per.view.quad[d.quad].hfovDeg : per.view.ptz.hfovDeg
        const w = d.quad >= 0 ? vp.w / 2 : vp.w
        const k = hfov / w
        const next = player.clampPtzFor(rec, { panDeg: d.pan - (p.x - d.x) * k, tiltDeg: d.tilt - (p.y - d.y) * k, hfovDeg: hfov })
        if (d.quad >= 0) updateView((x) => ({ ...x, view: { ...x.view, quad: x.view.quad.map((q, i) => (i === d.quad ? next : q)) } }))
        else updateView((x) => ({ ...x, view: { ...x.view, ptz: next } }))
        break
      }
      case 'pano': {
        const span = per.view.mode === 'dualpano' ? 180 : 360
        updateView((x) => ({ ...x, view: { ...x.view, pano: { ...x.view.pano, offsetDeg: d.offset - ((p.x - d.x) / vp.w) * span } } }))
        break
      }
      case 'draw':
        drag.current = { ...d, ex: src.x, ey: src.y }
        force((n) => n + 1)
        break
      case 'move': {
        const sp = srcIn(p, d.q)
        if (!sp) break
        const b = { ...d.box, x: d.box.x + (sp.x - d.sx), y: d.box.y + (sp.y - d.sy) }
        setBoxAtNow(rec, d.trackId, b)
        break
      }
      case 'resize': {
        const b0 = d.box
        let x1 = b0.x, y1 = b0.y, x2 = b0.x + b0.w, y2 = b0.y + b0.h
        if (d.corner === 0 || d.corner === 3) x1 = src.x
        else x2 = src.x
        if (d.corner === 0 || d.corner === 1) y1 = src.y
        else y2 = src.y
        setBoxAtNow(rec, d.trackId, normBox(x1, y1, x2, y2))
        break
      }
      case 'calib-center': {
        const c = player.calibFor(rec)
        setCalib(rec, { ...c, cxPx: d.cx + (src.x - d.sx), cyPx: d.cy + (src.y - d.sy) })
        break
      }
      case 'calib-radius': {
        const c = player.calibFor(rec)
        setCalib(rec, { ...c, radiusPx: Math.max(20, Math.hypot(src.x - c.cxPx, src.y - c.cyPx)) })
        break
      }
    }
  }

  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (!d || !rec) return
    if (d.kind === 'draw' && s.tool === 'zoom-box') {
      const b = normBox(d.sx, d.sy, d.ex, d.ey)
      if (b.w > 6 && b.h > 6 && rec.video) addZoomKeyframeForBox(rec, b, vp)
      useApp.setState({ tool: 'none' })
      force((n) => n + 1)
    } else if (d.kind === 'draw') {
      const b = normBox(d.sx, d.sy, d.ex, d.ey)
      if (b.w > 6 && b.h > 6) addRedaction(b)
      force((n) => n + 1)
    } else if (d.kind === 'draw-ptz') {
      const r = normBox(d.x0, d.y0, d.x1, d.y1)
      const t = dewarpTargets()[d.q]
      // the stored box is the raw-frame rectangle that covers everything drawn on the dewarped view
      const b = r.w > 6 && r.h > 6 && t ? screenRectToSourceBox(r, t.vp, t.ptz, player.calibFor(rec)) : null
      if (b) addRedaction(b)
      force((n) => n + 1)
    }
    if (d.kind === 'calib-center' || d.kind === 'calib-radius') {
      void window.axhibit.storeSet('calibrations', useApp.getState().calibrations)
    }
  }

  const onDouble = (e: React.MouseEvent) => {
    const p = local(e)
    if (s.layout === 'grid') {
      const tile = player.tiles.find((t) => p.x >= t.vp.x && p.x <= t.vp.x + t.vp.w && p.y >= t.vp.y && p.y <= t.vp.y + t.vp.h)
      if (tile?.activeId) {
        const mediaT = tile.video.currentTime
        useApp.setState({ layout: 'single', selectedId: tile.activeId, playing: false })
        setTimeout(() => player.seek(mediaT), 400)
      }
      return
    }
    if (!rec || !per || showRaw) return
    if (per.view.mode === 'ptz') {
      const u = (p.x / vp.w) * 2 - 1
      const v = (p.y / vp.h) * 2 - 1
      const d = ptzRay(u, v, vp.w / vp.h, per.view.ptz)
      updateView((x) => ({ ...x, view: { ...x.view, ptz: player.clampPtzFor(rec, ptzLookAt(d, x.view.ptz.hfovDeg)) } }))
    }
  }

  // --- overlays ---
  const overlays: React.ReactNode[] = []
  if (s.layout === 'single' && rec?.video && per && mapping) {
    if (s.tool === 'calibrate') {
      const c = player.calibFor(rec)
      const ctr = sourceToScreen(c.cxPx, c.cyPx, vp, mapping)
      overlays.push(
        <g key="calib">
          <circle cx={ctr.x} cy={ctr.y} r={c.radiusPx * mapping.scale} fill="none" stroke="#ffcc33" strokeWidth={2} strokeDasharray="6 4" />
          <circle cx={ctr.x} cy={ctr.y} r={6} fill="#ffcc33" />
          <line x1={ctr.x - 14} y1={ctr.y} x2={ctr.x + 14} y2={ctr.y} stroke="#ffcc33" />
          <line x1={ctr.x} y1={ctr.y - 14} x2={ctr.x} y2={ctr.y + 14} stroke="#ffcc33" />
        </g>
      )
    }
    if (showRaw && (s.rightTab === 'redact' || s.tool === 'redact-draw')) {
      const t = player.currentMediaTime()
      const follow = player.redactFollow
      for (const tr of per.redactions) {
        if (follow?.trackId === tr.id) {
          const b = follow.live
          const a = sourceToScreen(b.x, b.y, vp, mapping)
          overlays.push(
            <g key={tr.id}>
              <rect x={a.x} y={a.y} width={b.w * mapping.scale} height={b.h * mapping.scale} fill="rgba(240,86,106,0.12)" stroke="#f0566a" strokeWidth={2.5} />
              <text x={a.x} y={a.y - 7} fill="#f0566a" fontSize={11} fontWeight={600}>● Following · drag to steer · scroll to resize</text>
            </g>
          )
          continue
        }
        const b = evalBox(tr.keyframes, t)
        if (!b) continue
        const active = activeRedactions([tr], t).length > 0
        const a = sourceToScreen(b.x, b.y, vp, mapping)
        const w = b.w * mapping.scale
        const h = b.h * mapping.scale
        const sel = s.selectedTrack === tr.id
        const hasKf = tr.keyframes.some((k) => Math.abs(k.tSec - t) < 1 / 30)
        overlays.push(
          <g key={tr.id}>
            <rect x={a.x} y={a.y} width={w} height={h} fill="none" stroke={sel ? '#ffcc33' : active ? (per.redactOutside ? '#3ecf8e' : '#f0566a') : '#8b95a5'} strokeWidth={sel ? 2 : 1.5} strokeDasharray={active ? undefined : '4 3'} />
            {hasKf && <polygon points={`${a.x + w / 2 - 5},${a.y - 8} ${a.x + w / 2},${a.y - 3} ${a.x + w / 2 + 5},${a.y - 8} ${a.x + w / 2},${a.y - 13}`} fill="#ffcc33" />}
            {sel &&
              [[a.x, a.y], [a.x + w, a.y], [a.x + w, a.y + h], [a.x, a.y + h]].map(([x, y], i) => (
                <rect
                  key={i}
                  x={x - 5}
                  y={y - 5}
                  width={10}
                  height={10}
                  fill="#ffcc33"
                  className="cursor-nwse-resize"
                  style={{ pointerEvents: 'all' }}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    drag.current = { kind: 'resize', trackId: tr.id, corner: i, box: b }
                  }}
                />
              ))}
          </g>
        )
      }
    }
    if (!showRaw && (s.rightTab === 'redact' || s.tool === 'redact-draw' || player.redactFollow)) {
      // dewarped: draw each box as the curved shape it really covers in this view
      const t = player.currentMediaTime()
      const follow = player.redactFollow
      const calib = player.calibFor(rec)
      const dd = drag.current
      dewarpTargets().forEach((tg, qi) => {
        const items: React.ReactNode[] = []
        for (const tr of per.redactions) {
          const isF = follow?.trackId === tr.id
          const b = isF ? follow!.live : evalBox(tr.keyframes, t)
          if (!b) continue
          const active = isF || activeRedactions([tr], t).length > 0
          const sel = s.selectedTrack === tr.id
          const color = isF ? '#f0566a' : sel ? '#ffcc33' : active ? (per.redactOutside ? '#3ecf8e' : '#f0566a') : '#8b95a5'
          sourceBoxOutline(b, tg.vp, tg.ptz, calib).forEach((line, li) =>
            items.push(<polyline key={`${tr.id}-${li}`} points={line.map((pt) => `${pt.x},${pt.y}`).join(' ')} fill={isF ? 'rgba(240,86,106,0.12)' : 'none'} stroke={color} strokeWidth={isF || sel ? 2.5 : 1.5} strokeDasharray={active ? undefined : '4 3'} />)
          )
        }
        if (dd?.kind === 'draw-ptz' && dd.q === qi) {
          const r = normBox(dd.x0, dd.y0, dd.x1, dd.y1)
          items.push(<rect key="draft" x={r.x} y={r.y} width={r.w} height={r.h} fill="rgba(240,86,106,0.15)" stroke="#f0566a" strokeDasharray="5 3" />)
          // preview of what will be covered: the raw-frame box drawn back into this view
          const b = r.w > 6 && r.h > 6 ? screenRectToSourceBox(r, tg.vp, tg.ptz, calib) : null
          if (b) sourceBoxOutline(b, tg.vp, tg.ptz, calib).forEach((line, li) => items.push(<polyline key={`draft-${li}`} points={line.map((pt) => `${pt.x},${pt.y}`).join(' ')} fill="none" stroke="#f0566a" strokeWidth={1.5} />))
        }
        overlays.push(
          <svg key={`dewarp-${qi}`} x={tg.vp.x} y={tg.vp.y} width={tg.vp.w} height={tg.vp.h} viewBox={`${tg.vp.x} ${tg.vp.y} ${tg.vp.w} ${tg.vp.h}`} overflow="hidden">
            {items}
          </svg>
        )
      })
      if (follow) {
        overlays.push(
          <g key="follow-label">
            <rect x={12} y={vp.h - 40} width={292} height={26} rx={7} fill="rgba(0,0,0,0.72)" />
            <text x={24} y={vp.h - 22} fill="#ff8a99" fontSize={12} fontWeight={600}>● Following · drag to steer · scroll to resize</text>
          </g>
        )
      }
    }
    const d = drag.current
    if (d?.kind === 'draw') {
      const b = normBox(d.sx, d.sy, d.ex, d.ey)
      const a = sourceToScreen(b.x, b.y, vp, mapping)
      const zoomBox = s.tool === 'zoom-box'
      overlays.push(<rect key="draft" x={a.x} y={a.y} width={b.w * mapping.scale} height={b.h * mapping.scale} fill={zoomBox ? 'rgba(90,169,255,0.12)' : 'rgba(240,86,106,0.15)'} stroke={zoomBox ? '#5aa9ff' : '#f0566a'} strokeDasharray="5 3" />)
      if (zoomBox && b.w > 6 && b.h > 6) {
        // preview of the frame this box will become (the path's aspect)
        const aspect = player.zoomAspect(rec.id)
        const r = windowRect(windowForBox(b, aspect, rec.video.width, rec.video.height), aspect)
        const ra = sourceToScreen(r.x, r.y, vp, mapping)
        overlays.push(<rect key="draft-frame" x={ra.x} y={ra.y} width={r.w * mapping.scale} height={r.h * mapping.scale} fill="none" stroke="#5aa9ff" strokeWidth={1.5} />)
      }
    }
    // frame guide: exactly what a zoom keyframe captures and a zoom-path export shows
    if (showRaw && s.tool !== 'calibrate' && per.frameGuide && liveNormal && (per.zoomPath || player.isRecordingZoom)) {
      const aspect = player.zoomAspect(rec.id)
      const g = windowRect(windowFromNormal(liveNormal, rec.video.width, rec.video.height, vp, aspect), aspect)
      const ga = sourceToScreen(g.x, g.y, vp, mapping)
      const t = player.currentMediaTime()
      const onKf = per.zoomPath?.keyframes.some((k) => Math.abs(k.tSec - t) < 1 / 30)
      overlays.push(
        <g key="frame-guide">
          <rect x={ga.x + 1} y={ga.y + 1} width={g.w * mapping.scale - 2} height={g.h * mapping.scale - 2} fill="none" stroke={player.isRecordingZoom ? '#f0566a' : '#5aa9ff'} strokeWidth={1.5} strokeDasharray="8 5" />
          {onKf && <polygon points={`${ga.x + 12},${ga.y + 6} ${ga.x + 18},${ga.y + 12} ${ga.x + 12},${ga.y + 18} ${ga.x + 6},${ga.y + 12}`} fill="#5aa9ff" />}
        </g>
      )
    }
  }

  const cursor = player.redactFollow ? 'cursor-move' : s.tool === 'redact-draw' || s.tool === 'zoom-box' ? 'cursor-crosshair' : s.tool === 'calibrate' ? 'cursor-move' : per && !showRaw ? 'cursor-grab' : ''
  const media = rec ? s.media[rec.id] : undefined

  return (
    <div className="relative flex-1 min-h-0 bg-[#050607] border border-[#1a1d22] rounded-panel overflow-hidden select-none" ref={hostRef}>
      <canvas ref={canvasRef} className={`absolute inset-0 ${cursor}`} onWheel={onWheel} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onDoubleClick={onDouble} />
      <svg className="absolute inset-0 w-full h-full pointer-events-none" onMouseMove={onMove} onMouseUp={onUp}>
        {overlays}
      </svg>
      {s.layout === 'single' && rec && <TimeBadge rec={rec} />}
      {s.layout === 'single' && rec?.video && media?.status !== 'preparing' && media?.status !== 'error' && <ViewOverlay rec={rec} />}
      {s.layout === 'grid' && player.tiles.map((t) => <TileLabel key={t.cameraKey} label={t.label} vp={t.vp} empty={t.empty} pendingId={t.pendingId} />)}
      {s.layout === 'single' && media?.status === 'preparing' && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="glass rounded-xl px-5 py-4 text-[13px] w-80">
            <div className="mb-2 text-ink-300">{media.proxy ? 'Making a playable copy (this codec needs conversion)…' : 'Opening recording…'}</div>
            <Progress value={jobProgressFor(rec!.id)} />
          </div>
        </div>
      )}
      {s.layout === 'single' && media?.status === 'error' && (
        <div className="absolute inset-0 grid place-items-center text-evid-bad text-sm px-8 text-center">Couldn't open this recording. {media.error}</div>
      )}
      {!rec && s.layout === 'single' && <EmptyState />}
    </div>
  )
}

function jobProgressFor(recId: string): number {
  const j = Object.values(useApp.getState().jobs).find((x) => x.recordingId === recId && x.kind === 'prepare' && x.status === 'running')
  return j?.progress ?? 0
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="h-1.5 bg-ink-700 rounded-full overflow-hidden">
      <div className="h-full bg-amber-500 rounded-full transition-[width] duration-150" style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  )
}

function TimeBadge({ rec }: { rec: Recording }) {
  const t = useApp((s) => s.time)
  const d = wallClockAt(rec.wallClockStart, t)
  return (
    <div className="absolute top-3.5 left-3.5 pointer-events-none flex flex-col items-start gap-1">
      <div className="bg-ink-950/70 backdrop-blur-md px-2.5 py-1 rounded-[7px] text-[13px] font-mono text-white tabular-nums">
        {d ? formatWallClock(d, true) : `+${t.toFixed(2)} s`}
        {d && rec.wallClockApprox && <span className="text-amber-400 ml-1.5" title="Time taken from the file name; may be off by a few seconds">≈</span>}
      </div>
      <div className="bg-ink-950/60 px-2 py-0.5 rounded-md text-[11.5px] text-ink-200">{rec.cameraName}</div>
    </div>
  )
}

function TileLabel({ label, vp, empty, pendingId }: { label: string; vp: VP; empty: boolean; pendingId: string | null }) {
  const media = useApp((s) => (pendingId ? s.media[pendingId] : undefined))
  const progress = useApp((s) => (pendingId ? (Object.values(s.jobs).find((j) => j.recordingId === pendingId && j.kind === 'prepare' && j.status === 'running')?.progress ?? 0) : 0))
  return (
    <div className="absolute pointer-events-none" style={{ left: vp.x, top: vp.y, width: vp.w, height: vp.h }}>
      <div className="absolute top-2 left-2 bg-ink-950/70 backdrop-blur-md px-2 py-0.5 rounded-md text-[11.5px] text-ink-100">{label}</div>
      {empty && <div className="absolute inset-0 grid place-items-center text-ink-500 text-sm border border-ink-800">No recording at this time</div>}
      {pendingId && media?.status === 'error' && <div className="absolute inset-0 grid place-items-center text-evid-bad text-xs px-4 text-center border border-ink-800">Couldn't open this recording. {media.error}</div>}
      {pendingId && media?.status !== 'error' && (
        <div className="absolute inset-0 grid place-items-center border border-ink-800">
          <div className="w-1/2 max-w-60 text-xs text-ink-300">
            <div className="mb-1.5">{media?.proxy ? 'Making a playable copy…' : 'Preparing…'} {Math.round(progress * 100)}%</div>
            <Progress value={progress} />
          </div>
        </div>
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="absolute inset-0 grid place-items-center">
      <div className="text-center max-w-md px-6">
        <div className="mx-auto mb-6 w-[72px] h-[72px] rounded-2xl border-2 border-dashed border-ink-600 grid place-items-center text-ink-400">
          <IconFolderOpen size={28} strokeWidth={1.6} />
        </div>
        <h2 className="text-[17px] text-ink-100 font-semibold mb-1.5">Drop an ACS Pro export folder here</h2>
        <p className="text-ink-400 text-[13px] leading-relaxed mb-6">ASF, MKV and MP4 exports. Originals are opened read-only and never changed.</p>
        <div className="flex gap-2 justify-center">
          <button className="btn-primary" onClick={() => openFolder()}><IconFolderOpen size={15} />Open export folder</button>
          <button className="btn" onClick={() => openFiles()}><IconPlus size={15} />Open files</button>
        </div>
      </div>
    </div>
  )
}

const VIEW_MODES: [ViewMode, string, string][] = [
  ['normal', 'Raw', '1'],
  ['ptz', 'PTZ', '2'],
  ['pano', 'Panorama', '3'],
  ['dualpano', 'Double', '4'],
  ['quad', 'Quad', '5']
]

/** Floating controls on the video: fisheye view modes (top right) and digital zoom readout (bottom right). */
function ViewOverlay({ rec }: { rec: Recording }) {
  const s = useApp()
  const per = perFor(rec.id)
  const calib = player.calibFor(rec)
  const mode = per.fisheye ? per.view.mode : 'normal'
  const zoom = !per.fisheye || per.view.mode === 'normal' ? (player.rawNormal(rec.id, player.currentMediaTime())?.zoom ?? per.view.normal.zoom) : 1
  const following = !!per.zoomPath?.keyframes.length && per.followZoom
  return (
    <>
      {per.fisheye ? (
        <div role="group" aria-label="View mode" className="absolute top-3.5 right-3.5 flex gap-0.5 p-[3px] rounded-[10px] glass">
          {VIEW_MODES.map(([m, label, key]) => (
            <button
              key={m}
              disabled={!viewAvailable(m, calib.mount)}
              title={`${label} (${key})`}
              aria-pressed={mode === m}
              onClick={() => setMode(rec, m)}
              className={`h-7 px-2.5 rounded-[7px] text-xs ${mode === m ? 'bg-amber-500 text-ink-950 font-semibold' : 'text-ink-300 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:hover:bg-transparent'}`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : rec.axis?.isFisheye ? (
        <button
          className="absolute top-3.5 right-3.5 h-[34px] px-3 rounded-[10px] glass text-xs text-ink-100 hover:bg-ink-700/80"
          title="Fisheye on (F)"
          onClick={() => {
            s.updatePer(rec.id, (x) => ({ ...x, fisheye: true, view: { ...x.view, mode: x.view.mode === 'normal' ? 'ptz' : x.view.mode } }))
            autoCalibrate(rec, true)
          }}
        >
          Dewarp fisheye
        </button>
      ) : null}
      {zoom > 1.001 && (
        <div className="absolute bottom-3.5 right-3.5 flex items-center gap-2 pl-2.5 pr-1 py-1 rounded-[9px] glass text-[11.5px] text-ink-300">
          <span className="font-mono tabular-nums">{following ? 'Following path · ' : 'Zoom '}{zoom.toFixed(1)}×</span>
          {!following && (
            <button className="h-6 px-2 rounded-md bg-ink-700 hover:bg-ink-600 text-[11px] text-ink-100" title="Reset zoom (R)" onClick={() => s.updatePer(rec.id, (x) => ({ ...x, followZoom: false, view: { ...x.view, normal: { zoom: 1, centerX: 0.5, centerY: 0.5 } } }))}>
              Reset
            </button>
          )}
        </div>
      )}
    </>
  )
}

export async function openFolder() {
  const p = await window.axhibit.pickFolder()
  if (p) await openPathsInto([p])
}

export async function openFiles() {
  const p = await window.axhibit.pickFiles()
  if (p.length) await openPathsInto(p)
}

export async function openPathsInto(paths: string[]) {
  const st = useApp.getState()
  st.set({ loading: true })
  try {
    const recs = await window.axhibit.openPaths(paths)
    const byId = new Map(st.recordings.map((r) => [r.id, r]))
    for (const r of recs) byId.set(r.id, r)
    const all = [...byId.values()]
    const firstOk = recs.find((r) => !r.error)
    useApp.setState({ recordings: all, selectedId: st.selectedId ?? firstOk?.id ?? null, layout: 'single' })
    if (!recs.length) st.toast({ kind: 'info', text: 'No ASF, MKV or MP4 recordings found there.' })
    else st.toast({ kind: 'success', text: `Opened ${recs.length} recording${recs.length > 1 ? 's' : ''}` })
  } catch (err) {
    st.toast({ kind: 'error', text: 'Could not open', detail: err instanceof Error ? err.message : String(err) })
  } finally {
    useApp.setState({ loading: false })
  }
}

function clampNormal(zoom: number, cx: number, cy: number) {
  const half = 0.5 / zoom
  return {
    zoom,
    centerX: zoom <= 1 ? 0.5 : Math.max(half, Math.min(1 - half, cx)),
    centerY: zoom <= 1 ? 0.5 : Math.max(half, Math.min(1 - half, cy))
  }
}

function normBox(x1: number, y1: number, x2: number, y2: number): Box {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
}

function setBoxAtNow(rec: Recording, trackId: string, b: Box) {
  const t = player.currentMediaTime()
  useApp.getState().updatePer(rec.id, (x) => ({
    ...x,
    redactions: x.redactions.map((tr) => (tr.id === trackId ? { ...tr, keyframes: upsertKeyframe(tr.keyframes, t, b) } : tr))
  }))
}

/** Keyframe the zoom path at the current time so the frame shows box b (at the path's aspect), and show it. */
function addZoomKeyframeForBox(rec: Recording, b: Box, vp: VP) {
  const W = rec.video!.width
  const H = rec.video!.height
  const t = player.currentMediaTime()
  useApp.getState().updatePer(rec.id, (x) => {
    const aspect = x.zoomPath?.aspect ?? 16 / 9
    const w = windowForBox(b, aspect, W, H)
    return {
      ...x,
      zoomPath: { aspect, keyframes: upsertKeyframe(x.zoomPath?.keyframes ?? [], t, w) },
      followZoom: true,
      view: { ...x.view, normal: normalFromWindow(w, W, H, vp, aspect) }
    }
  })
}

function setCalib(rec: Recording, c: ReturnType<typeof player.calibFor>) {
  const key = cameraKey(rec)
  useApp.setState((s) => ({ calibrations: { ...s.calibrations, [key]: c } }))
}
