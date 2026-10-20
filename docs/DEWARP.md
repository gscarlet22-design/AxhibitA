# Dewarp spec — Axhibit A

## Coordinate conventions (use everywhere)
- Source texture UV: `(0,0)` top-left, `(1,1)` bottom-right. Pixel coords `(px, py)` likewise.
- Calibration stored in **normalized pixel units of the source frame**: `cx = px/width`, `cy = py/height`, `r = radiusPx/width`. (Convert carefully when width ≠ height.)
- Camera space: right-handed; **+Z = lens optical axis (out of lens)**, +X = image right, +Y = image down.
- Angles in radians internally, degrees in UI and storage.

## Lens model
Default **equidistant**: `ρ = (θ / (fov/2)) · R`, where θ = angle between ray and optical axis, `fov` = lens field of view (default 180°, allow 160–200°), `R` = image-circle radius in pixels, ρ = radial distance from circle center.

Allow `model: 'equidistant' | 'equisolid'` in params (equisolid: `ρ = R · sin(θ/2) / sin(fov/4)`). Default equidistant; FINDINGS.md may change this per camera family if visual straightness is better.

Sampling a ray `d` (unit vector, camera space):
```
θ = acos(clamp(d.z, -1, 1))
φ = atan2(d.y, d.x)
ρ = project(θ)                    // model above, in pixels
px = cxPx + ρ·cos(φ);  py = cyPx + ρ·sin(φ)
if θ > fov/2 → output black (outside lens)
```

## Mount orientation
Mount defines how the world is rotated relative to the lens:
- **ceiling**: lens looks down. World "horizon" is at θ = 90°. Nadir = optical axis.
- **desk**: lens looks up (same math as ceiling, with image flip so panoramas are upright).
- **wall**: lens looks horizontally. Optical axis is the forward horizon direction.

Implement as a rotation matrix `M_mount` applied to world rays before sampling: `d_cam = M_mount · d_world`. World frame for views: +Z forward, +Y down, +X right, horizon is Y=0 plane.

## Views

### Normal
No dewarp; passthrough shader with digital zoom/pan.

### PTZ (virtual camera)
State: `pan` (yaw, unbounded), `tilt` (pitch), `hfov` (zoom, 20°–120°).
- Ceiling/desk: tilt ∈ [0°, 90°] where 90° = looking straight down at nadir… expose as UI tilt from horizon (0°) to straight down (90°).
- Wall: pan ∈ [−fov/2, fov/2], tilt ∈ [−60°, 60°].
For output pixel NDC `(u,v) ∈ [-1,1]²`, aspect `a = W/H`:
```
t = tan(hfov/2)
d_view = normalize(u·t, v·t/a, 1)      // hfov is horizontal; vertical FOV follows aspect
d_world = R_yaw(pan) · R_pitch(tilt) · d_view
d_cam = M_mount · d_world
```
Interaction: drag = pan/tilt proportional to current hfov; wheel = hfov ×/÷ 1.1; double-click = center view on clicked point (use the TS mirror to invert).

### Panorama
- Ceiling/desk: 360° cylindrical. Output x ∈ [0,1) → azimuth φ_w ∈ [panOffset, panOffset+2π). Output y ∈ [0,1] → elevation from `topDeg` (default 0°, horizon) to `bottomDeg` (default 70° below horizon). Build `d_world` from (azimuth, elevation), then `M_mount`.
- Wall: 180° panorama: azimuth ∈ [−fov/2, fov/2], elevation ∈ [−45°, 45°].
- Drag horizontally shifts `panOffset`.

### Double panorama (ceiling/desk only)
Two 180° panoramas stacked: top = azimuth [panOffset, panOffset+π), bottom = [panOffset+π, panOffset+2π). Wall: disabled (greyed).

### Quad
Four PTZ sub-viewports in a 2×2 grid at pan 0/90/180/270°, shared tilt (default 45°) and hfov (default 75°). Each quadrant individually draggable. Ceiling/desk only; wall uses pan −45/−15/15/45.

## Shader
One fragment shader with `uniform int uMode` (0 PTZ, 1 pano, 2 dual pano), plus quad implemented as four viewport draws of PTZ. Uniforms: `uCenter (px)`, `uRadius (px)`, `uSrcSize`, `uFov`, `uModel`, `uMount (mat3)`, `uYaw`, `uPitch`, `uHfov`, `uPanOffset`, `uElevRange`, `uOutSize`.
- Use `texture()` with LINEAR filtering; enable mipmaps only if source is power-of-two-agnostic in WebGL2 (it is) and zoomed out heavily.
- Anti-alias edge of the image circle with a 1-px smoothstep.

## TypeScript mirror
`src/shared/dewarp/project.ts` exports:
- `viewToSource(view: ViewState, calib: Calibration, u, v): {px, py} | null`
- `sourceToView(...)` for overlays/hit-testing (numeric inverse is fine).
Unit tests: for random view states, sample a grid, render one frame in a headless WebGL context (or compare against shader-equivalent JS evaluated over a test texture) — max error ≤ 0.5 px.

## Image-circle auto-detect
Input: current frame drawn to an offscreen canvas at ≤ 1024 px on the long side.
1. Luma = 0.299R + 0.587G + 0.114B; 5×5 box blur.
2. Threshold T = max(24, 0.15 × median luma of center 20% region).
3. For 180 evenly spaced angles, march from frame center outward; record the last pixel above T before 8 consecutive below-T pixels → edge point. Discard points that hit the frame border (circle clipped by sensor).
4. Fit circle with algebraic (Kåsa) least squares inside RANSAC (200 iters, inlier ≤ 1.5% of long side). Require ≥ 40 inliers.
5. Confidence = inliers/total. If < 0.6 or fit fails → fall back to `center = frame center, r = min(w,h)/2` and show "Adjust circle" hint.
6. Scale back to full resolution; store normalized.
Run on toggle and via "Auto-detect" button; never automatically overwrite a saved manual calibration.

## Calibration UI
- Overlay draws circle + center handle + radius handle on the raw (Normal) view.
- Fields: center X/Y (px), radius (px), FOV (°), model, mount. Reset / Auto-detect / Save.
- Saved per camera key (ARCHITECTURE.md → Persistence).

## Export parity
Exports use the **same shader** via the render pipeline (EXPORT_AND_MANIFEST.md → Pipeline B), so there is no second dewarp implementation to keep in sync. The parity test in M3 compares an offscreen render of a frame with the preview render of the same frame (≤ 2/255 mean diff before encoding).

## Synthetic fixtures
`scripts/make-fixtures.mjs` generates fisheye test footage from a labeled equirect pattern with FFmpeg `v360=input=equirect:output=fisheye:h_fov=180:v_fov=180` (centered 1440×1440, off-center padded to 1920×1440, and a clipped variant). These are used to test auto-detect and to sanity-check that straight lines come out straight.
