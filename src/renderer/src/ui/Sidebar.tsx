import { useEffect, useMemo, useState } from 'react'
import { formatElapsed, formatWallClock } from '@shared/time'
import type { Recording } from '@shared/types'
import { player } from '../player/player'
import { cameraKey, useApp } from '../state/store'
import { IconChevronDown, IconChevronRight, IconFolderOpen, IconGrid, IconPlus, IconSearch } from './Icons'
import { openFiles, openFolder } from './Viewport'

const codecLabel = (c?: string) => (c === 'hevc' ? 'H.265' : c === 'h264' ? 'H.264' : c?.toUpperCase())

export function Sidebar() {
  const s = useApp()
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const groups = useMemo(() => {
    const m = new Map<string, Recording[]>()
    for (const r of s.recordings) {
      const k = cameraKey(r)
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(r)
    }
    for (const list of m.values()) list.sort((a, b) => (a.wallClockStart ?? a.fileName).localeCompare(b.wallClockStart ?? b.fileName))
    return [...m.entries()]
  }, [s.recordings])

  const q = query.trim().toLowerCase()
  const shown = useMemo(() => {
    if (!q) return groups
    return groups
      .map(([k, recs]): [string, Recording[]] => {
        const camHit = (recs[0].cameraName ?? k).toLowerCase().includes(q)
        return [k, camHit ? recs : recs.filter((r) => clipTitle(r).toLowerCase().includes(q) || r.fileName.toLowerCase().includes(q))]
      })
      .filter(([, recs]) => recs.length > 0)
  }, [groups, q])

  const toggleGrid = (k: string) => {
    const has = s.gridCameras.includes(k)
    const next = has ? s.gridCameras.filter((x) => x !== k) : [...s.gridCameras, k].slice(-4)
    useApp.setState({ gridCameras: next })
    if (s.layout === 'grid') startGrid(next)
  }
  const toggleCollapsed = (k: string) =>
    setCollapsed((c) => {
      const n = new Set(c)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })

  return (
    <aside aria-label="Recordings" className="panel w-[272px] shrink-0 flex flex-col min-h-0 overflow-hidden">
      <div className="p-3 flex flex-col gap-2.5 border-b border-ink-750">
        <div className="flex gap-1.5">
          <button className="btn flex-1 h-[34px]" onClick={() => void openFolder()}>
            <IconFolderOpen size={15} />Open export
          </button>
          <button className="btn w-[34px] h-[34px] px-0" aria-label="Add files" title="Add files…" onClick={() => void openFiles()}>
            <IconPlus size={15} />
          </button>
        </div>
        {s.recordings.length > 0 && (
          <label className="flex items-center gap-2 h-8 px-2.5 rounded-lg bg-ink-900 border border-ink-750 text-ink-500 focus-within:border-ink-600">
            <IconSearch size={14} />
            <span className="sr-only">Filter recordings</span>
            <input className="flex-1 min-w-0 bg-transparent outline-none text-[12.5px] text-ink-100 placeholder:text-ink-500" placeholder="Filter cameras or times" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2 pt-1 pb-3">
        {s.loading && <div className="px-2 py-3 text-xs text-ink-400">Reading recordings…</div>}
        {!s.loading && s.recordings.length === 0 && <div className="px-2 py-4 text-xs text-ink-500 leading-relaxed">Open an ACS Pro export folder, or drop it anywhere in the window.</div>}
        {q && shown.length === 0 && <div className="px-2 py-3 text-xs text-ink-500">Nothing matches “{query}”.</div>}
        {shown.map(([k, recs]) => {
          const isCollapsed = collapsed.has(k) && !q
          const total = groups.find(([gk]) => gk === k)?.[1].length ?? recs.length
          return (
            <div key={k}>
              <div className="flex items-center gap-1.5 pl-1 pr-1.5 pt-3 pb-1.5">
                <button className="flex items-center gap-1.5 min-w-0 flex-1 text-left" aria-expanded={!isCollapsed} onClick={() => toggleCollapsed(k)}>
                  {isCollapsed ? <IconChevronRight size={14} className="text-ink-500" /> : <IconChevronDown size={14} className="text-ink-500" />}
                  <span className="text-xs font-semibold text-ink-200 truncate">{recs[0].cameraName ?? k}</span>
                </button>
                {recs[0].axis?.isFisheye && <span className="tag">Fisheye</span>}
                {isCollapsed && <span className="text-[11px] text-ink-500 whitespace-nowrap">{total} clip{total > 1 ? 's' : ''}</span>}
                <label className="flex items-center gap-1 text-[11px] text-ink-400 cursor-pointer ml-1" title="Include in synced multi-camera view">
                  <input type="checkbox" className="accent-amber-500 m-0" checked={s.gridCameras.includes(k)} onChange={() => toggleGrid(k)} />
                  Sync
                </label>
              </div>
              {!isCollapsed && (
                <div className="flex flex-col gap-0.5">
                  {recs.map((r) => {
                    const on = s.selectedId === r.id && s.layout === 'single'
                    return (
                      <button
                        key={r.id}
                        onClick={() => useApp.setState({ selectedId: r.id, layout: 'single', tool: 'none', selectedTrack: null })}
                        className={`w-full flex items-center gap-2.5 p-2 rounded-[9px] text-left ${on ? 'bg-ink-700' : 'hover:bg-ink-800'}`}
                        aria-current={on ? 'true' : undefined}
                      >
                        <div aria-hidden="true" className={`relative w-14 h-9 shrink-0 rounded-md overflow-hidden bg-[#0a0b0d] border grid place-items-center ${on ? 'border-amber-400' : 'border-ink-700'}`}>
                          <Thumb rec={r} on={on} />
                          {!r.error && <span className="absolute bottom-0.5 right-0.5 px-[3px] rounded-[3px] bg-black/65 font-mono text-[9px] leading-[12px] text-ink-100">{formatElapsed(r.durationSec)}</span>}
                        </div>
                        <div className="min-w-0 flex flex-col gap-0.5">
                          <span className={`font-mono text-[12.5px] tabular-nums truncate ${on ? 'text-amber-400' : 'text-ink-100'}`}>
                            {clipTitle(r)}
                            {r.wallClockApprox && <span className="text-amber-400" title="Time taken from the file name"> ≈</span>}
                          </span>
                          {r.error ? (
                            <span className="text-[11px] text-evid-bad truncate" title={r.error}>Can't read: {r.error}</span>
                          ) : (
                            <span className={`text-[11px] truncate ${on ? 'text-ink-300' : 'text-ink-400'}`}>
                              {[r.video ? `${r.video.width}×${r.video.height}` : '', codecLabel(r.video?.codec), r.fileName.split('.').pop()?.toUpperCase()].filter(Boolean).join(' · ')}
                            </span>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {s.gridCameras.length >= 2 && (
        <div className="p-3 border-t border-ink-750">
          <button className={s.layout === 'grid' ? 'btn w-full' : 'btn-primary w-full'} onClick={() => (s.layout === 'grid' ? useApp.setState({ layout: 'single' }) : startGrid(s.gridCameras))}>
            <IconGrid size={15} />
            {s.layout === 'grid' ? 'Back to single view' : `Play ${s.gridCameras.length} cameras in sync`}
          </button>
        </div>
      )}
    </aside>
  )
}

/** Library thumbnail: requested once per recording when its tile first shows; placeholder until it arrives. */
const requested = new Set<string>()
function Thumb({ rec, on }: { rec: Recording; on: boolean }) {
  const src = useApp((s) => s.thumbs[rec.id])
  useEffect(() => {
    if (rec.error || !rec.video || requested.has(rec.id)) return
    requested.add(rec.id)
    void window.axhibit.thumbnail(rec.id).then((url) => useApp.setState((s) => ({ thumbs: { ...s.thumbs, [rec.id]: url } })))
  }, [rec.id])
  if (src) return <img src={src} alt="" draggable={false} className={`absolute inset-0 w-full h-full object-cover ${on ? '' : 'opacity-90'}`} />
  return rec.axis?.isFisheye ? <div className={`w-7 h-7 rounded-full ${on ? 'bg-[#20242b]' : 'bg-[#1a1d22]'}`} /> : null
}

function clipTitle(r: Recording) {
  return r.wallClockStart ? formatWallClock(new Date(r.wallClockStart)).slice(11) : r.fileName
}

export function startGrid(keys: string[]) {
  const s = useApp.getState()
  if (keys.length < 2) {
    useApp.setState({ layout: 'single' })
    return
  }
  player.pause()
  useApp.setState({ layout: 'grid', tool: 'none' })
  player.setGrid(keys, s.recordings)
}
