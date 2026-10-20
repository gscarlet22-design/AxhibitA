# Architecture — Axhibit A

## Process model
```
┌──────────────────────── Electron main (Node) ────────────────────────┐
│  ingest/      folder scan, ffprobe → MediaInfo                        │
│  media/       remux & proxy jobs (ffmpeg child processes)             │
│  export/      fast trim, render pipeline, snapshot, manifest writer   │
│  verify/      signed-video: ffmpeg annexb → sv-validate.exe → results │
│  hash/        streamed SHA-256 with cache                             │
│  jobs/        job queue: progress, cancel, cleanup                    │
│  store/       electron-store (settings, per-camera calibration)       │
└───────────────▲──────────────────────────────────────────────────────┘
                │ typed IPC (src/shared/ipc.ts) via preload contextBridge
┌───────────────┴──────────── Renderer (React, sandboxed) ─────────────┐
│  <video> (hidden, decode only) → WebGL2 canvas (display + dewarp)     │
│  state/ (Zustand): library, player, view, calibration, export dialog  │
│  ui/: Sidebar, Viewport, Transport/Timeline, RightPanel, Dialogs      │
└──────────────────────────────────────────────────────────────────────┘
src/shared/ — pure TS used by both: types, ipc, dewarp math, circle fit,
              ffmpeg arg builders, manifest builder, time utils
```

## Directory layout
```
src/
  main/        index.ts, ingest/, media/, export/, hash/, jobs/, store/, protocol.ts
  preload/     index.ts (exposes window.axhibit API)
  renderer/    main.tsx, App.tsx, state/, ui/, gl/ (shader.ts, renderer.ts)
  shared/      constants.ts, ipc.ts, types.ts, time.ts,
               dewarp/ (params.ts, project.ts, views.ts, circleFit.ts),
               ffmpeg/ (args.ts), manifest/ (schema.ts, build.ts)
resources/bin/ ffmpeg.exe, ffprobe.exe (fetched, gitignored) + LICENSES
scripts/       fetch-ffmpeg.mjs, make-fixtures.mjs
tests/         unit/, e2e/, fixtures/ (generated synthetic media, small)
samples/       real ACS exports (gitignored)
docs/
```

## Binaries
- `scripts/fetch-ffmpeg.mjs` downloads a **pinned LGPL shared or static-LGPL build** for win64 (e.g. BtbN `ffmpeg-n7.x-latest-win64-lgpl-*`), verifies a pinned SHA-256, extracts `ffmpeg.exe`/`ffprobe.exe` into `resources/bin/`, and copies the license text into `resources/bin/LICENSES/`.
- LGPL builds do **not** include libx264. For H.264 encoding use, in priority order, detected at startup with `ffmpeg -encoders`:
  1. `h264_mf` (Windows Media Foundation — always present on Windows 10/11)
  2. `h264_nvenc` / `h264_qsv` / `h264_amf` when available
  3. `libopenh264` if the build includes it
  Record the chosen encoder in the manifest. Put encoder-selection logic in `src/shared/ffmpeg/encoders.ts` with tests.
- During dev on macOS/Linux, allow `AXHIBIT_FFMPEG_DIR` env override.
- In production resolve via `process.resourcesPath/bin`.

## Ingest
1. User drops/opens folder or files. Main walks folder (depth ≤ 3) for `.asf .mkv .mp4`.
2. For each file: `ffprobe -v error -print_format json -show_format -show_streams -show_entries ...`. Parse into `MediaInfo` (`src/shared/types.ts`): path, size, mtime, container, duration, video {codec, width, height, fps, pixFmt}, audio?, tags, `wallClockStart?: string (ISO)`, `cameraName?: string`.
3. Wall-clock and camera-name extraction rules come from `docs/FINDINGS.md` (M0). Implement as a pure function `deriveRecordingMeta(probeJson, siblingFiles)` with tests using captured probe JSON from samples (sanitized, committed to `tests/fixtures/probe/`).
4. Keyframe index (for timeline ticks + Fast trim preview): `ffprobe -select_streams v -skip_frame nokey -show_entries frame=pts_time -of csv` run lazily in background.

## Playback pipeline
1. **Playable check** in renderer: `MediaCapabilities.decodingInfo` for `video/mp4; codecs="avc1.*"` or `"hvc1.*"` at the file's resolution/fps.
2. **Remux** (always for ASF/MKV; skip for MP4 if already faststart-compatible and playable): `ffmpeg -i src -map 0:v:0 -map 0:a? -c copy -movflags +faststart+frag_keyframe+empty_moov cache/<hash>.mp4`. Lossless, seconds.
3. **Proxy** if not playable (e.g. HEVC without hardware support): transcode to H.264 at source resolution (cap 4K) with the selected encoder; show progress. Proxies are for viewing only; **exports always read the original source**.
4. Serve cache files to the renderer through a custom protocol `axhibit-media://` registered in main with range-request support (needed for seeking). Do not expose arbitrary paths: protocol resolves only IDs registered by main.
5. Cache: `userData/cache`, keyed by source SHA-256 prefix + size + mtime. LRU cleanup, default limit 20 GB, configurable; "Clear cache" in settings.

## Rendering
- WebGL2 canvas sized to viewport × devicePixelRatio.
- Upload frames with `texImage2D(video)` driven by `requestVideoFrameCallback` (fallback to rAF).
- Two programs: `passthrough` (with digital zoom/pan via UV transform) and `dewarp` (DEWARP.md).
- Time overlay is DOM, not baked into canvas (burn-in only on export).
- Frame step: seek by `1/fps` from current `mediaTime` reported by rVFC metadata.

## Persistence (JSON store in userData — `src/main/store.ts`, atomic writes; replaces electron-store)
- `settings`: theme, cache limit, default export folder, default trim mode, encoder override, operator name (optional).
- `calibrations`: map keyed by `cameraKey = cameraName ?? '<w>x<h>|<fileStem prefix>'` → `{cx, cy, r, fovDeg, mount, updatedAt}`.
- `recent`: recently opened folders (paths only).

## IPC surface (src/shared/ipc.ts)
| Channel | Req | Res |
|---|---|---|
| `library:open` | `{paths: string[]}` | `{recordings: Recording[]}` |
| `media:prepare` | `{recordingId, needProxy: boolean}` | `{jobId}` → events → `{mediaUrl}` |
| `media:keyframes` | `{recordingId}` | `{times: number[]}` |
| `hash:source` | `{recordingId}` | `{jobId}` → `{sha256}` |
| `export:clip` | `ExportRequest` | `{jobId}` → `{outputPath, manifestPath}` |
| `export:snapshot` | `{recordingId, pngBytes, viewState, mediaTime}` | `{outputPath, manifestPath}` |
| `jobs:cancel` | `{jobId}` | `{ok}` |
| `jobs:event` (main→renderer) | — | `{jobId, kind:'progress'|'done'|'error', ...}` |
| `store:get/set` | typed keys | typed values |
| `dialog:pickFolder` | `{}` | `{path?}` |

Preload exposes only these as `window.axhibit.*`. Validate all inputs in main with zod.

## Error handling
- FFmpeg failures: capture last 50 stderr lines into the job error; show a friendly message with a "Copy details" button.
- Never crash on one bad file; mark it and continue.

## Logging
- `userData/logs/axhibit.log` rotating (5 × 5 MB). No video content or full hashes of user files in logs beyond what's needed for debugging.

## Render pipeline (exports)
- A hidden `BrowserWindow` (`show: false`, sandboxed, same preload) loads `renderer/export.html`, which reuses `src/renderer/gl/` (the exact on-screen renderer) with an offscreen framebuffer at output size.
- Main ↔ export window uses a dedicated `MessageChannelMain`; frames are structured-cloned (MessagePortMain cannot receive transferred ArrayBuffers). One frame in flight, up to 3 decoded frames queued; decoder stdout is paused for backpressure.
- Frames are assembled from decoder chunks with one copy per frame (never re-concatenate a growing buffer — that is quadratic for 33 MB fisheye frames).
- Exports encode to `<name>.partial.mp4` and are renamed only after success; the manifest is written last (`wx`).
- Chromium flags `ignore-gpu-blocklist` + `enable-unsafe-swiftshader` keep WebGL2 working on blocklisted GPUs, RDP sessions and VMs.
- Per frame the renderer receives `{index, mediaTimeSec, rgba}` and evaluates tracks (redaction, view path) at `mediaTimeSec`.
- See EXPORT_AND_MANIFEST.md → Pipeline B for FFmpeg arguments.

## Multi-camera sync
- `src/shared/sync.ts`: master clock in wall-clock ms; each tile maps to its media time via `wallClockStart` + manual offset; outside coverage → "No video".
- One `<video>` per tile (max 4). A rAF loop compares each tile's `currentTime` to target: |error| > 150 ms → seek; otherwise nudge `playbackRate` by up to ±3%.
- Each tile has its own view state and renderer viewport (single WebGL canvas, scissored viewports).

## Tracks (redaction & view path)
- `src/shared/tracks.ts`: `Track<T> = { id, kind, keyframes: {tSec, value: T}[] }`, `evaluate(track, t)`; boxes interpolate linearly, view states with ease-in-out and shortest-path yaw.
- Redaction boxes are in source-pixel space; the shader applies them to the source texture before view sampling, so they hold in every view.
- Project state (tracks, calibrations used, in/out) saves to `<name>.axhibit.json` in the export folder or userData — never beside the source.

## Signed video (native)
- `native/sv-validate/`: small C program linking the pinned `signed-video-framework` and OpenSSL (static). Reads Annex-B bytes on stdin, `--codec h264|h265`, prints NDJSON: one line per validation report (GOP range, authenticity, public key fingerprint) and a final summary.
- Built by `scripts/build-native.sh`: Linux (tests) and win64 via mingw-w64 → `resources/bin/sv-validate.exe`.
- Main pipes `ffmpeg -i src -map 0:v:0 -c copy -bsf:v <codec>_mp4toannexb -f <codec> pipe:1` into it; maps NAL positions back to timestamps using the keyframe index.
