/**
 * Hidden export renderer. Receives decoded frames from main over a MessagePort (planar YUV 4:2:0, or RGBA as a
 * fallback), renders them with the same GL pipeline as the on-screen preview, burns overlays, and returns
 * frames at output size (packed BT.709 yuv420p, or RGBA as a fallback).
 */
import type { RenderSpec } from '@shared/ipc'
import { activeRedactions } from '@shared/tracks'
import { drawExportView, drawOverlay, overlayBounds, overlayLines } from './gl/compose'
import { GLRenderer } from './gl/renderer'
import { OverlayBlit, YuvPacker } from './gl/yuv'

let spec: RenderSpec | null = null
let gl: GLRenderer | null = null
let glCanvas: HTMLCanvasElement | null = null
let ctx2d: CanvasRenderingContext2D | null = null
let packer: YuvPacker | null = null
let blit: OverlayBlit | null = null
let overlayCanvas: HTMLCanvasElement | null = null

function init(s: RenderSpec) {
  spec = s
  glCanvas = document.createElement('canvas')
  glCanvas.width = s.outW
  glCanvas.height = s.outH
  gl = new GLRenderer(glCanvas, { preserveDrawingBuffer: true })
  if (s.frames.out === 'yuv420p') {
    packer = new YuvPacker(gl.gl, s.outW, s.outH)
    blit = new OverlayBlit(gl.gl)
    overlayCanvas = document.createElement('canvas')
  } else {
    const c2 = document.createElement('canvas')
    c2.width = s.outW
    c2.height = s.outH
    ctx2d = c2.getContext('2d', { willReadFrequently: true })!
  }
}

/** Render one frame. The YUV path returns as soon as the GPU readback is queued; the promise resolves when it lands. */
function renderFrame(t: number, data: Uint8Array): Promise<Uint8Array> | Uint8Array {
  if (!spec || !gl || !glCanvas) throw new Error('Renderer not initialised')
  if (spec.frames.in === 'rgba') gl.uploadRgba(data, spec.decW, spec.decH)
  else gl.uploadYuv420(data, spec.decW, spec.decH, spec.frames.fullRange, spec.frames.matrix)
  gl.clear()
  const vp = { x: 0, y: 0, w: spec.outW, h: spec.outH }
  const boxes = activeRedactions(spec.redactions, t)
  drawExportView(gl, spec.view, { srcW: spec.srcW, srcH: spec.srcH, srcRect: spec.srcRect, boxes, redactOutside: spec.redactOutside ?? null }, t, vp)
  const lines = overlayLines(spec.overlay, spec.cameraName, spec.wallClockStart, spec.wallClockApprox, t)

  if (packer && blit && overlayCanvas) {
    // everything stays on the GPU: overlay box blended in, then packed to yuv420p and read back once
    if (lines.length) {
      const ctx = overlayCanvas.getContext('2d')!
      const b = overlayBounds(ctx, lines, spec.outW, spec.outH)
      overlayCanvas.width = b.w
      overlayCanvas.height = b.h
      ctx.setTransform(1, 0, 0, 1, -b.x, -b.y)
      drawOverlay(ctx, lines, spec.outW, spec.outH)
      blit.draw(overlayCanvas, b.x, b.y, spec.outW, spec.outH)
    }
    return packer.readAsync()
  }

  if (!ctx2d) throw new Error('Renderer not initialised')
  gl.gl.finish()
  ctx2d.globalCompositeOperation = 'copy'
  ctx2d.drawImage(glCanvas, 0, 0)
  ctx2d.globalCompositeOperation = 'source-over'
  drawOverlay(ctx2d, lines, spec.outW, spec.outH)
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
        // the next frame can start rendering while this one's readback finishes; replies carry the frame index
        void Promise.resolve(renderFrame(msg.t ?? 0, msg.data)).then(
          // copied, not transferred: Electron's MessagePortMain can't receive transferred ArrayBuffers (data arrives as null)
          (out) => port.postMessage({ type: 'frame', index: msg.index, data: out }),
          (err) => port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        )
      }
    } catch (err) {
      port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }
  port.start()
})
