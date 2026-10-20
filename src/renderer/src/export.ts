/**
 * Hidden export renderer. Receives decoded RGBA frames from main over a MessagePort, renders them with the
 * same GL pipeline as the on-screen preview, burns overlays, and returns RGBA at output size.
 */
import type { RenderSpec } from '@shared/ipc'
import { activeRedactions } from '@shared/tracks'
import { drawExportView, drawOverlay, overlayLines } from './gl/compose'
import { GLRenderer } from './gl/renderer'

let spec: RenderSpec | null = null
let gl: GLRenderer | null = null
let glCanvas: HTMLCanvasElement | null = null
let ctx2d: CanvasRenderingContext2D | null = null

function init(s: RenderSpec) {
  spec = s
  glCanvas = document.createElement('canvas')
  glCanvas.width = s.outW
  glCanvas.height = s.outH
  gl = new GLRenderer(glCanvas, { preserveDrawingBuffer: true })
  const c2 = document.createElement('canvas')
  c2.width = s.outW
  c2.height = s.outH
  ctx2d = c2.getContext('2d', { willReadFrequently: true })!
}

function renderFrame(t: number, data: Uint8Array): Uint8Array {
  if (!spec || !gl || !glCanvas || !ctx2d) throw new Error('Renderer not initialised')
  gl.uploadRgba(data, spec.decW, spec.decH)
  gl.clear()
  const vp = { x: 0, y: 0, w: spec.outW, h: spec.outH }
  const boxes = activeRedactions(spec.redactions, t)
  drawExportView(gl, spec.view, { srcW: spec.srcW, srcH: spec.srcH, srcRect: spec.srcRect, boxes }, t, vp)
  gl.gl.finish()
  ctx2d.globalCompositeOperation = 'copy'
  ctx2d.drawImage(glCanvas, 0, 0)
  ctx2d.globalCompositeOperation = 'source-over'
  drawOverlay(ctx2d, overlayLines(spec.overlay, spec.cameraName, spec.wallClockStart, spec.wallClockApprox, t), spec.outW, spec.outH)
  const img = ctx2d.getImageData(0, 0, spec.outW, spec.outH)
  return new Uint8Array(img.data.buffer)
}

window.addEventListener('message', (ev) => {
  if (ev.data !== 'axhibit-render-port' || !ev.ports[0]) return
  const port = ev.ports[0]
  port.onmessage = (m) => {
    const msg = m.data as { type: string; spec?: RenderSpec; index?: number; t?: number; data?: Uint8Array }
    try {
      if (msg.type === 'init' && msg.spec) {
        init(msg.spec)
        port.postMessage({ type: 'ready' })
      } else if (msg.type === 'frame' && msg.data) {
        const out = renderFrame(msg.t ?? 0, msg.data)
        port.postMessage({ type: 'frame', index: msg.index, data: out })
      }
    } catch (err) {
      port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }
  port.start()
})
