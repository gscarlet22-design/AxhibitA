/**
 * GPU side of the YUV export pipeline (see docs/EXPORT_AND_MANIFEST.md → Pipelines):
 *  - YuvUpload: planar 4:2:0 frames from FFmpeg → RGB texture the dewarp/redaction shader samples
 *  - OverlayBlit: the burned-in text box (drawn on a small 2D canvas) blended onto the frame
 *  - YuvPacker: the finished frame → BT.709 limited-range yuv420p bytes, packed 4 samples per RGBA texel so a
 *    plain RGBA readPixels returns exactly the planar layout FFmpeg expects
 * Color math mirrors src/shared/color.ts (tested there).
 */
import { yuvDecodeCoefficients, type YuvMatrix } from '@shared/color'

const QUAD_VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

const YUV_TO_RGB = `#version 300 es
precision highp float;
out vec4 outColor;
uniform highp sampler2D uY;
uniform highp sampler2D uU;
uniform highp sampler2D uV;
uniform vec2 uSize;     // luma size
uniform vec3 uOffset;   // subtracted from (Y, Cb, Cr) samples
uniform vec3 uScale;    // then multiplied
uniform vec4 uCoef;     // rCr, gCb, gCr, bCb
void main() {
  // fragment row j holds source row j (FFmpeg rows are top-first; the main shader samples row 0 at v = 0)
  ivec2 p = ivec2(gl_FragCoord.xy);
  float y = (texelFetch(uY, p, 0).r - uOffset.x) * uScale.x;
  vec2 uv = gl_FragCoord.xy / uSize; // chroma: bilinear between 2×2 sites
  float cb = (texture(uU, uv).r - uOffset.y) * uScale.y;
  float cr = (texture(uV, uv).r - uOffset.z) * uScale.z;
  outColor = vec4(clamp(vec3(y + uCoef.x * cr, y + uCoef.y * cb + uCoef.z * cr, y + uCoef.w * cb), 0.0, 1.0), 1.0);
}`

const BLIT_VERT = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;   // x, y, w, h in clip space (y up)
out vec2 vUv;
void main() {
  vec2 t = aPos * 0.5 + 0.5;
  vUv = vec2(t.x, 1.0 - t.y); // canvas rows are uploaded top-first
  gl_Position = vec4(uRect.xy + t * uRect.zw, 0.0, 1.0);
}`

const BLIT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
void main() { outColor = texture(uTex, vUv); }`

const PACK_YUV = `#version 300 es
precision highp float;
precision highp int;
out vec4 outColor;
uniform highp sampler2D uImg; // the finished frame, copied from the canvas (row 0 = bottom)
uniform ivec2 uSize;          // W, H of the frame (W % 8 == 0, H % 4 == 0)
const vec3 KY = vec3(0.2126, 0.7152, 0.0722);
vec3 px(int x, int r) { return texelFetch(uImg, ivec2(x, uSize.y - 1 - r), 0).rgb; } // r: row from the top
float lumaCode(vec3 c) { return (16.0 + 219.0 * dot(c, KY)) / 255.0; }
vec2 chromaCode(vec3 c) {
  float y = dot(c, KY);
  return (128.0 + 224.0 * vec2((c.b - y) / 1.8556, (c.r - y) / 1.5748)) / 255.0;
}
void main() {
  int i = int(gl_FragCoord.x);
  int j = int(gl_FragCoord.y); // = output buffer row (readPixels returns row 0 first)
  int W = uSize.x;
  int H = uSize.y;
  if (j < H) {
    int x = i * 4;
    outColor = vec4(lumaCode(px(x, j)), lumaCode(px(x + 1, j)), lumaCode(px(x + 2, j)), lumaCode(px(x + 3, j)));
    return;
  }
  // chroma planes: each buffer row holds two chroma rows (W/2 bytes each); U rows first, then V
  int k = j - H;
  int quarter = H / 4;
  bool isV = k >= quarter;
  if (isV) k -= quarter;
  int perRow = W / 8; // texels per chroma row
  int crow = 2 * k + (i >= perRow ? 1 : 0);
  int cx0 = (i - (i >= perRow ? perRow : 0)) * 4;
  vec4 o;
  for (int n = 0; n < 4; n++) {
    int cx = cx0 + n;
    vec3 c = (px(2 * cx, 2 * crow) + px(2 * cx + 1, 2 * crow) + px(2 * cx, 2 * crow + 1) + px(2 * cx + 1, 2 * crow + 1)) * 0.25;
    vec2 cc = chromaCode(c);
    o[n] = isV ? cc.y : cc.x;
  }
  outColor = o;
}`

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
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
  gl.bindAttribLocation(p, 0, 'aPos')
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Shader link failed: ' + gl.getProgramInfoLog(p))
  return p
}

function texture(gl: WebGL2RenderingContext, filter: number): WebGLTexture {
  const t = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  return t
}

/** Draw a full-viewport quad with the bound program (the shared buffer is bound to attribute 0). */
function drawQuad(gl: WebGL2RenderingContext) {
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}

/** Planar YUV 4:2:0 bytes → an RGBA texture, converted on the GPU. */
export class YuvUpload {
  private prog: WebGLProgram
  private planes: WebGLTexture[]
  private fbo: WebGLFramebuffer
  private u: Record<string, WebGLUniformLocation | null> = {}
  private checked = false

  constructor(private gl: WebGL2RenderingContext) {
    this.prog = link(gl, QUAD_VERT, YUV_TO_RGB)
    this.planes = [texture(gl, gl.NEAREST), texture(gl, gl.LINEAR), texture(gl, gl.LINEAR)]
    this.fbo = gl.createFramebuffer()!
    for (const n of ['uY', 'uU', 'uV', 'uSize', 'uOffset', 'uScale', 'uCoef']) this.u[n] = gl.getUniformLocation(this.prog, n)
  }

  /** Convert into `dst` (an RGBA8 texture already allocated at w×h). */
  convert(data: Uint8Array, w: number, h: number, dst: WebGLTexture, fullRange: boolean, matrix: YuvMatrix) {
    const gl = this.gl
    const cw = w / 2
    const ch = h / 2
    const ySize = w * h
    const cSize = cw * ch
    const planes: [number, number, number][] = [[0, w, h], [ySize, cw, ch], [ySize + cSize, cw, ch]]
    planes.forEach(([off, pw, ph], i) => {
      gl.activeTexture(gl.TEXTURE1 + i)
      gl.bindTexture(gl.TEXTURE_2D, this.planes[i])
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, pw, ph, 0, gl.RED, gl.UNSIGNED_BYTE, data.subarray(off, off + pw * ph))
    })
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0)
    gl.viewport(0, 0, w, h)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.BLEND)
    gl.useProgram(this.prog)
    gl.uniform1i(this.u.uY, 1)
    gl.uniform1i(this.u.uU, 2)
    gl.uniform1i(this.u.uV, 3)
    gl.uniform2f(this.u.uSize, w, h)
    const c = yuvDecodeCoefficients(matrix, fullRange)
    gl.uniform3f(this.u.uOffset, ...c.offset)
    gl.uniform3f(this.u.uScale, ...c.scale)
    gl.uniform4f(this.u.uCoef, c.rCr, c.gCb, c.gCr, c.bCb)
    if (!this.checked) {
      const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`GPU frame upload failed (framebuffer status 0x${st.toString(16)})`)
      this.checked = true
    }
    drawQuad(gl)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.activeTexture(gl.TEXTURE0)
    const err = gl.getError()
    if (err !== gl.NO_ERROR) throw new Error(`GPU frame upload failed (WebGL error 0x${err.toString(16)})`)
  }
}

/** Blend a small canvas (the overlay text box) onto the current framebuffer at a pixel rect (top-left origin). */
export class OverlayBlit {
  private prog: WebGLProgram
  private tex: WebGLTexture
  private uRect: WebGLUniformLocation | null
  private uTex: WebGLUniformLocation | null

  constructor(private gl: WebGL2RenderingContext) {
    this.prog = link(gl, BLIT_VERT, BLIT_FRAG)
    this.tex = texture(gl, gl.NEAREST)
    this.uRect = gl.getUniformLocation(this.prog, 'uRect')
    this.uTex = gl.getUniformLocation(this.prog, 'uTex')
  }

  draw(src: HTMLCanvasElement | OffscreenCanvas, x: number, y: number, fbW: number, fbH: number) {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
    gl.useProgram(this.prog)
    gl.uniform1i(this.uTex, 0)
    // pixel rect → clip space (y up)
    const cx = (x / fbW) * 2 - 1
    const cy = 1 - ((y + src.height) / fbH) * 2
    gl.uniform4f(this.uRect, cx, cy, (src.width / fbW) * 2, (src.height / fbH) * 2)
    gl.viewport(0, 0, fbW, fbH)
    gl.disable(gl.SCISSOR_TEST)
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    drawQuad(gl)
    gl.disable(gl.BLEND)
  }
}

/** Read the default framebuffer back as planar yuv420p (BT.709, limited range), 1.5 bytes per pixel. */
export class YuvPacker {
  private prog: WebGLProgram
  private frame: WebGLTexture
  private packed: WebGLTexture
  private fbo: WebGLFramebuffer
  private uImg: WebGLUniformLocation | null
  private uSize: WebGLUniformLocation | null
  private pbos: WebGLBuffer[] = []

  constructor(private gl: WebGL2RenderingContext, private w: number, private h: number) {
    if (w % 8 !== 0 || h % 4 !== 0) throw new Error('YUV packing needs width % 8 == 0 and height % 4 == 0')
    this.prog = link(gl, QUAD_VERT, PACK_YUV)
    // RGB8, not RGBA8: the canvas has no alpha channel, and WebGL refuses to copy it into a format with one
    this.frame = texture(gl, gl.NEAREST)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, w, h, 0, gl.RGB, gl.UNSIGNED_BYTE, null)
    this.packed = texture(gl, gl.NEAREST)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w / 4, (h * 3) / 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    this.fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.packed, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.uImg = gl.getUniformLocation(this.prog, 'uImg')
    this.uSize = gl.getUniformLocation(this.prog, 'uSize')
  }

  /**
   * Pack the current canvas contents into yuv420p and start reading it back without stalling: the pixels go to
   * a GPU-side buffer, and the returned promise resolves once the GPU is done, so the caller can render the next
   * frame meanwhile. Resolves with a new buffer of w·h·1.5 bytes.
   */
  readAsync(): Promise<Uint8Array> {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.frame)
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, this.w, this.h)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.viewport(0, 0, this.w / 4, (this.h * 3) / 2)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.BLEND)
    gl.useProgram(this.prog)
    gl.uniform1i(this.uImg, 0)
    gl.uniform2i(this.uSize, this.w, this.h)
    drawQuad(gl)
    const bytes = (this.w * this.h * 3) / 2
    const pbo = this.pbos.pop() ?? gl.createBuffer()!
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo)
    gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ)
    gl.readPixels(0, 0, this.w / 4, (this.h * 3) / 2, gl.RGBA, gl.UNSIGNED_BYTE, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!
    gl.flush()
    // a failed GL call would leave blank frames: fail the export loudly instead of writing a bad file
    const err = gl.getError()
    if (err !== gl.NO_ERROR) return Promise.reject(new Error(`GPU frame readback failed (WebGL error 0x${err.toString(16)})`))
    return new Promise((resolve, reject) => {
      const poll = () => {
        const st = gl.clientWaitSync(fence, 0, 0)
        if (st === gl.TIMEOUT_EXPIRED) return void setTimeout(poll, 1)
        gl.deleteSync(fence)
        if (st === gl.WAIT_FAILED) return reject(new Error('GPU frame readback failed (wait failed)'))
        const out = new Uint8Array(bytes)
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo)
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out)
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
        this.pbos.push(pbo)
        const e2 = gl.getError()
        if (e2 !== gl.NO_ERROR) return reject(new Error(`GPU frame readback failed (WebGL error 0x${e2.toString(16)})`))
        resolve(out)
      }
      poll()
    })
  }
}
