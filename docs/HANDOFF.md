# Handoff: Axhibit A 1.0 → 1.1

**Read this first, then `CLAUDE.md`.** This file is the work queue. Tick items here as they're done.

## Where things stand (2026-10-19)

1.0 is built, packaged as a portable Windows exe, and **tested on Garrett's Windows laptop** (NVIDIA GPU) against real ACS Pro exports. These worked on real Windows:

- Opening a folder of 24 recordings in ASF, MKV and MP4
- 4K H.264 playback
- Native H.265 playback, with no proxy needed
- Live quad and PTZ dewarp of 8 MP H.265
- Export of a dewarped clip with overlays and audio through `h264_nvenc`, with a correct manifest and hash
- `sv-validate.exe` reporting "Not signed"
- Synced 3-camera P3738 playback, with gaps handled

Linux CI covers 51 unit tests and 15 feature e2e checks (`tests/e2e/features.mjs`).

**Real data:** the maintainer's ACS exports (12 folders) are **not in the repo**. Point `AXHIBIT_SAMPLES` at a local folder of exports, and copy `tests/e2e/samples.example.json` to `samples.local.json` (git-ignored) with file names from it. `docs/FINDINGS.md` describes what such exports contain. Treat them as **read-only evidence**: never write into those folders. A scratch subfolder (`scratchFolder` in the config, default `_Axhibit build`) may be used.

**Signed-video fixtures:** the e2e test looks for `signed.mkv` and `tampered.mkv` in `AXHIBIT_SIGNED_FIXTURES` (default `tests/fixtures/media`). If they're missing, those checks are skipped.
- Make synthetic ones on Linux/WSL with `scripts/make-signed-fixtures.sh`. It signs a test pattern with a throwaway key, then flips one byte in GOP 4 for the tampered copy. Commit them; only those two names are un-ignored.
- The earlier fixtures were real camera footage and are kept out of the repo (`tests/fixtures/private/`, git-ignored).
- No ACS recording has signed video yet.

## 0. Make the project build on Windows (do this first)

The project was developed on Linux. On this Windows machine:

- [x] **Restore git history.** This folder was copied without `.git`; the history is in `axhibit-history.bundle`. Run:
  ```
  git init
  git fetch axhibit-history.bundle master:master
  git reset master
  ```
  Then delete the bundle. `git status` should then show only `resources/bin/sv-validate.exe` and the license files as untracked (they're gitignored build outputs, which is fine).

- [x] `npm install`. The repo pins TypeScript 5 and Vite 8; keep `vitest.config.mts` and `electron.vite.config.mts` as `.mts`.
- [x] **Fix `scripts/fetch-ffmpeg.mjs`.** It shells out to `unzip`, which Windows doesn't have. Use `tar -xf` (bsdtar ships with Windows 10/11) or a small JS unzip. Keep the pinned SHA-256 check.
  - BtbN's `latest` assets get rebuilt. If the hash no longer matches, pin to a dated release tag instead of `latest`.
- [x] `resources/bin/sv-validate.exe` is **prebuilt and already in place** (cross-compiled with mingw + static OpenSSL 3.0.15, signed-video-framework v2.3.12 @ `0feb0879`). Don't try to rebuild it on Windows. `scripts/build-native.sh` is Linux-only; document that in README.
  - For unit/e2e tests on Windows, `paths.ts` looks for `sv-validate.exe` in `resources/bin`, which already works.
- [x] Make e2e tests portable:
  - `tests/e2e/*.mjs` assume `samples/` and `xvfb-run`. Add `AXHIBIT_SAMPLES` (default `samples/`, set to the local exports folder here).
  - Copy the signed fixtures into a scratch dir instead of `samples/zz-signed-test`.
  - Use `ffmpeg` from `resources/bin` (Windows has no system ffmpeg).
- [x] Add `npm run test:e2e` → `node tests/e2e/features.mjs`, and delete the throwaway scripts `smoke.mjs`, `export.mjs`, `grid-debug.mjs` and `ui-tour.mjs`, or fold what's useful into `features.mjs`.
- [x] `npm run dist:win` should produce `dist/AxhibitA-<ver>-portable.exe` natively.

**Gate:** `npm run lint`, `npm test`, `npm run test:e2e` and `npm run dist:win` all pass on Windows.

> **Done 2026-10-19.** On Windows: lint is clean, there are 51/51 unit tests, 22/22 e2e checks pass against the real ACS exports (originals unchanged by hash and mtime), and `dist/AxhibitA-1.0.0-portable.exe` (178 MB) builds natively. Notes:
> - `git init` needs `-b master`, and the fetch needs `--update-head-ok`.
> - After the restore, `build/icon.png`, `build/icon-256.png` and one signed-video fixture differ from the commit. The working copies were regenerated after the last commit; they were kept, and the tests pass with them.
> - `native/signed-video-framework` (a submodule) is absent. It's only needed for the Linux `build-native.sh`.
> - The pinned FFmpeg SHA-256 still matched.
> - New: `AXHIBIT_USER_DATA` (unpackaged builds only) gives tests a throwaway profile, so e2e runs don't trip the single-instance lock when Axhibit A is open.
> - `tests/e2e/features.mjs` now also covers dewarp modes, a PTZ export with pixelate redaction and custom overlay, and zero page errors.
> - `export.mjs` became `scripts/bench-export.mjs` (`npm run bench:export`) for the export-speed work.
> - Removed the unused `resources/fonts` extraResource and `fontsDir()`.

## 1. Fix quirks found in the Windows test

- [x] **Synced view: blank tiles while loading.** A tile shows nothing while its file is remuxed (about 10 s for the 266 MB P3738 files).
  - Show "Preparing…" plus progress in the tile (`TileLabel` in `Viewport.tsx`; the job's progress is in `useApp().jobs` filtered by `recordingId`).
  - Pre-prepare every segment of every grid camera when the grid opens, not only the active one (`Player.setGrid`).
  - *Done:* `Tile.pendingId` shows "Preparing… N%" (or the error). `prepareGrid` prepares cameras in parallel, with segments nearest the playhead first. Covered by two new e2e checks.
- [x] **Recordings list mouse-wheel scroll** may not work: wheel over the sidebar didn't scroll during remote testing, though dragging the scrollbar did. Reproduce by hand.
  - If real, check `Sidebar.tsx` (`aside` → `flex-1 overflow-y-auto`) and the global `dragover`/`drop` listeners in `App.tsx`.
  - *Not reproducible:* real wheel input via Playwright scrolls the list (0 → 400 → 700 px), including over recording buttons. This was an artifact of the remote session. If Garrett still sees it by hand, reopen this item.
- [x] **Export dialog taller than a 1080p@125% window**: the Export button sits below the fold.
  - Make the header and footer sticky with the body scrolling, or a two-column layout.
  - Also make the `Choose a folder…` row show the default export folder (Settings) when one is set.
  - *Done:* the header and footer (error, progress, Export) are fixed and the body scrolls. Checked at 1536×820: the Export button is visible. The default folder is also picked up if settings load after the dialog opens.
- [x] **Export speed:** a 73-frame 1080p dewarp from an 8 MP H.265 source took about 30 s with NVENC. The bottleneck is the RGBA round-trip of full 2880×2880 frames over IPC.
  - Options, in order of effort:
    1. For dewarp exports, decode at a reduced size when the output covers a small part of the circle (`planDecode`: cap by output pixels × zoom factor, not a flat 12 MP).
    2. Send frames as `SharedArrayBuffer`s or via a shared-memory addon.
    3. Pipeline two frames in flight.
  - Target: at least 2× faster. Measure with a log line of frames/second.
  - *Done:* options 1 and 3.
    - `shared/export/footprint.ts` projects the view through the TS dewarp mirror and decodes only the source region it samples (PTZ, quad, view path, zoomed normal, crop), at only the detail it needs. Redactions are fine with cropping.
    - `FramePipe` keeps two frames in flight.
    - Benchmark (`npm run bench:export`, 75 frames, 1080p PTZ from 2880² H.265, NVENC): the render loop went from ~16.7 s to **7.0 s (10.8 fps, 2.4×)**, and the whole job from 21.2 s to 11.5 s, including app-start encoder detection.
    - The log line reads `render: N frames in S s (F fps); waited decode/render/encode ms`.
    - The remaining time is split evenly between decode, render and encode. Next steps if needed: `-hwaccel d3d11va` for HEVC decode, or YUV frames instead of RGBA (needs a conversion pass).
    - Encoder detection also ran three times in parallel at startup; it's now shared.
- [ ] **Single-instance + open-with:** confirm that dropping a folder onto the exe and "Open with" both work on Windows (`pathsFromArgv`).
  - *Code done, manual check left for Garrett.*
    - Parsing moved to `shared/argv.ts` with tests: it skips Chromium switches anywhere and resolves relative paths against the second instance's working directory.
    - Paths from a second launch during startup are now queued instead of dropped.
    - Not exercised against the packaged exe, because Garrett's running copy holds the single-instance lock.
    - **To check:** close Axhibit A, drag a folder onto the exe, then with it open, use Open with on an .asf.
- [x] **First launch:** the portable exe unpacks about 140 MB to `%TEMP%` on every start, which is a few seconds.
  - Consider shipping a zip of `win-unpacked` as well; note it in the user guide.
  - *Done:* `dist:win` also builds `AxhibitA-<ver>-win-x64.zip`. USER_GUIDE explains when to use it, plus drag-onto-exe and Open with.

## 2. NEW: Zoom paths for any camera (Garrett's request)

**Goal:** an investigator can follow a person or vehicle across a large image from any camera, not just fisheyes. Typical cases:

- 180° panoramic cameras (e.g. "Parking 180", 5120×2560)
- Multi-sensor 4K heads (P3738)
- Fixed-lens cameras

They record a moving zoom (pan and zoom over time) and export a clip that follows it, so the recipient sees the subject large without scrubbing around a 4K frame.

Today, view paths exist only for fisheye PTZ (`viewPath: Keyframe<PtzState>[]`, driven by `evalPtz`, exported as `{ kind: 'view-path' }`). Generalize them:

> **Status (2026-10-19): implemented.** Unit tests, 7 new e2e checks and a real export from Parking 180 pass. What changed from the plan:
> - **Separate field, not a union.** `PerRecording.zoomPath: ZoomPath | null` (plus `followZoom`, `frameGuide`) sits next to the existing PTZ `viewPath` instead of replacing it with a `ViewPath` union. This leaves working PTZ code untouched.
> - **No project migration needed.** Old projects simply lack `zoomPath`. Save/load goes through `shared/project.ts` (`entryFromState` / `stateFromEntry`, tolerant of old and malformed files, with tests).
> - **Where the code lives:** zoom math is in `shared/zoom.ts`, not `tracks.ts`; `tracks.ts` now exports the shared `ease`.
> - **Box drawing:** the **Z** key / **▭ Draw frame** button, with a live preview of the resulting frame.
> - **Decode plan:** this landed in section 1 as `shared/export/footprint.ts`, covering all views; zoom paths add the union of their windows. Real data: Parking 180, 10 s at 1080p, decoded a 3734×1132 crop instead of 5120×2560.
> - **Synthetic fixture:** generated by the e2e test itself (a red square on gray, overlay with a time expression). The LGPL FFmpeg has no `drawtext`, so the square isn't numbered.
> - **Measured:** the first and last frames are centered within 0.5 px, the redaction box stays on its source spot, the manifest records `zoom_path` with `maxUpscale`, and playback follows the path.
> - **Not done:** dragging a diamond to retime it (nice-to-have).
> - **Follow-up:** big H.264 sources are decode-bound. Parking 180 rendered at 8.1 fps and waited 9.8 s of 18.5 s on the decoder. Try `-hwaccel d3d11va` (with software fallback) in `renderDecodeArgs`.

### Model
**Decision: zoom keyframes are source-pixel windows, not `NormalState`.** `NormalState.zoom` is relative to the *screen* viewport ("1 = fit"), so the same keyframe would frame different things on different window sizes and output aspects. A source-pixel window is unambiguous, survives resizes, and goes straight into the manifest.

- [x] Add to `src/shared/types.ts`:
  ```ts
  /** A framing window in source pixels. Width is h * path.aspect. */
  interface ZoomWindow { cxPx: number; cyPx: number; hPx: number }

  type ViewPath =
    | { kind: 'ptz'; keyframes: Keyframe<PtzState>[] }                    // fisheye dewarp (existing)
    | { kind: 'zoom'; aspect: number; keyframes: Keyframe<ZoomWindow>[] } // digital zoom on the raw frame (new)
  ```
  - `aspect` is chosen when the path is created (default 16:9; 4:3 and 1:1 also offered). The frame guide and the export size both use it.
  - Add pure helpers `windowFromNormal(n, srcW, srcH, vp, aspect)` and `normalFromWindow(...)` to convert between the live `NormalState` and a `ZoomWindow`. The live view still runs on `NormalState`; only paths store windows.
- [x] Replace `PerRecording.viewPath: Keyframe<PtzState>[]` (`renderer/src/state/store.ts:10`) with `viewPath: ViewPath | null`. Update every caller:
  - `player.ts` (record/follow, about lines 390–450)
  - `App.tsx:79` (K hotkey, which is PTZ-only today)
  - `RightPanel.tsx` (section UI ~151–158; project save/load ~246–272)
  - `Transport.tsx:183–185` (lane)
  - `ExportDialog.tsx` (`hasPath`, choice)
- [x] **Project migration:** `ProjectFile.recordings[*].viewPath` (`shared/ipc.ts:98`). On load, a bare array means `{ kind: 'ptz', keyframes }`. Write the new shape on save, and bump a `version` field in `ProjectFile` if there isn't one.
- [x] `src/shared/tracks.ts`:
  - Add `evalZoom(path, t, srcW, srcH): ZoomWindow | null`, using the same ease-in-out as `evalPtz`:
    - Interpolate **`hPx` in log space** (`exp(lerp(log h0, log h1, f))`) so zoom changes feel uniform.
    - Interpolate the center linearly in source pixels.
    - **Clamp** the window inside the frame. Clamp `hPx` to ≤ `srcH` and to ≤ `srcW / aspect`, then shift the center so the window doesn't leave the frame.
  - Add `simplifyZoomPath(samples, tolFrac = 0.02)`. Drop a sample when the interpolated window's center and height are within `tolFrac × hPx` of it.
  - Unit tests: endpoints exact, log-zoom midpoint is the geometric mean, clamping at all four edges and corners, simplify keeps sharp turns, migration of old projects.

### Interaction (single view, Raw / non-fisheye)
- [x] The View tab gets a **"Zoom path"** section whenever the view is Raw (non-fisheye camera, or fisheye in Raw mode). It mirrors the existing PTZ "View path" section:
  - **● Record path:** play and steer with wheel-zoom + drag-pan, then **■ Stop**. Sample every 100 ms, then simplify.
  - **◆ Add keyframe (K):** at the current time and framing.
  - Remove here / Clear / Follow path during playback.
- [x] **Also allow drawing a box:** click-drag a rectangle (like redaction drawing) to set a keyframe at the current time. The keyframe is the smallest window at the path's aspect that contains the box. Investigators think "show this area", not "zoom 3.2× centered at…".
- [x] **K** (`App.tsx:79`) adds a zoom keyframe when the view is Raw and a PTZ keyframe when it's PTZ. In other modes it does nothing.
- [x] Scope: single view only. In the synced grid, paths are neither shown nor recorded (that's for later, with grid export).
- [x] While following a path, any manual pan/zoom pauses following until the next keyframe edit or a "Resume path" click, so the user isn't fighting the playback.
- [x] Timeline lane: reuse `TrackLane` ("Zoom path", blue). Clicking a diamond seeks to it. Dragging a diamond to retime it is a nice-to-have.
- [x] **Frame guide** (on by default while a zoom path exists): a dashed rectangle at the path's aspect over the raw view. It is exactly what gets recorded and exported, so what you frame is what you get. Recording samples the guide window, not the whole screen.

### Suggested order
1. Types, `evalZoom`/`simplifyZoomPath`, and the converters with tests.
2. Store migration and project load/save.
3. Follow during playback and the frame guide.
4. Keyframe/record UI, the lane, and box drawing.
5. ExportView, compose, and manifest.
6. `planDecode` cropping and the speed measurement.
7. The synthetic fixture and acceptance tests.
8. Update `USER_GUIDE.md`.

### Export
- [x] `ExportView` (`shared/ipc.ts:57`) adds `{ kind: 'zoom-path'; aspect: number; keyframes: Keyframe<ZoomWindow>[] }`.
  - In `drawExportView` (`gl/compose.ts:57`), evaluate `evalZoom` per frame and draw the window with the existing `normal` mode (`normalMapping` in `gl/renderer.ts`). No shader change.
  - Remember to offset by `srcRect` when the decode is cropped (see the decode plan below).
- [x] Export dialog: offer "Follow zoom path" when the zoom path has ≥2 keyframes. Output sizes are 720p/1080p/1440p/2160p **at the path's aspect** (both dimensions even).
  - **Warn** when the path zooms past native resolution, i.e. output height > `hPx` in any window: "Upscaled up to ×N, which adds no detail". Record `maxUpscale` in the manifest.
- [x] Manifest: add the operation `{ type: 'zoom_path', aspect, keyframes: [{ tSec, cxPx, cyPx, hPx }], interpolation: 'log-height, ease-in-out', maxUpscale }` to `OperationSchema` (`shared/manifest/schema.ts:17`) and to `exporter.ts` near line 58. Keep it distinct from the existing `digital_zoom`, which is a static view. Update `EXPORT_AND_MANIFEST.md`.
- [x] Decode plan (`planDecode`, `main/exporter.ts:162`): for zoom paths, decode only the **bounding box of every evaluated window** over the export range (sample at the output fps, pad by 2 px, keep dimensions even). Cap so the smallest window still gets ≥ output resolution.
  - Unlike the `crop` branch, this must also work **with redactions**: redaction boxes are in source space, so the compose step has to subtract `srcRect`. Add a test.
  - This is the big speed win on 5120×2560.

### Acceptance
- [ ] On "Parking 180", record a path that follows the person in the yard for 10 s.
  - Playback follows it smoothly.
  - Export at 1080p plays in Windows Media Player.
  - The first and last frames match the first and last keyframes' framing within 2 px (automated check with a synthetic moving-target fixture: generate a 4K clip with a moving numbered square and assert the square stays centered).
- [x] Redaction boxes stay correct inside zoom-path exports (boxes are in source space, so this should hold; add a test).
- [x] Saved projects restore zoom paths.

## 3. Still open from 1.0

- [ ] **Signed video from a real ACS recording.** None of Garrett's ACS recordings carry SEI, even after enabling signing on a camera.
  - When one arrives, add it to FINDINGS §7 and make sure `pubkey_validation` shows "attested" for an Axis key.
  - Consider showing the camera serial from the signature next to the camera name.
- [ ] **Fisheye lens model.** `Axis/LensProfile` (3 coefficients, e.g. `[0.0314, 0.0181, 0.3506]`) is still unexplained; dewarp uses an equidistant 180° model and looks right on Garrett's camera.
  - If the formula turns up, implement it as `model: 'axis-profile'` in `project.ts` and the shader, keeping the TS mirror in sync.
- [ ] **TiltOrientation:** `2 = ceiling` is **confirmed by Garrett**. The values for wall and desk are unknown; `mountFromAxis` guesses `0 = wall`, `1 = desk`. Keep the user override, and note in FINDINGS that only `2` is confirmed.
- [ ] **Multi-camera grid export** (PRD US8 stretch): export the synced grid as one video with per-tile labels and wall-clock time.
- [ ] **Code signing** (removes the SmartScreen warning). Needs a certificate; leave the hook in `electron-builder.yml`.
- [ ] **Light theme:** `settings.theme` exists but isn't implemented. Either implement it or remove the setting.
- [ ] **App version / About:** Settings shows versions, but there's no proper About with license texts. Show the files from `resources/bin/LICENSES` in a dialog.
- [x] **Docs:** update `USER_GUIDE.md` for zoom paths, and keep `PLAN.md` / `FINDINGS.md` current. *(USER_GUIDE and EXPORT_AND_MANIFEST updated for zoom paths; no new ACS-file findings this round.)*

## 3b. Redaction that follows a moving subject (done 2026-10-20)

Garrett asked for redaction boxes that can be moved along with a subject while the video plays.

- [x] **Follow while playing** on the selected box in the Redact tab. It plays the video at ½× (or 1× / ¼×).
  - While it plays, a drag anywhere on the video steers the box. The box keeps its grab offset, so it doesn't jump.
  - The wheel resizes the box around its center instead of zooming the view.
  - Space, Stop, a seek, the end of the video, or switching recordings all finish it.
- [x] **How it works** (`Player.startRedactFollow` / `finishRedactFollow` in `player.ts`):
  - The live box is sampled at 15/s of media time and drawn in place of its track straight away (`boxesAt`), so the burn-in matches what you steer.
  - On stop, `simplifyBoxPath` (`shared/tracks.ts`) thins the samples, keeping every edge within max(2 px, 3% of the box's smaller side) of what was recorded.
  - Only the recorded stretch is replaced (`spliceKeyframes`). Playback speed is restored.
- [x] **Tests:**
  - Unit tests (`tests/unit/redact-follow.test.ts`): thinning keeps turns and resizes, glide error stays within tolerance, splicing.
  - e2e: the real mouse steers a box over the moving-square fixture at ½×, then a solid export is checked at 4 moments: 0.0% of the square exposed.
- [ ] **Open:**
  - Test by hand on real footage.
  - If paths feel too dense with a real mouse, consider a light smoothing pass before thinning, but keep the safety tolerance.
  - Watch the raw-view follow e2e check. On 2026-10-20 it failed once (the box was fully off the square at one sampled moment), then passed twice. It now prints each keyframe's distance from the square's true position, so a repeat shows whether it's test timing or a real gap.
  - Panorama / double panorama views still can't edit boxes. They need seam handling (a box can straddle the 360° wrap).
- [x] **Redaction in dewarped views (PTZ and Quad), 2026-10-20.**
  - Boxes stay stored in raw source px, so the shader, exports and manifest are unchanged.
  - `shared/dewarp/boxmap.ts` maps the interaction through the TS mirror:
    - `ptzToSource` / `sourceToPtz` convert points;
    - `screenRectToSourceBox` turns a drawn rectangle into the raw-frame bounding box of its outline and interior, so it errs toward covering more;
    - `sourceBoxOutline` gives the curved on-screen outline.
  - What works in `Viewport.tsx`: draw (**B**), select/move, scroll-resize the selected box, and Follow while playing. In Quad, each quarter maps through its own PTZ. The PTZ view follows its view path.
  - **Tests:** unit tests cover round trips, coverage and outlines. Two e2e checks treat the moving-square clip as a fisheye:
    - a box drawn on PTZ covers the subject in the raw frame;
    - following through PTZ leaves 0.0% of the subject exposed in the export.
  - **Known trade-off:** near the lens edge the stored axis-aligned box covers noticeably more than the drawn shape. In the e2e, a 200 px square drawn on PTZ became a 294×465 raw box. A tighter fit would need rotated or curved redaction shapes in the shader and manifest.

## 4. UI refresh (done 2026-10-20, version 1.1.0)

Garrett picked direction A ("Studio") from the design mockups: same dark palette and amber accent, softer and more modern.

- [x] Floating rounded panels (`.panel`, `.card` in `index.css`); tokens in `tailwind.config.cjs` (`ink-750`, `path.view`, `path.zoom`, radii `panel`/`card`). `ink-500` brightened to `#7d8794` for contrast.
- [x] Inline stroke icons in `src/renderer/src/ui/Icons.tsx` (no dependency, CSP-safe) replace the ⏪ ▶ ✕ ◆ glyphs.
- [x] Header: breadcrumb, Single/Synced switch, "Originals read-only" badge, icon buttons for shortcuts/settings.
- [x] Library: collapsible camera groups, filter box, clip tiles (placeholder, no real thumbnails yet).
- [x] Fisheye view modes moved onto the video (top right, `ViewOverlay` in `Viewport.tsx`); removed from the View tab. Zoom readout + Reset bottom right.
- [x] Transport: icon controls, combined In/Out control, labelled Snapshot / Export clip, timeline ruler and labelled lanes.
- [x] Inspector: icon tabs, sections as cards.
- [x] `USER_GUIDE.md` updated for the new labels (and its double-encoded characters repaired).
- [x] Build and smoke-test the 1.1.0 portable exe on Windows (`npm run lint && npm run test && npm run dist:win`). *(2026-10-20: lint, 79 unit and 31 e2e checks pass; fixed the transport row overflowing its panel below ~1500 px wide (Export clip past the edge, timestamp over the rewind button): the row now wraps, and Snapshot is icon-only under 1536 px.)*
- [x] Real clip thumbnails in the library (needs a cached frame grab per recording, written to the cache dir only).
  - *Done:* `thumbnail()` in `main/media.ts`, over IPC `media:thumbnail`. It grabs one 144 px JPEG frame (`thumbnailArgs`/`thumbnailTime` in `shared/ffmpeg/args.ts`, at 10% in, capped at 2 s), two at a time. The frame goes to `cache/thumb-*.jpg`, keyed by path + size + mtime, and is returned as a data URL. Tiles request it when first shown; the placeholder stays if the grab fails. e2e checks it shows, that files land only in the cache, and that originals are unchanged.
- [x] Bundle Inter (`@fontsource/inter`): it can't load from Google Fonts under the CSP, so Windows falls back to Segoe UI.
  - *Done:* `@fontsource-variable/inter` 5.3.0 is pinned and imported in `main.tsx` (Vite bundles the woff2 files, served from `self`). The Tailwind sans stack starts with `Inter Variable`. The OFL license ships as `resources/bin/LICENSES/Inter-OFL.txt`. Burned-in export overlays still use Segoe UI, so the look of exports doesn't change. JetBrains Mono (the mono stack) is not bundled; Cascadia Mono/Consolas are used on Windows.
- Note: some files were double-encoded (`Ã—`, `â‰ˆ`) by PowerShell edits and showed garbled text in the library. They were repaired on 2026-10-20. Edit repo text with UTF-8-aware tools only.

## Notes for whoever picks this up

- Integrity rules in `CLAUDE.md` are non-negotiable, especially:
  - Never write next to sources.
  - Exports go to `.partial.mp4`, then rename.
  - Manifest last.
  - Never claim verification that wasn't done.
- The shader (`gl/shaders.ts`) and its TS mirror (`shared/dewarp/project.ts`) must stay in sync. Zoom paths use the `normal` mode only, so they shouldn't touch either.
- `window.__axhibitStore`, `__axhibitPlayer` and `__axhibitStartGrid` are test hooks exposed in `main.tsx`. Keep them; the e2e tests depend on them.
- WebGL needs `ignore-gpu-blocklist` + `enable-unsafe-swiftshader` (set in `main/index.ts`) for VMs and RDP sessions. Don't remove them.
- Exported clips use the BtbN LGPL FFmpeg (no libx264). On Garrett's machine the encoder chosen was `h264_nvenc`; `h264_mf` failed a smoke test under Wine but is untested on real Windows. Verify encoder fallback order on a machine without NVIDIA.
