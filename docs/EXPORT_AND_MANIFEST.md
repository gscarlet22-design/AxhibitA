# Export & Manifest spec — Axhibit A

## Export request (renderer → main)
```ts
type ExportRequest = {
  recordingId: string;
  inSec: number; outSec: number;           // media time
  trimMode: 'fast' | 'exact';
  view:
    | { kind: 'original' }
    | { kind: 'crop'; rect: { x: number; y: number; w: number; h: number } } // source px, even numbers
    | { kind: 'dewarp-ptz'; view: PtzState; calib: Calibration; outW: number; outH: number }
    | { kind: 'dewarp-pano'; view: PanoState; calib: Calibration; outW: number; outH: number }
    | { kind: 'view-path'; track: ViewKeyframe[]; calib: Calibration; outW: number; outH: number } // animated PTZ
    | { kind: 'zoom-path'; path: { aspect: number; keyframes: { tSec: number; value: { cxPx: number; cyPx: number; hPx: number } }[] } }; // 1.1: pan/zoom on the raw frame; outW/outH must match aspect
  redaction?: RedactionTrack[];             // applied in every re-encoded mode
  overlay: { timestamp: boolean; cameraName: boolean; customText?: string };
  includeAudio: boolean;
  outputDir: string;
  fileStem?: string;                        // default: <camera>_<YYYYMMDD-HHMMSS>_<dur>s
  notes?: string;                           // free text, goes into manifest
};
```

## Pipelines
All args are arrays built by pure functions in `src/shared/ffmpeg/args.ts`. Always read from the **original source path**, never from cache/proxy. Always pass `-nostdin -hide_banner -n`. Never pass `-y` (no overwrite); outputs go to pre-resolved unique paths.

### A. Fast trim, original view (stream copy)
```
ffmpeg -nostdin -hide_banner -n -ss <in> -i <src> -t <dur> -map 0:v:0 [-map 0:a:0] -c copy -avoid_negative_ts make_zero -movflags +faststart <out.mp4>
```
- Snaps to the keyframe at or before `in`. Compute actual start from keyframe index and record `actualInSec` in manifest. UI shows the snapped range before export.
- If the source codec can't go into MP4 (rare), fall back to MKV container and warn.
- No overlay possible in fast mode (overlay forces Exact).

### B. Re-encode via render pipeline (exact trim, any view, overlays, redaction)
```
decoder: ffmpeg -nostdin -hide_banner -ss <in> -i <src> -t <dur> -map 0:v:0 -vf [crop,scale,]fps,format=<yuvj420p|yuv420p>
          -f rawvideo -pix_fmt <same> pipe:1
renderer: hidden BrowserWindow (offscreen, sandboxed) runs the SAME WebGL renderer used on screen:
          per frame: upload Y/U/V planes → YUV→RGB on the GPU (source matrix + range) → redaction + view pass
          (normal/crop/dewarp/paths at frame time) → overlay box blended on the GPU → RGB→BT.709 limited yuv420p
          packed on the GPU → asynchronous readback (pixel-pack buffer + fence)
encoder: ffmpeg -nostdin -hide_banner -n -f rawvideo -pix_fmt yuv420p -color_range tv -colorspace bt709 ...
          -s <OWxOH> -r <fps> -i pipe:0 [-ss <in> -t <dur> -i <src> -map 1:a:0 -c:a aac -b:a 128k] -map 0:v:0
          -c:v <encoder> <encoderOpts> -pix_fmt yuv420p -color_range tv -colorspace bt709 ... -movflags +faststart <out.mp4>
```
- **Frame format (1.1.2):** frames cross processes as planar YUV 4:2:0 both ways, 2.7× fewer bytes than RGBA, with no colour conversion inside FFmpeg.
  - In: the source's own range is kept (`yuvTransportFor`: Axis streams are full-range `yuvj420p`), and the GPU converts with the stream's matrix (BT.709, or BT.601 when tagged or for SD), as the browser does on screen.
  - Out: the GPU writes exactly what the file is tagged as (BT.709 limited), so FFmpeg passes it straight to the encoder.
  - Fallback: RGBA in and out when the output width isn't a multiple of 8 or the height a multiple of 4 (`canPackYuvOutput`). `AXHIBIT_RGBA_FRAMES=1` forces RGBA in dev builds, for comparison.
  - Any WebGL error during upload or readback fails the export, so it can never silently write blank frames.
- **Colour check:** exports at native size, compared by PSNR with FFmpeg's own decode of the source converted to BT.709 limited range. The YUV path scores 44.8 dB (4K camera) and 46.9 dB (fisheye); the RGBA path scored 44.2 / 46.5 dB. GPU and software rendering (`AXHIBIT_DISABLE_GPU=1`) match to within 0.1 dB.
- Frame timing: decode with `-fps_mode cfr -r <avg fps>` so every frame has a fixed slot (ACS recordings can be variable-frame-rate); feed the encoder at the same rate. Record `normalizedFps` in the manifest `encode` operation.
- Backpressure: main copies decoder output once into per-frame buffers (≤3 buffered), sends frames to the renderer over a MessagePort with **three frames in flight** (`FramePipe`, replies matched by index; the renderer replies when each asynchronous readback lands), and writes rendered frames to encoder stdin in order, respecting `drain`. A log line reports frames/s, the frame formats, and time spent waiting on decode, render and encode.
- Decode plan (`planDecode` → `shared/export/footprint.ts`): for every view except Original, the decoder crops to the source region the view actually samples over the export range (PTZ/quad/view path via the TS dewarp mirror, zoom path via the union of its windows, zoomed normal view, crop) and downscales when the output never needs full detail (≥1.25 decoded px per output px where it needs the most), capped at 12 MP. The renderer offsets by `srcRect`, so redaction boxes stay in source px; the crop is padded 64 px when redactions are present.
- Zoom path frames: window from `evalZoom` (height interpolated in log space, center linear in source px, ease-in-out, clamped inside the frame, held outside the keyframes), drawn with the normal shader mode at `normScale = outH / hPx`.
- Overlay text is drawn by the renderer (2D canvas → texture), not by FFmpeg `drawtext` — no font escaping issues. Bundle an open-licensed font.
- Encoder options per encoder (`encoders.ts`): `h264_mf` `-b:v` = clamp(0.1 bpp × w × h × fps, 4M, 40M), `-g` = 2×fps; nvenc/qsv/amf CQ/QP ≈ 19–21.

### C. Snapshot
Renderer reads canvas (`toBlob('image/png')`) at **source-native output size** (render an offscreen framebuffer at full output resolution, not the screen size), sends bytes to main, main writes PNG + manifest. Record `mediaTime`, wall-clock time, view state.

## Progress & cancel
- Use `-progress pipe:1 -nostats`; parse `out_time_us` against duration.
- Cancel: send `q` on stdin is unavailable with `-nostdin`; kill the process tree, then delete partial output. Manifest is written only after success and output hash.

## Output naming
`<fileStem>.mp4` and `<fileStem>.mp4.manifest.json`. If either exists, append ` (2)`, ` (3)`… to the stem for both. Sanitize stems for Windows (`<>:"/\|?*`, reserved names, trailing dots/spaces, 120-char cap).

## Manifest schema (v1)
Validate with zod in `src/shared/manifest/schema.ts`. Write pretty-printed UTF-8 JSON.
```json
{
  "schema": "axhibit.manifest/1",
  "tool": { "name": "Axhibit A", "version": "1.0.0", "ffmpegVersion": "n7.1-...", "encoder": "h264_mf" },
  "createdAt": "2026-10-19T20:41:07.123Z",
  "createdBy": { "osUser": "jdoe", "operatorName": "optional, from settings" },
  "source": {
    "fileName": "Front Entrance_2026-10-12_08-30-00.asf",
    "absolutePath": "D:\\Exports\\Case 1234\\...\\Front Entrance_....asf",
    "sizeBytes": 123456789,
    "modifiedAt": "2026-10-12T14:02:11Z",
    "sha256": "…",
    "container": "asf", "videoCodec": "h264", "width": 2992, "height": 2992, "fps": 15,
    "durationSec": 600.0,
    "cameraName": "Front Entrance",
    "wallClockStart": "2026-10-12T08:30:00-05:00",
    "wallClockSource": "asf:creation_time | unavailable"
  },
  "integrity": {
    "acsDigitalSignature": "not_verified_by_this_tool",
    "signedVideo": { "status": "verified | partially_verified | failed | not_signed | unsupported | not_checked",
                     "checkedAt": "…", "publicKeySha256": "…", "invalidRanges": [], "validator": "signed-video-framework <commit>" },
    "statement": "This file is a derivative of the source listed above. The source file was opened read-only and was not modified. Retain the original export and verify it with AXIS File Player."
  },
  "operations": [
    { "type": "trim", "mode": "exact", "requestedInSec": 120.0, "requestedOutSec": 155.5, "actualInSec": 120.0, "actualOutSec": 155.5,
      "wallClockIn": "2026-10-12T08:32:00-05:00", "wallClockOut": "2026-10-12T08:32:35.5-05:00" },
    { "type": "dewarp", "mode": "ptz", "calibration": { "cxPx": 1496, "cyPx": 1490, "radiusPx": 1470, "fovDeg": 180, "model": "equidistant", "mount": "ceiling" },
      "view": { "panDeg": 42, "tiltDeg": 35, "hfovDeg": 70 } },
    { "type": "zoom_path", "aspect": 1.7778, "keyframes": [ { "tSec": 0, "cxPx": 500, "cyPx": 900, "hPx": 540 }, { "tSec": 3.5, "cxPx": 2300, "cyPx": 1500, "hPx": 540 } ],
      "interpolation": "window height in log space, center linear in source px, ease-in-out; ...", "maxUpscale": 1.333 },  // zoom-path exports only; maxUpscale > 1 = enlarged past native detail
    { "type": "redaction", "mode": "inside", "outsideStyle": null,
      "tracks": [ { "id": "r1", "style": "pixelate", "range": "from", "keyframes": [ { "tSec": 121.0, "value": { "x": 800, "y": 400, "w": 120, "h": 160 } } ] } ] },
      // mode "inside": each box is hidden with its style. mode "outside": everything except the boxes is hidden with
      // outsideStyle (blur | pixelate | solid). range: "from" = first keyframe to end (new boxes, starting 50 ms early to
      // cover the frame drawn on), "keyframes" = first..last keyframe, "all" or absent = whole recording (1.0).
    { "type": "overlay", "timestamp": true, "cameraName": true, "customText": null },
    { "type": "encode", "videoCodec": "h264", "encoder": "h264_mf", "audio": "aac 128k" }
  ],
  "ffmpegArgs": ["-nostdin", "-hide_banner", "-n", "..."],
  "output": { "fileName": "...mp4", "sizeBytes": 0, "sha256": "…", "width": 1920, "height": 1080, "fps": 15, "durationSec": 35.5 },
  "notes": "Requested by Det. Smith, case 1234"
}
```
Snapshot manifests use the same shape with `operations` containing `{ "type": "snapshot", "mediaTimeSec": ..., "wallClock": ... }` plus any dewarp op, and `ffmpegArgs: null`.

## Tests (unit)
- Arg builders for every view × trim mode × overlay × audio combination (snapshot tests on arrays).
- Unique-path resolver and Windows filename sanitizer.
- Manifest builder: required fields present, integrity fields fixed strings, schema validates.
- Encoder selection given mocked `ffmpeg -encoders` output.
