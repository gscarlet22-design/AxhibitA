# Axhibit A — User guide

Axhibit A plays video exported from AXIS Camera Station Pro, dewarps fisheye cameras, plays several cameras in sync, and exports clips you can send to anyone, each with a manifest that records exactly how the clip was made. It never changes the original files.

*Axhibit A is not an Axis product.*

## Getting started
1. Run **AxhibitA-1.0.1-portable.exe**. Nothing is installed; no admin rights are needed.
   - Windows may show "Windows protected your PC" because the app isn't code-signed yet. Click **More info → Run anyway**.
   - The single exe unpacks itself to a temporary folder on every start, which takes a few seconds. For instant starts, use **AxhibitA-1.0.1-win-x64.zip** instead: extract it anywhere (e.g. a USB stick) and run **Axhibit A.exe** inside.
   - You can also drag a folder onto the exe, or use **Open with → Axhibit A** on a recording. If Axhibit is already open, the files open in that window.
2. Drag an export folder (or individual `.asf`, `.mkv`, `.mp4` files) onto the window, or click **Open export** (top of the left list).
3. Pick a recording in the left list. Recordings are grouped by camera.

The first time you open a recording, Axhibit makes a playable copy in its own cache. This is usually seconds. H.265 on computers without H.265 support takes longer (a progress bar shows). The original is only read.

## Playing
- **Space** play/pause, **← / →** step one frame, **Shift + ← / →** jump 10 s, **J / L** slower/faster.
- The time shown is the camera's recorded time. A **≈** means the time comes from the file name (MP4 exports carry no timestamps) and may be off by a second or two. Export as **ASF or MKV** from ACS when exact times matter.
- Scroll to zoom and drag to pan (digital zoom). **R** resets.

## Fisheye cameras
Fisheye cameras are detected automatically from ASF/MKV metadata. For MP4, turn on **Fisheye** in the View tab (or press **F**).
- **Raw · PTZ · Panorama · Double · Quad** (keys **1–5**). These buttons float at the top right of the video once fisheye is on.
- PTZ: drag to look around, scroll to zoom, double-click to center on a point.
- Panorama: drag sideways to rotate.
- Quad: each quarter is its own view; drag and scroll inside it.
- **Lens**: set the mount (ceiling / wall / desk). If lines look bent, click **Calibrate** and drag the dashed circle onto the edge of the image circle, or press **Auto-detect circle**. Settings are remembered per camera.

### Animated PTZ (view path)
In PTZ view, click **● Record path**, then play and steer the view; click **■ Stop**. Or pause at moments and press **K** to add keyframes. With **Follow path** on, playback replays the movement, and exports can follow it.

## Zoom paths: follow someone across a large picture
For any camera (180° panoramics, 4K multi-sensor heads, fixed lenses, or a fisheye in Raw view), you can record a moving zoom so the clip you send shows the subject large instead of a tiny figure in a 5K frame.

1. Open the **View** tab and pick the frame shape under **Zoom path** (16:9 suits most players). A dashed blue **export frame** appears: what's inside it is exactly what the exported clip shows.
2. Either:
   - click **● Record path**, then while it plays, scroll to zoom and drag to keep the person inside the frame; click **■ Stop**; or
   - pause at moments that matter and press **K** to keyframe the current framing; or
   - press **Z** (**▭ Draw frame**) and drag a box around the area to show: the frame snaps to the smallest frame that contains it.
3. Play it back: with **Follow path** on, the view glides between keyframes. If you scroll or drag during playback, following pauses so you're not fighting it. Click **Resume path** to continue. Diamonds on the timeline mark keyframes; click one to jump to it.
4. **Export clip…** → **Follow zoom path**, and pick a size. If the path zooms in further than the camera recorded, the dialog warns how much it's enlarged: enlarging adds no detail.

The manifest records every keyframe (in source pixels) and how frames were interpolated. Redaction boxes stay in place inside zoom-path exports. **Save project…** keeps zoom paths.

## Synced multi-camera playback
Tick **Sync** next to 2–4 cameras in the left list, then click **Play N cameras in sync** (or **Synced** in the top bar). One timeline drives all cameras by recorded time; gaps show "No recording at this time". If a camera looks out of step (common with MP4 exports), nudge it with its slider in the right panel. Double-click a camera to open it on its own at that moment.

## Redaction

Open the **Redact** tab, click **+ Draw box** (or **B**) and drag over the face or plate. You can draw in the Raw view, or on a fisheye's PTZ or Quad view. In a dewarped view, the box's outline is curved because it shows exactly what gets covered, which can be a bit more than you drew. There, scroll over the selected box to resize it. You can also move to another time and drag or resize the box; each change adds a keyframe (◆) and the box glides between them. Choose **Pixelate**, **Blur** or **Solid** (most secure). Boxes show in every view and are burned into exports. **Save project…** keeps your boxes and paths for later.

**Following someone who moves:** draw a box over them, keep it selected, and click **● Follow while playing**. The video plays (at ½ speed by default; pick 1× or ¼× next to the button). Drag anywhere on the video to keep the box on the person, and scroll to make the box bigger or smaller. Press **Space** or **■ Stop following** to finish. The movement is saved as keyframes, staying within a few pixels of how you steered, and you can fine-tune any moment afterwards. Make the box a little larger than the person, so quick movements stay covered. Recording over a stretch you've already done replaces just that stretch.

**When a box applies:** a box starts at the moment you draw it and stays until the end of the recording. To change that, select it and use **Shows**: *From its first keyframe on* (the default), *Only between first and last keyframe*, or *For the whole recording*. The timeline line for each box shows where it applies. Boxes from projects saved with 1.0 keep covering the whole recording.

**Hide everything except the boxes:** under **Hide**, choose **Everything else**. The boxes then become the only part of the picture left visible, and the rest is blurred, pixelated or blacked out (your choice). Use as many boxes as you need, for example one per person of interest. The outlines turn green in this mode. With no boxes, the whole picture is hidden. The manifest records which mode was used.

## Verifying camera signatures (signed video)
If the camera has signed video enabled, open the **Verify** tab and click **Verify signatures**.
- **Verified**: every part of the video carries a valid camera signature.
- **Failed**: the listed time ranges don't match their signatures (altered, removed or reordered frames). Click a range to jump there.
- **Not signed**: the recording has no signatures.

The separate ACS export signature is checked with the AXIS File Player that ACS puts in the export folder (Tools → Verify digital signature).

## Exporting a clip
1. Set **In** (**I**) and **Out** (**O**) on the timeline, or export the whole recording.
2. Click **Export clip…** (**E**) and choose:
   - **Picture**: Original frame, Current view (your zoom or dewarped view), Follow view path (fisheye PTZ), or Follow zoom path.
   - **Trim**: Exact (frame-accurate; needed for overlays, redaction, zoom or dewarp) or Fast (untouched video copied as-is, which starts at the nearest earlier keyframe, up to ~4 s early).
   - **Burn in**: date & time, camera name, redactions, extra text such as a case number.
3. Pick a folder and click **Export**.

You get `name.mp4` (plays on any PC or phone) and `name.mp4.manifest.json`. **Send both.** The manifest lists the original file and its SHA-256 hash, the camera, times, every processing step with exact settings, the FFmpeg commands used, the hash of the new clip, and any signed-video result. Existing files are never overwritten.

**S** saves a PNG snapshot of the current view (with redactions) plus a manifest.

## Good practice for evidence
- Keep the original ACS export folder unchanged; Axhibit's clips are copies derived from it.
- Put your name in **Settings** so it's recorded in manifests.
- Prefer ASF/MKV exports from ACS: they carry exact timestamps, camera IDs and lens data.
