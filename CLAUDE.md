# CLAUDE.md — Axhibit A

A lightweight, portable Windows desktop player for video exported from **AXIS Camera Station Pro (ACS Pro)**. It improves on the bundled AXIS File Player with **fisheye dewarping**, **synced multi-camera playback**, **redaction**, **signed-video verification**, and **evidence-safe clip export** (trim, crop, dewarped or animated PTZ view) with a **provenance manifest**.

> Product name: **Axhibit A** (package/id: `axhibit`). Keep it in ONE place (`src/shared/constants.ts` → `APP_NAME`) plus `package.json` / `electron-builder.yml`. The name is an unofficial pun: never use the AXIS wordmark, Axis logo, or "AXIS ___" product naming in the UI, icon, or docs aimed at users. Versions may be nicknamed by letter (A = 1.x).

## Start here
**Current work queue: `docs/HANDOFF.md`** (1.0 is built and tested on Windows; HANDOFF lists what's left, including the new zoom-path feature). Then read:
1. `docs/PRD.md` — what v1 is and is not
2. `docs/ARCHITECTURE.md` — stack, process model, modules, IPC
3. `docs/DEWARP.md` — fisheye math, view modes, calibration
4. `docs/EXPORT_AND_MANIFEST.md` — FFmpeg pipelines and manifest schema
5. `docs/PLAN.md` — milestones, tasks, acceptance criteria

Milestones M0–M7 in `docs/PLAN.md` are done; new work is tracked in `docs/HANDOFF.md`. Do not start a milestone until the previous one's acceptance criteria pass. Real ACS exports are never committed: keep them in a local folder (read-only evidence; see `docs/FINDINGS.md`), point tests at it with `AXHIBIT_SAMPLES`, and name the files to use in `tests/e2e/samples.local.json` (git-ignored; see `samples.example.json`). Never commit camera footage, camera names, serials or locations: this repo is public.

## Stack
- Electron (latest stable) + electron-vite
- Renderer: React 18 + TypeScript (strict) + Tailwind CSS + Zustand
- Video: HTML `<video>` as decode source → WebGL2 canvas for display/dewarp
- Export: **render pipeline** — FFmpeg decode → raw frames → the same WebGL renderer (offscreen) → FFmpeg encode. One shader for screen and export (WYSIWYG). Stream-copy only for untouched fast trims.
- Signed video: Axis `signed-video-framework` (C) cross-compiled with mingw-w64 into a small CLI (`sv-validate.exe`) bundled in `resources/bin`
- Media tooling: bundled **LGPL** FFmpeg/ffprobe binaries (see ARCHITECTURE.md → Binaries). Never use `ffmpeg-static` (GPL build).
- Persistence: `electron-store`
- Tests: Vitest (unit), Playwright for Electron (smoke)
- Packaging: electron-builder, Windows x64 `portable` target first

## Commands (set these up in M0)
```
npm run dev          # electron-vite dev
npm run build        # production build
npm run test         # vitest
npm run test:e2e     # playwright electron smoke tests
npm run lint         # eslint + tsc --noEmit
npm run fetch:ffmpeg # download pinned LGPL ffmpeg/ffprobe into resources/bin
npm run dist:win     # portable .exe
```

## Non-negotiable rules (evidence integrity)
1. **Source files are read-only.** Never write, rename, move, touch, or re-mux in place. Open with read-only flags. All intermediates go to the app cache dir (`app.getPath('userData')/cache`), never next to the source.
2. **Never overwrite outputs.** On filename collision, append ` (2)`, ` (3)`…
3. **Every exported clip/snapshot gets a manifest** (`<output>.manifest.json`) per `docs/EXPORT_AND_MANIFEST.md`. No manifest → export is considered failed; delete the partial output.
4. **Hash before and after.** SHA-256 of each source (streamed, cached by path+size+mtime) and of each output.
5. **Do not claim verification we did not do.** Axhibit A verifies Axis **signed video** (M6) and reports the exact result per GOP. It does **not** verify the proprietary ACS export **digital signature**; the manifest must say so explicitly.
6. **Log exact FFmpeg args** into the manifest. Build args as arrays; never shell-concatenate strings; never pass user strings to a shell.
7. **Security:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for renderer; a typed preload API is the only bridge. CSP locked to `self`. No remote content.

## Code conventions
- Pure logic (dewarp math, circle fit, FFmpeg arg builders, manifest builder, time math) lives in `src/shared/` as framework-free TS with unit tests. UI and Electron code call into it.
- The GLSL dewarp shader has a **TypeScript mirror** (`src/shared/dewarp/project.ts`) used for tests and hit-testing. Keep them in sync; tests compare them.
- IPC channels are declared once in `src/shared/ipc.ts` with request/response types.
- Long jobs (remux, proxy, export, hashing) are cancellable and report progress over IPC.
- Prefer small PR-sized commits per task in `docs/PLAN.md`; update the checkbox when done.
- When you learn something about ACS export files, record it in `docs/FINDINGS.md` — don't leave it only in code comments.

## Definition of done (every task)
- `npm run lint` and `npm run test` pass
- New pure logic has unit tests
- No new source-file writes (grep for `fs.write`, `rename`, `unlink` touching source paths)
- PLAN.md checkbox updated
