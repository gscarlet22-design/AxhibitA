/**
 * YUV ↔ RGB math for the export pipeline. The GLSL in renderer/src/gl/yuv.ts uses these coefficients
 * (passed as uniforms for decoding; the BT.709 encode constants are mirrored in the shader). Tests check both.
 */

export type YuvMatrix = 'bt709' | 'bt601'

/** Kr, Kb luma weights. */
const K: Record<YuvMatrix, { kr: number; kb: number }> = {
  bt709: { kr: 0.2126, kb: 0.0722 },
  bt601: { kr: 0.299, kb: 0.114 }
}

export interface YuvDecode {
  /** subtract from the 0..1 sample (Y, Cb, Cr) */
  offset: [number, number, number]
  /** multiply after subtracting (Y, Cb, Cr) */
  scale: [number, number, number]
  /** R = Y + rCr·Cr ; G = Y + gCb·Cb + gCr·Cr ; B = Y + bCb·Cb */
  rCr: number
  gCb: number
  gCr: number
  bCb: number
}

/** Coefficients to turn 8-bit YUV samples (as 0..1) into RGB 0..1, for a matrix and range. */
export function yuvDecodeCoefficients(matrix: YuvMatrix, fullRange: boolean): YuvDecode {
  const { kr, kb } = K[matrix]
  const kg = 1 - kr - kb
  const offset: [number, number, number] = fullRange ? [0, 128 / 255, 128 / 255] : [16 / 255, 128 / 255, 128 / 255]
  const scale: [number, number, number] = fullRange ? [1, 1, 1] : [255 / 219, 255 / 224, 255 / 224]
  return { offset, scale, rCr: 2 * (1 - kr), gCb: (-2 * (1 - kb) * kb) / kg, gCr: (-2 * (1 - kr) * kr) / kg, bCb: 2 * (1 - kb) }
}

/** Reference decode of one sample (8-bit values in, RGB 0..1 out, clamped). */
export function yuvToRgb(y8: number, u8: number, v8: number, c: YuvDecode): [number, number, number] {
  const y = (y8 / 255 - c.offset[0]) * c.scale[0]
  const cb = (u8 / 255 - c.offset[1]) * c.scale[1]
  const cr = (v8 / 255 - c.offset[2]) * c.scale[2]
  const cl = (x: number) => Math.min(1, Math.max(0, x))
  return [cl(y + c.rCr * cr), cl(y + c.gCb * cb + c.gCr * cr), cl(y + c.bCb * cb)]
}

/** Reference encode to BT.709 limited range (what export files are tagged as): RGB 0..1 in, 8-bit Y/Cb/Cr out. */
export function rgbToYuv709Limited(r: number, g: number, b: number): [number, number, number] {
  const { kr, kb } = K.bt709
  const y = kr * r + (1 - kr - kb) * g + kb * b
  const cb = (b - y) / (2 * (1 - kb))
  const cr = (r - y) / (2 * (1 - kr))
  return [Math.round(16 + 219 * y), Math.round(128 + 224 * cb), Math.round(128 + 224 * cr)]
}
