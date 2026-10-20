import { DEG } from '@shared/dewarp/project'
import type { Box, Calibration, NormalState, PtzState, RedactStyle, ViewState } from '@shared/types'
import { FRAG, MAX_BOXES, VERT } from './shaders'

export interface Viewport {
  x: number
  y: number
  w: number
  h: number
}

export interface DrawParams {
  srcW: number
  srcH: number
  /** region the current texture covers, in source px (defaults to full frame) */
  srcRect?: Box
  mode: 'normal' | 'ptz' | 'pano' | 'dualpano'
  /** normal mode */
  normCenter?: { x: number; y: number }
  normScale?: number
  calib?: Calibration | null
  ptz?: PtzState
  pano?: ViewState['pano']
  boxes?: { box: Box; style: RedactStyle }[]
}

const STYLE: Record<RedactStyle, number> = { blur: 0, pixelate: 1, solid: 2 }
const MODE = { normal: 0, ptz: 1, pano: 2, dualpano: 3 }
const MOUNT = { ceiling: 0, desk: 1, wall: 2 }

/** Normal-mode mapping (fit to viewport × zoom, centered on a normalized point). Shared with overlays/hit-testing. */
export function normalMapping(srcW: number, srcH: number, vp: { w: number; h: number }, n: NormalState) {
  const fit = Math.min(vp.w / srcW, vp.h / srcH)
  const scale = fit * n.zoom
  return { scale, center: { x: n.centerX * srcW, y: n.centerY * srcH } }
}

export function screenToSource(px: number, py: number, vp: Viewport, m: { scale: number; center: { x: number; y: number } }) {
  return { x: m.center.x + (px - vp.x - vp.w / 2) / m.scale, y: m.center.y + (py - vp.y - vp.h / 2) / m.scale }
}

export function sourceToScreen(sx: number, sy: number, vp: Viewport, m: { scale: number; center: { x: number; y: number } }) {
  return { x: vp.x + vp.w / 2 + (sx - m.center.x) * m.scale, y: vp.y + vp.h / 2 + (sy - m.center.y) * m.scale }
}

export class GLRenderer {
  readonly gl: WebGL2RenderingContext
  private prog: WebGLProgram
  private tex: WebGLTexture
  private u: Record<string, WebGLUniformLocation | null> = {}
  private texW = 0
  private texH = 0
  private mipsDirty = true

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas, opts: { preserveDrawingBuffer?: boolean } = {}) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: !!opts.preserveDrawingBuffer, alpha: false }) as WebGL2RenderingContext | null
    if (!gl) throw new Error('WebGL2 is not available on this computer')
    this.gl = gl
    this.prog = this.link(VERT, FRAG)
    gl.useProgram(this.prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(this.prog, 'aPos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    this.tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    for (const n of ['uTex', 'uSrcSize', 'uSrcRect', 'uOutSize', 'uMode', 'uNormCenter', 'uNormScale', 'uCalib', 'uFov', 'uModel', 'uMount', 'uPtz', 'uPano', 'uBoxCount', 'uBoxes', 'uBoxStyle', 'uTexScale']) {
      this.u[n] = gl.getUniformLocation(this.prog, n)
    }
    gl.uniform1i(this.u.uTex, 0)
  }

  private link(vs: string, fs: string): WebGLProgram {
    const gl = this.gl
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(s))
      return s
    }
    const p = gl.createProgram()!
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs))
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Shader link failed: ' + gl.getProgramInfoLog(p))
    return p
  }

  /** Upload a video frame (or image) as the source texture. */
  uploadVideo(src: TexImageSource, w: number, h: number): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
    this.texW = w
    this.texH = h
    this.mipsDirty = true
  }

  /** Upload raw RGBA pixels (export pipeline). */
  uploadRgba(data: Uint8Array, w: number, h: number): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
    this.texW = w
    this.texH = h
    this.mipsDirty = true
  }

  hasTexture(): boolean {
    return this.texW > 0
  }

  clear(): void {
    const gl = this.gl
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.disable(gl.SCISSOR_TEST)
    gl.clearColor(0.043, 0.051, 0.063, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  /** Draw into a viewport given in top-left-origin canvas pixels. */
  draw(p: DrawParams, vp: Viewport): void {
    const gl = this.gl
    if (!this.texW) return
    const H = gl.drawingBufferHeight
    gl.viewport(vp.x, H - vp.y - vp.h, vp.w, vp.h)
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(vp.x, H - vp.y - vp.h, vp.w, vp.h)
    gl.useProgram(this.prog)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    const boxes = (p.boxes ?? []).slice(0, MAX_BOXES)
    if (boxes.some((b) => b.style !== 'solid') && this.mipsDirty) {
      gl.generateMipmap(gl.TEXTURE_2D)
      this.mipsDirty = false
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    } else if (this.mipsDirty) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    }
    const rect = p.srcRect ?? { x: 0, y: 0, w: p.srcW, h: p.srcH }
    gl.uniform2f(this.u.uSrcSize, p.srcW, p.srcH)
    gl.uniform4f(this.u.uSrcRect, rect.x, rect.y, rect.w, rect.h)
    gl.uniform2f(this.u.uOutSize, vp.w, vp.h)
    gl.uniform1i(this.u.uMode, MODE[p.mode])
    gl.uniform1f(this.u.uTexScale, this.texW / rect.w)
    const c = p.calib
    if (c) {
      gl.uniform3f(this.u.uCalib, c.cxPx, c.cyPx, c.radiusPx)
      gl.uniform1f(this.u.uFov, c.fovDeg * DEG)
      gl.uniform1i(this.u.uModel, c.model === 'equisolid' ? 1 : 0)
      gl.uniform1i(this.u.uMount, MOUNT[c.mount])
    }
    const nc = p.normCenter ?? { x: p.srcW / 2, y: p.srcH / 2 }
    gl.uniform2f(this.u.uNormCenter, nc.x, nc.y)
    gl.uniform1f(this.u.uNormScale, p.normScale ?? Math.min(vp.w / p.srcW, vp.h / p.srcH))
    const ptz = p.ptz ?? { panDeg: 0, tiltDeg: 0, hfovDeg: 90 }
    gl.uniform3f(this.u.uPtz, ptz.panDeg * DEG, ptz.tiltDeg * DEG, ptz.hfovDeg * DEG)
    const pano = p.pano ?? { offsetDeg: 0, topDeg: 0, bottomDeg: 70 }
    gl.uniform3f(this.u.uPano, pano.offsetDeg * DEG, pano.topDeg * DEG, pano.bottomDeg * DEG)
    gl.uniform1i(this.u.uBoxCount, boxes.length)
    if (boxes.length) {
      const arr = new Float32Array(MAX_BOXES * 4)
      const st = new Int32Array(MAX_BOXES)
      boxes.forEach((b, i) => {
        arr.set([b.box.x, b.box.y, b.box.w, b.box.h], i * 4)
        st[i] = STYLE[b.style]
      })
      gl.uniform4fv(this.u.uBoxes, arr)
      gl.uniform1iv(this.u.uBoxStyle, st)
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteTexture(this.tex)
    gl.deleteProgram(this.prog)
  }
}
