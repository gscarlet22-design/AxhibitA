/** H.264 encoder selection (docs/ARCHITECTURE.md → Binaries). */

export type H264Encoder = 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'h264_mf' | 'libopenh264' | 'libx264'

/** Preference order: hardware first, then Media Foundation (always on Win10/11), then software. */
export const ENCODER_PRIORITY: H264Encoder[] = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264', 'libopenh264']

/** Parse `ffmpeg -hide_banner -encoders` output into the H.264 encoders it lists. */
export function parseEncoderList(out: string): H264Encoder[] {
  const found = new Set<string>()
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*V[.A-Z]{5}\s+(\S+)/.exec(line)
    if (m) found.add(m[1])
  }
  return ENCODER_PRIORITY.filter((e) => found.has(e))
}

/** Args for a tiny test encode to prove an encoder actually works on this machine (HW may be listed but absent). */
export function encoderSmokeTestArgs(enc: H264Encoder): string[] {
  return ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=15:d=0.4', '-c:v', enc, ...encoderOptions(enc, 320, 240, 15), '-f', 'null', '-']
}

export function targetBitrate(w: number, h: number, fps: number): number {
  const bpp = 0.1
  return Math.round(Math.max(4e6, Math.min(40e6, bpp * w * h * Math.max(fps, 1))))
}

/** Quality-oriented options per encoder. */
export function encoderOptions(enc: H264Encoder, w: number, h: number, fps: number): string[] {
  const gop = String(Math.max(1, Math.round(fps * 2)))
  const br = String(targetBitrate(w, h, fps))
  switch (enc) {
    case 'h264_nvenc':
      return ['-preset', 'p5', '-rc', 'vbr', '-cq', '20', '-b:v', '0', '-g', gop, '-profile:v', 'high']
    case 'h264_qsv':
      return ['-global_quality', '21', '-look_ahead', '0', '-g', gop, '-profile:v', 'high']
    case 'h264_amf':
      return ['-rc', 'cqp', '-qp_i', '20', '-qp_p', '22', '-quality', 'quality', '-g', gop, '-profile:v', 'high']
    case 'h264_mf':
      return ['-b:v', br, '-rate_control', 'quality', '-quality', '90', '-g', gop, '-hw_encoding', '0']
    case 'libx264':
      return ['-preset', 'medium', '-crf', '19', '-g', gop, '-profile:v', 'high']
    case 'libopenh264':
      return ['-b:v', br, '-g', gop]
  }
}
