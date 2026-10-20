import { describe, expect, it } from 'vitest'
import { rgbToYuv709Limited, yuvDecodeCoefficients, yuvToRgb } from '@shared/color'

describe('YUV decode', () => {
  it('maps limited-range black, white and grey correctly', () => {
    const c = yuvDecodeCoefficients('bt709', false)
    expect(yuvToRgb(16, 128, 128, c)).toEqual([0, 0, 0])
    yuvToRgb(235, 128, 128, c).forEach((x) => expect(x).toBeCloseTo(1, 6))
    yuvToRgb(126, 128, 128, c).forEach((x) => expect(x).toBeCloseTo((126 - 16) / 219, 6))
  })
  it('maps full-range (Axis yuvj) black and white to the ends of the scale', () => {
    const c = yuvDecodeCoefficients('bt709', true)
    expect(yuvToRgb(0, 128, 128, c).map((x) => +x.toFixed(6))).toEqual([0, 0, 0])
    yuvToRgb(255, 128, 128, c).forEach((x) => expect(x).toBeCloseTo(1, 2))
  })
  it('uses the right matrix (BT.709 vs BT.601 give different reds)', () => {
    const r709 = yuvToRgb(63, 102, 240, yuvDecodeCoefficients('bt709', false))
    expect(r709[0]).toBeCloseTo(1, 1) // BT.709 limited red is (63, 102, 240)
    const m709 = yuvToRgb(110, 150, 100, yuvDecodeCoefficients('bt709', false))
    const m601 = yuvToRgb(110, 150, 100, yuvDecodeCoefficients('bt601', false))
    const diff = m709.reduce((a, x, i) => a + Math.abs(x - m601[i]), 0)
    expect(diff).toBeGreaterThan(0.03)
  })
})

describe('YUV encode for export', () => {
  it('produces the standard BT.709 limited-range values', () => {
    expect(rgbToYuv709Limited(0, 0, 0)).toEqual([16, 128, 128])
    expect(rgbToYuv709Limited(1, 1, 1)).toEqual([235, 128, 128])
    expect(rgbToYuv709Limited(1, 0, 0)).toEqual([63, 102, 240])
  })
  it('round-trips colors within one code value', () => {
    const c = yuvDecodeCoefficients('bt709', false)
    const samples: [number, number, number][] = [[0.2, 0.5, 0.7], [0.9, 0.1, 0.3], [0.5, 0.5, 0.5], [0.05, 0.8, 0.2]]
    for (const rgb of samples) {
      const [y, u, v] = rgbToYuv709Limited(rgb[0], rgb[1], rgb[2])
      const back = yuvToRgb(y, u, v, c)
      back.forEach((x, i) => expect(Math.abs(x - rgb[i])).toBeLessThan(2.5 / 219))
    }
  })
})
