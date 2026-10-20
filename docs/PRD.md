# PRD — Axhibit A (1.0)

## Problem
ACS Pro exports include AXIS File Player, which is no longer developed. It:
- Cannot dewarp fisheye footage (the ACS Pro client can), so exported fisheye video is hard to interpret.
- Cannot cut, crop, or redact a portion of an export to share (detective, school admin, insurer) without third-party editors that discard provenance.
- Plays one camera at a time, so following a person across cameras is tedious.

## Users
- **Primary:** integrators, technical support, and end-user security staff who receive an ACS Pro export folder and must review it and pull out relevant clips.
- **Secondary:** recipients (law enforcement, legal, admins) who need a clip that plays anywhere and an explanation of how it was derived.

## Goals (1.0)
1. Open an ACS Pro export folder or individual files (ASF, MKV, MP4; H.264/H.265) and play them smoothly.
2. Show wall-clock (camera) time during playback when available.
3. Dewarp fisheye footage live: virtual PTZ, panorama, double panorama, quad.
4. **Synchronized multi-camera playback** on a shared wall-clock timeline.
5. **Redaction:** keyframed boxes (blur / pixelate / solid) that follow subjects over time.
6. **Animated PTZ export:** record pan/tilt/zoom keyframes and export the moving view.
7. **Signed video verification** (Axis signed video) with a per-file and per-segment result.
8. Export a clip: trimmed, optionally cropped / dewarped / animated / redacted, as H.264 MP4 that plays anywhere. Export PNG snapshots.
9. A provenance manifest for every output.
10. Ship as a single portable Windows .exe (no install, no admin rights).

## Non-goals (1.0)
- Verifying the proprietary ACS export **digital signature** (keep pointing users to AXIS File Player for that)
- Automatic object tracking for redaction (manual keyframes with interpolation only)
- macOS/Linux builds, auto-update, code signing (SmartScreen warning is expected; documented)
- Live streams, connecting to ACS servers or cameras
- Editing originals in any way

## User stories & acceptance criteria
**US1 — Open an export.** Drag an export folder onto the window; recordings are listed with camera name, start time, duration, resolution, codec.
- AC: All ASF/MKV/MP4 files (recursive, depth ≤ 3) listed; unsupported ignored; corrupt files get an error badge, not a crash.

**US2 — Play.** A 10-min 1080p H.264 file starts within 3 s.
- AC: play/pause, scrub, speed 0.25×–8×, frame step ±1, ±10 s, keyboard shortcuts. H.265 plays natively with GPU support, otherwise via a proxy with progress.
- AC: Timeline shows wall-clock time if derivable; otherwise relative time with a "Camera time unavailable" hint.

**US3 — Dewarp.** Toggle Fisheye, pick a view; drag to pan/tilt, scroll to zoom.
- AC: Image circle auto-detected; adjustable with an overlay; mount type selectable; calibration remembered per camera.
- AC: Smooth (≥ 30 fps, target 60) rendering of a ~9 MP fisheye on an integrated GPU.

**US4 — Synced multi-camera.** Select 2–4 recordings → grid view; one transport drives all, aligned by wall-clock.
- AC: Drift between tiles ≤ 1 frame at 1× after 10 min; gaps (camera not recording) show "No video" with the time.
- AC: Each tile keeps its own view (normal/dewarp). Double-click a tile to focus it.
- AC: Falls back to manual offset alignment when wall-clock is unavailable.

**US5 — Redact.** Add a redaction box, choose style, move/resize it at different times; it interpolates between keyframes.
- AC: Redaction shows live in preview and is burned into exports identically (same renderer).
- AC: Redaction boxes are defined in source-pixel space so they stay correct in any view (incl. dewarp).
- AC: Manifest lists each redaction track with its keyframes.

**US6 — Animated PTZ.** Press "Record view path", pan/tilt/zoom while playing (or add keyframes while paused); export follows the path.
- AC: Keyframes editable on a track under the timeline; smooth interpolation (ease in-out).

**US7 — Verify signed video.** Open a recording → "Verify" → result: Verified / Partially verified (with time ranges) / Not signed / Failed (tampered ranges) / Unsupported.
- AC: Result, public key fingerprint, and per-GOP summary shown and saved into any later manifest from that source.
- AC: Never displays "Verified" unless the validator returned authentic for every GOP in range.

**US8 — Export a clip.** Set in/out, click Export, choose view (Original / Crop / Current view / Animated view path), trim mode (Fast keyframe / Exact), overlays, redaction on/off, output folder, notes.
- AC: H.264 yuv420p MP4 with faststart; plays in Windows Media Player, VLC, Chrome, iOS, Android.
- AC: Manifest beside it; cancellable; partials deleted on cancel/failure.
- AC: Exported frames match the preview (same renderer).
- AC: Multi-camera grid export: optional, exports the grid as one video (stretch; may land in 1.1).

**US9 — Snapshot.** Press S → PNG of the current view (with redaction) + manifest.

**US10 — Integrity notice.** One-time notice before first export: derived clips aren't the original; originals unchanged; keep the original export.

## UX outline
- Left sidebar: recordings grouped by camera; checkboxes for multi-cam.
- Center: single viewport or grid.
- Bottom: transport + timeline (in/out, keyframe ticks, redaction & view-path tracks, signed-video status strip).
- Right panel: View, Calibration, Redaction, Verify, Export.
- Dark theme default.

## Keyboard shortcuts
Space play/pause · ←/→ frame step · Shift+←/→ ±10 s · I/O in/out · J/K/L shuttle · F fisheye · 1–4 view modes · G grid · B add redaction box · P record view path · K add keyframe (when track selected) · S snapshot · E export · R reset view · ? shortcuts

## Open questions (resolve in M0 from samples)
1. Wall-clock start time: present? where?
2. Fisheye lens/circle metadata after export?
3. Folder structure and sidecars (camera names, comments, bookmarks)?
4. GOP/keyframe interval?
5. Audio tracks / codec?
6. Does signed-video SEI survive export in each container?
