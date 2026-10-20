# Findings — ACS Pro export files

Source: 8 exports from Garrett's ACS Pro (2026-10-19), copied to `samples/`. Probe output: `tests/fixtures/probe/*.json`.

## 1. Folder structure & sidecar files
- One folder per export, named `Export_<YYYY-MM-DD_HH_MM_SS_mmm>` or a user-given name (`P3738_<timestamp>`).
- Contents: `AxisFilePlayer.exe` (~64 MB), `AXIS Camera Station Pro Playlist <date>.asx` (ASX 3.0 XML, UTF-8 BOM, one `<ENTRY>` per recording with `<TITLE>` and `<REF HREF>`), and the recordings.
- The ASX carries **only file names**, no times or camera metadata. Useful only for ordering.
- Recording file name: `<Camera Name> <YYYY-MM-DD_HH_MM_SS_mmm>.<ext>`, time = **local time of the exporting machine, with milliseconds** (e.g. `10_34_35_604` ↔ ASF StartTime `15:34:33.15Z` minus 5 h, rounded differently by ~2 s — see §2).
- A camera with several recordings in the range produces several files (e.g. 5 × `P3738_Loading Dock …`). These are **segments of one camera with gaps** between them.

## 2. Wall-clock start time
| Container | Source | Precision |
|---|---|---|
| ASF | `Axis/StartTime`, `Axis/StopTime` (UTC ISO, 100 ns) | exact |
| MKV | `_AXIS_START_TIME`, `_AXIS_STOP_TIME`, also `creation_time` | exact |
| MP4 | **no tags** (brand `isomiso5dash`) → file name only (local, ms) | ±2 s observed vs ASF |
- Priority: Axis start tag → creation_time → file name (local).
- The file name and the Axis StartTime of the same recording differed by ~2.4 s on one sample (file name 10:34:35.604 local vs StartTime 10:34:33.154). The file-name time appears to be the requested export start, not the first frame. Flag file-name-derived times as approximate in UI and manifest.

## 3. Camera name
- ASF `Axis/CameraName`, MKV `_AXIS_CAMERA_NAME`; MP4 → file-name prefix before the timestamp.
- Camera identity: ASF `Axis/CameraId`, MKV `_AXIS_CAMERA_ID` (e.g. `28753-00408CXXXXXX` = product id + MAC/serial). Use as calibration key when present.

## 4. Fisheye lens metadata
- ASF `Axis/IsFisheye=1`, `Axis/LensProfile=[0.0314, 0.0181, 0.3506]`, `Axis/TiltOrientation=2`; MKV same under `_AXIS_*`. **MP4 carries none.**
- `TiltOrientation=2` = **ceiling (confirmed by Garrett, 2026-10-19)**. Values for wall/desk unknown; code guesses 0 = wall, 1 = desk.
- `LensProfile` meaning is **unknown** (3 coefficients; not a simple θ polynomial normalized by width or half-width). Stored raw in MediaInfo and manifest. **Question for Axis:** what model/normalization does LensProfile use? If known, use it instead of the equidistant default.
- The image circle nearly fills the 2880×2880 frame (radius ≈ 0.49 × width); auto-detect handles it.
- Fisheye frames have ACS analytics boxes (red rectangles) burned in at export.

## 5. GOP / keyframe intervals
- 15 fps cameras: keyframe every 32 frames (≈ 2.13 s) on P3738; ≈ 4.13 s on the fisheye (ASF). Fast trim can be off by up to ~4 s → default trim mode should be **Exact**.
- ASF packets have no pts (`N/A`); use `dts_time`. Build keyframe index from `-show_entries packet=pts_time,dts_time,flags`.

## 6. Audio
- AAC-LC, 48 kHz mono where present (fisheye HEVC MP4, fisheye MKV/ASF).

## 7. Signed video
- No SEI NAL units at all in any sample (H.264 tested in ASF and MP4). These cameras don't have signed video enabled. **Need a sample from a camera with signed video on** to test M6.

## 8. Other observations
- Codecs: H.264 High and HEVC Main, `yuvj420p` (full range), BT.709.
- Variable frame rate everywhere (`avg_frame_rate` ≠ `r_frame_rate`), e.g. 15.02 fps; HEVC sample reports r=16. Render pipeline must normalize to CFR.
- Resolutions: 2880×2880 (fisheye), 5120×2560 (stitched 180° panoramic — not a fisheye; Normal view), 3840×2160 (P3738 sensors).
- MKV: ffprobe warns "Unknown-sized element" — harmless.
- ASF start_time 0.006 on the HEVC sample (non-zero start) — handle `start_time` offsets.
