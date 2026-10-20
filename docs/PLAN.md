# Plan — Axhibit A (1.0)

Work top to bottom. Tick boxes as you go. Each milestone ends with its gate.

## M0 — Scaffold & discovery
- [x] Scaffold electron-vite + React + TS strict + Tailwind + Zustand; eslint; Vitest; Playwright-electron
- [x] Security baseline: contextIsolation, sandbox, CSP, typed preload
- [x] `scripts/fetch-ffmpeg.mjs`: pinned LGPL win64 FFmpeg + SHA-256; `AXHIBIT_FFMPEG_DIR` dev override
- [x] `src/shared/constants.ts` with `APP_NAME = 'Axhibit A'`
- [x] `scripts/make-fixtures.mjs`: synthetic fisheye (centered, off-center, clipped), standard 1080p, H.265, audio, ASF/MKV/MP4 variants, two "cameras" with overlapping wall-clock tags
- [x] Windows portable build works end-to-end from Linux (electron-builder + wine) — prove the pipeline early
- [x] When samples arrive: probe every file → `tests/fixtures/probe/`; fill `docs/FINDINGS.md`; resolve PRD open questions

**Gate:** dev app opens; lint/test green; an (empty) portable .exe builds.

## M1 — Open & play
- [x] Ingest: folder walk, ffprobe → `MediaInfo`, `deriveRecordingMeta()` (tests on probe fixtures)
- [x] Sidebar list grouped by camera, error badges
- [x] Job system: queue, progress, cancel, cleanup
- [x] Remux to cache; `axhibit-media://` protocol with range requests
- [x] Playable check → proxy job when needed
- [x] WebGL2 passthrough renderer (rVFC); digital zoom/pan
- [x] Transport & timeline with wall-clock labels, keyframe ticks
- [x] Cache LRU + clear; background source SHA-256

**Gate:** all fixtures (and samples, if present) play; originals' hashes/mtimes unchanged (automated e2e check).

## M2 — Live dewarp
- [x] `src/shared/dewarp/`: params, mounts, `viewToSource`/`sourceToView` + tests
- [x] GLSL shader: PTZ, panorama, double panorama; quad via 4 viewports
- [x] Shader ↔ TS mirror equivalence test (≤ 0.5 px)
- [x] Interactions (drag, wheel, double-click center, reset, pano offset, per-quadrant)
- [x] Circle auto-detect + tests on synthetic fixtures
- [x] Calibration overlay/panel, per-camera persistence
- [x] Debug overlay with frame times (Ctrl+Shift+D)

**Gate:** straight lines straight near center on fixtures; auto-detect passes on all synthetic variants.

## M3 — Export core (render pipeline)
- [x] Encoder detection/selection (`encoders.ts`)
- [x] Render pipeline: FFmpeg decode (rawvideo rgba) → hidden offscreen renderer window → readPixels → FFmpeg encode; backpressure; progress; cancel
- [x] Fast trim (stream copy) for untouched original view
- [x] Overlay text rendered by the renderer (timestamp, camera, custom)
- [x] Export dialog, integrity notice, unique naming, Windows filename sanitizing
- [x] Manifest builder + schema; output hash; failure cleanup
- [x] Snapshot (S) at full output resolution
- [x] Preview ↔ export pixel parity test on fixtures (≤ 2/255 mean diff before encode)

**Gate:** exports of every fixture play in VLC/Chrome/WMP; manifests validate; parity test green.

## M4 — Synced multi-camera
- [x] Shared clock model (`src/shared/sync.ts`): master wall-clock → per-recording media time; gap handling; manual offsets
- [x] Grid layout (2×1, 2×2), per-tile view state, focus on double-click
- [x] Drift correction loop (playbackRate nudge ±3%, hard seek > 150 ms)
- [x] Combined timeline showing each camera's coverage

**Gate:** two fixture "cameras" stay within 1 frame over 10 min (automated test using burned-in frame counters).

## M5 — Redaction & animated PTZ
- [x] Keyframe track model (`src/shared/tracks.ts`): add/move/delete, interpolation (linear for boxes, ease for view), serialization
- [x] Redaction boxes in source space; styles blur/pixelate/solid; shader pass applied before dewarp sampling
- [x] Redaction UI: draw, select, move/resize at time t → keyframe; track lane on timeline
- [x] View-path recording (sample every 100 ms while playing, then simplify) + manual keyframes
- [x] Export honours tracks; manifest records tracks
- [x] Project file (`.axhibit.json`, saved next to exports or in userData — never next to source) to save/reload redactions & paths

**Gate:** redaction box follows a moving target in the fixture within its keyframes; exported clip shows no unredacted frames inside the track range (automated pixel check).

## M6 — Signed video verification
- [x] Vendor `AxisCommunications/signed-video-framework` (pinned commit) under `native/`; small C CLI `sv-validate` reading Annex-B H.264/H.265 from stdin and printing JSON results per GOP
- [x] Cross-compile for win64 with mingw-w64 (static OpenSSL); Linux build for tests
- [x] Main: FFmpeg `-c copy -bsf:v h264_mp4toannexb|hevc_mp4toannexb -f h264|hevc pipe:1` → `sv-validate`
- [x] UI: Verify panel + status strip on timeline; results cached by source hash; carried into manifests
- [x] Tests: framework's own signed test streams (if available) + tampered variants

**Gate:** signed test stream → Verified; one altered frame → Failed with the correct time range; unsigned → Not signed.
**Risk:** if SEI does not survive ACS export in a container, report "Unsupported for this container" and say which container to export instead.

## M7 — Polish & package
- [x] Settings (cache limit, default folder, encoder, operator name) — light theme not implemented
- [x] Drag-and-drop; open via command-line arg
- [x] Shortcut sheet, friendly errors with "Copy details", rotating logs
- [x] About: version, FFmpeg version, licenses (FFmpeg LGPL, OpenSSL, signed-video-framework, fonts)
- [x] App icon; portable x64 .exe; README; `docs/USER_GUIDE.md`
- [ ] Smoke e2e on packaged build (run on a Windows machine; Linux e2e covers the same flows)

**Gate:** portable .exe runs on a clean Windows 11 machine without admin rights; manual checklist passes.

## Sample checklist (from user → `samples/`)
- [x] Fisheye H.264 — same clip as ASF, MKV, MP4
- [x] Fisheye H.265
- [x] Standard (non-fisheye) camera
- [x] 2+ cameras, same time window
- [ ] Camera with signed video enabled (ACS recordings so far carry no SEI — see FINDINGS §7)
- [x] Export with audio (fisheye MKV/ASF and HEVC MP4)
- [ ] Export with digital signature on (folder exactly as ACS produced it)

## Risks
| Risk | Mitigation |
|---|---|
| Render pipeline throughput (large frames over IPC) | Transfer ArrayBuffers via MessagePort; scale before upload when output is smaller; measure in M3 |
| LGPL build lacks libx264 | `h264_mf` always on Win10/11; HW encoders when present |
| HEVC playback unavailable | Proxy transcode |
| No wall-clock metadata | Relative time; manual multi-cam offsets |
| Signed-video SEI stripped by export container | Detect and report; recommend container |
| Cross-compiling OpenSSL + framework for Windows | mingw-w64 static build in CI script; fallback to a TS port of the validator |
| Unsigned .exe triggers SmartScreen | Document "More info → Run anyway"; code signing later |

## Status (2026-10-19)
Built and tested on Linux (xvfb + software WebGL) against Garrett's real ACS exports: 51 unit tests, 15 feature e2e checks
(signed/tampered/unsigned verification, solid redaction burn-in, view-path export, fast trim, snapshot, 3-camera sync,
originals unchanged). Windows portable exe builds from Linux; sv-validate.exe verified under Wine.

Tested on Garrett's Windows laptop the same day (NVENC export, native HEVC, live dewarp, 3-camera sync, sv-validate.exe).

**Remaining work and new features: see `docs/HANDOFF.md`.**

Open:
- Real signed-video recording from ACS (none of the samples carry SEI)
- Meaning of Axis LensProfile (would replace the equidistant default)
- TiltOrientation values for wall/desk mounts
- Code signing certificate
- Multi-camera grid export (US8 stretch)
