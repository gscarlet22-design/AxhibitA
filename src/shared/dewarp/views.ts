import type { Calibration, Mount, PtzState, ViewState } from '../types'

export const DEFAULT_FOV = 180

export function defaultCalibration(width: number, height: number, mount: Mount = 'ceiling'): Calibration {
  return {
    cxPx: width / 2,
    cyPx: height / 2,
    radiusPx: Math.min(width, height) / 2,
    fovDeg: DEFAULT_FOV,
    model: 'equidistant',
    mount
  }
}

export function defaultPtz(mount: Mount): PtzState {
  if (mount === 'wall') return { panDeg: 0, tiltDeg: 0, hfovDeg: 80 }
  if (mount === 'desk') return { panDeg: 0, tiltDeg: -35, hfovDeg: 80 }
  return { panDeg: 0, tiltDeg: 35, hfovDeg: 80 }
}

export function defaultQuad(mount: Mount): PtzState[] {
  if (mount === 'wall') return [-45, -15, 15, 45].map((p) => ({ panDeg: p, tiltDeg: 0, hfovDeg: 40 }))
  const tilt = mount === 'desk' ? -40 : 40
  return [0, 90, 180, 270].map((p) => ({ panDeg: p, tiltDeg: tilt, hfovDeg: 75 }))
}

export function defaultViewState(mount: Mount = 'ceiling'): ViewState {
  return {
    mode: 'normal',
    normal: { zoom: 1, centerX: 0.5, centerY: 0.5 },
    ptz: defaultPtz(mount),
    pano: { offsetDeg: 0, topDeg: 0, bottomDeg: 70 },
    quad: defaultQuad(mount)
  }
}

export function tiltRange(mount: Mount): [number, number] {
  if (mount === 'wall') return [-70, 70]
  if (mount === 'desk') return [-90, 10]
  return [-10, 90]
}

export function clampPtz(p: PtzState, mount: Mount, fovDeg: number): PtzState {
  const [tmin, tmax] = tiltRange(mount)
  let pan = p.panDeg
  if (mount === 'wall') {
    const lim = Math.max(0, Math.min(fovDeg, 200) / 2 - 10)
    pan = Math.max(-lim, Math.min(lim, pan))
  } else {
    pan = ((pan % 360) + 540) % 360 - 180
  }
  return {
    panDeg: pan,
    tiltDeg: Math.max(tmin, Math.min(tmax, p.tiltDeg)),
    hfovDeg: Math.max(15, Math.min(130, p.hfovDeg))
  }
}

/** Views available per mount. */
export function viewAvailable(mode: ViewState['mode'], mount: Mount): boolean {
  if (mode === 'dualpano') return mount !== 'wall'
  return true
}
