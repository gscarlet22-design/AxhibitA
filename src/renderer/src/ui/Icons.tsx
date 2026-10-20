/** Small stroke icon set (24×24 grid, currentColor). Inline SVG: no dependency, no remote assets. */
import type { ReactNode, SVGProps } from 'react'

type P = { size?: number; className?: string; strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, 'children'>

function make(paths: ReactNode, fill = false) {
  return function Icon({ size = 16, className, strokeWidth = 2, ...rest }: P) {
    return (
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={fill ? 'currentColor' : 'none'}
        stroke={fill ? 'none' : 'currentColor'}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`shrink-0 ${className ?? ''}`}
        {...rest}
      >
        {paths}
      </svg>
    )
  }
}

export const IconFolderOpen = make(<path d="M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />)
export const IconPlus = make(<path d="M5 12h14M12 5v14" />)
export const IconSearch = make(<><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>)
export const IconChevronDown = make(<path d="m6 9 6 6 6-6" />)
export const IconChevronRight = make(<path d="m9 18 6-6-6-6" />)
export const IconLock = make(<><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>)
export const IconHelp = make(<><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></>)
export const IconSliders = make(<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />)
export const IconSquare = make(<rect x="3" y="3" width="18" height="18" rx="2" />)
export const IconGrid = make(<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></>)
export const IconPlay = make(<polygon points="7 4 20 12 7 20 7 4" />, true)
export const IconPause = make(<><rect x="5" y="4" width="5" height="16" rx="1" /><rect x="14" y="4" width="5" height="16" rx="1" /></>, true)
export const IconFramePrev = make(<><polygon points="19 20 9 12 19 4 19 20" /><line x1="5" x2="5" y1="19" y2="5" /></>)
export const IconFrameNext = make(<><polygon points="5 4 15 12 5 20 5 4" /><line x1="19" x2="19" y1="5" y2="19" /></>)
export const IconBack10 = make(<><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></>)
export const IconFwd10 = make(<><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></>)
export const IconCamera = make(<><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" /><circle cx="12" cy="13" r="3" /></>)
export const IconExport = make(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" /></>)
export const IconEye = make(<><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>)
export const IconRedact = make(<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></>)
export const IconShield = make(<><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></>)
export const IconInfo = make(<><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></>)
export const IconCrosshair = make(<><circle cx="12" cy="12" r="10" /><path d="M22 12h-4M6 12H2M12 6V2M12 22v-4" /></>)
export const IconScan = make(<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />)
export const IconDiamond = make(<path d="M12 2 22 12 12 22 2 12z" />, true)
export const IconCheck = make(<path d="M20 6 9 17l-5-5" />)
export const IconX = make(<path d="M18 6 6 18M6 6l12 12" />)
export const IconCopy = make(<><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>)
export const IconFrame = make(<><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><rect x="7" y="8" width="10" height="8" rx="1" /></>)

export function RecDot({ className }: { className?: string }) {
  return <span aria-hidden="true" className={`inline-block w-2 h-2 rounded-full bg-evid-bad ${className ?? ''}`} />
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="font-mono text-[10.5px] text-ink-400 px-1.5 py-px border border-ink-600 rounded">{children}</kbd>
}
