// Feature e2e: signed-video verify, redaction burn-in, view-path + PTZ export, dewarp modes, snapshot, grid sync, originals untouched.
// Needs a build (`npm run build`). Samples: AXHIBIT_SAMPLES (default ./samples), real ACS exports opened read-only and hashed before/after.
// Which sample files to use comes from tests/e2e/samples.local.json (not committed; copy samples.example.json).
// Signed-video fixtures come from AXHIBIT_SIGNED_FIXTURES (default tests/fixtures/media); those checks are skipped when absent.
import { _electron as electron } from 'playwright'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const OUT = resolve(process.env.OUT || 'test-output')
const exportDir = join(OUT, 'features')
rmSync(exportDir, { recursive: true, force: true })
mkdirSync(exportDir, { recursive: true })
const SAMPLES = resolve(process.env.AXHIBIT_SAMPLES || 'samples')
if (!existsSync(SAMPLES)) { console.error(`Samples folder not found: ${SAMPLES} (set AXHIBIT_SAMPLES)`); process.exit(2) }
const CFG_PATH = resolve(process.env.AXHIBIT_SAMPLES_CONFIG || 'tests/e2e/samples.local.json')
if (!existsSync(CFG_PATH)) { console.error(`Sample config not found: ${CFG_PATH}. Copy tests/e2e/samples.example.json to samples.local.json and fill in file names from your samples folder.`); process.exit(2) }
const CFG = JSON.parse(readFileSync(CFG_PATH, 'utf8'))
// scratch folder inside the samples tree; excluded from the untouched check
const SCRATCH_NAME = CFG.scratchFolder ?? '_Axhibit build'
// signed fixtures are copied to a scratch dir so the samples tree is never written
const signedDir = join(OUT, 'signed')
rmSync(signedDir, { recursive: true, force: true })
mkdirSync(signedDir, { recursive: true })
const SIGNED_SRC = resolve(process.env.AXHIBIT_SIGNED_FIXTURES || 'tests/fixtures/media')
const SIGNED = 'signed.mkv'
const TAMPERED = 'tampered.mkv'
const haveSigned = existsSync(join(SIGNED_SRC, SIGNED)) && existsSync(join(SIGNED_SRC, TAMPERED))
if (haveSigned) for (const f of [SIGNED, TAMPERED]) copyFileSync(join(SIGNED_SRC, f), join(signedDir, f))
const FFMPEG = process.env.FFMPEG || (process.platform === 'win32' ? resolve('resources/bin/ffmpeg.exe') : 'ffmpeg')
// synthetic zoom-path fixture: 4K gray frame, a 200 px red square moving from (400,800) to (2200,1400) over 3 s, then still
const MOVER = 'moving-square-4k.mkv'
execFileSync(FFMPEG, [
  '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x808080:s=3840x2160:r=15:d=5', '-f', 'lavfi', '-i', 'color=c=red:s=200x200:r=15:d=5',
  '-filter_complex', "[0][1]overlay=x='400+600*min(t\\,3)':y='800+200*min(t\\,3)':eval=frame,format=yuv420p",
  '-c:v', 'mpeg4', '-q:v', '2', '-g', '15', join(signedDir, MOVER)
])
const squareCenter = (t) => ({ x: 500 + 600 * Math.min(t, 3), y: 900 + 200 * Math.min(t, 3) })
const results = []
const check = (name, ok, info = '') => { results.push([ok ? 'PASS' : 'FAIL', name, info]); console.log(ok ? 'PASS' : 'FAIL', name, info) }
const skip = (name, why) => { results.push(['SKIP', name, why]); console.log('SKIP', name, why) }

function hashTree(dir) {
  const out = {}
  const walk = (d) => { for (const f of readdirSync(d)) { if (f === SCRATCH_NAME) continue; const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else out[p] = createHash('sha256').update(readFileSync(p)).digest('hex') + ':' + s.mtimeMs } }
  walk(dir)
  return out
}
const before = hashTree(SAMPLES)

const userData = join(OUT, 'userdata')
rmSync(userData, { recursive: true, force: true })
const app = await electron.launch({ args: ['.', SAMPLES, signedDir], env: { ...process.env, AXHIBIT_USER_DATA: userData } })
const win = await app.firstWindow()
const pageErrors = []
win.on('pageerror', (e) => { pageErrors.push(e.message); console.log('[pageerror]', e.message) })
await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
await win.waitForFunction((n) => window.__axhibitStore?.getState().recordings.length >= n, CFG.minRecordings ?? 10, { timeout: 90000 })

// library thumbnails (grabbed into the cache) and the bundled UI font
await win.waitForFunction(() => Object.values(window.__axhibitStore.getState().thumbs).filter(Boolean).length >= 5, null, { timeout: 60000 }).catch(() => undefined)
const thumbCount = await win.evaluate(() => document.querySelectorAll('aside[aria-label="Recordings"] img[src^="data:image/jpeg"]').length)
check('library shows video thumbnails', thumbCount >= 5, `${thumbCount} shown`)
const cacheThumbs = readdirSync(join(userData, 'cache')).filter((f) => f.startsWith('thumb-') && f.endsWith('.jpg')).length
check('thumbnails are cached in the app cache only', cacheThumbs >= thumbCount, `${cacheThumbs} in cache`)
const interLoaded = await win.evaluate(async () => { await document.fonts.ready; return document.fonts.check('13px "Inter Variable"') && [...document.fonts].some((f) => f.family.includes('Inter') && f.status === 'loaded') })
check('bundled Inter font is in use', interLoaded)

const recId = (name) => win.evaluate((n) => window.__axhibitStore.getState().recordings.find((r) => r.fileName === n)?.id, name)
const runJob = (fn, arg) => win.evaluate(async ({ fn, arg }) => {
  const jobId = await window.axhibit[fn](arg)
  return await new Promise((resolve) => { const off = window.axhibit.onJobEvent((e) => { if (e.jobId === jobId && e.kind !== 'progress') { off(); resolve(e) } }) })
}, { fn, arg })

// 1. signed video
const info = await win.evaluate(() => window.axhibit.appInfo())
check('validator available', info.signedVideoValidator)
if (haveSigned) {
  const signed = await runJob('verifySigned', await recId(SIGNED))
  check('signed clip verifies', signed.result?.status === 'verified', JSON.stringify(signed.result ?? signed.message).slice(0, 200))
  const tampered = await runJob('verifySigned', await recId(TAMPERED))
  const tr = tampered.result
  check('tampered clip fails with a time range', tr?.status === 'failed' && tr.invalidRanges.length === 1, JSON.stringify(tr?.invalidRanges))
} else {
  skip('signed / tampered clip verification', `no ${SIGNED} + ${TAMPERED} in ${SIGNED_SRC} (make them with scripts/make-signed-fixtures.sh)`)
}
const unsigned = await runJob('verifySigned', await recId(CFG.unsignedAsf))
check('unsigned ACS clip reports not signed', unsigned.result?.status === 'not_signed')

// 2. redaction burn-in (solid box in original frame of the 3840x2160 camera)
const yard = await recId(CFG.uhdMp4)
const box = { x: 1000, y: 600, w: 800, h: 500 }
const red = await runJob('exportClip', {
  recordingId: yard, inSec: 1, outSec: 2.5, trimMode: 'exact', view: { kind: 'original' }, outW: 1920, outH: 1080,
  redactions: [{ id: 'r', style: 'solid', enabled: true, keyframes: [{ tSec: 0, value: box }] }],
  overlay: { timestamp: true, cameraName: true, customText: null }, includeAudio: false, outputDir: exportDir, fileStem: 'redact', notes: null
})
check('redacted export finished', red.kind === 'done', red.message ?? '')
if (red.kind === 'done') {
  // sample the center of the box in the output (scaled by 0.5)
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-ss', '0.5', '-i', red.result.outputPath, '-frames:v', '1', '-vf', `crop=40:40:${(box.x + box.w / 2) / 2 - 20}:${(box.y + box.h / 2) / 2 - 20},format=gray`, '-f', 'rawvideo', '-'])
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length
  check('redaction box is solid in every exported pixel sampled', mean < 30, `mean luma ${mean.toFixed(1)}`)
  const m = JSON.parse(readFileSync(red.result.manifestPath, 'utf8'))
  check('manifest records redaction + hashes', m.operations.some((o) => o.type === 'redaction') && /^[0-9a-f]{64}$/.test(m.output.sha256))
  const actual = createHash('sha256').update(readFileSync(red.result.outputPath)).digest('hex')
  check('manifest output hash matches file', actual === m.output.sha256)
}

// 3. view-path export on the fisheye
const fish = await recId(CFG.fisheyeMkv)
const calib = { cxPx: 1441, cyPx: 1437, radiusPx: 1443, fovDeg: 180, model: 'equidistant', mount: 'ceiling' }
const vp = await runJob('exportClip', {
  recordingId: fish, inSec: 3, outSec: 4.5, trimMode: 'exact',
  view: { kind: 'view-path', calib, keyframes: [{ tSec: 3, value: { panDeg: 0, tiltDeg: 30, hfovDeg: 90 } }, { tSec: 4.5, value: { panDeg: 120, tiltDeg: 50, hfovDeg: 60 } }] },
  outW: 960, outH: 540, redactions: [], overlay: { timestamp: false, cameraName: false, customText: null }, includeAudio: true, outputDir: exportDir, fileStem: 'path', notes: null
})
check('view-path export finished', vp.kind === 'done', vp.message ?? '')
if (vp.kind === 'done') {
  const a = execFileSync(FFMPEG, ['-v', 'error', '-i', vp.result.outputPath, '-frames:v', '1', '-vf', 'scale=32:18,format=gray', '-f', 'rawvideo', '-'])
  const b = execFileSync(FFMPEG, ['-v', 'error', '-sseof', '-0.1', '-i', vp.result.outputPath, '-frames:v', '1', '-vf', 'scale=32:18,format=gray', '-f', 'rawvideo', '-'])
  let diff = 0
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i])
  check('view path moves the camera (first ≠ last frame)', diff / a.length > 10, `mean diff ${(diff / a.length).toFixed(1)}`)
}

// 3b. zoom-path export follows a moving subject on a large frame (any camera, no dewarp)
const mover = await recId(MOVER)
const c0 = squareCenter(0)
const c1 = squareCenter(3.5)
const zoomPath = { aspect: 16 / 9, keyframes: [{ tSec: 0, value: { cxPx: c0.x, cyPx: c0.y, hPx: 540 } }, { tSec: 3.5, value: { cxPx: c1.x, cyPx: c1.y, hPx: 540 } }] }
const zbox = { x: 700, y: 700, w: 100, h: 100 } // static solid redaction inside the first window
const zp = await runJob('exportClip', {
  recordingId: mover, inSec: 0, outSec: 4.5, trimMode: 'exact', view: { kind: 'zoom-path', path: zoomPath }, outW: 1280, outH: 720,
  redactions: [{ id: 'z', style: 'solid', enabled: true, keyframes: [{ tSec: 0, value: zbox }] }],
  overlay: { timestamp: false, cameraName: false, customText: null }, includeAudio: false, outputDir: exportDir, fileStem: 'zoompath', notes: null
})
check('zoom-path export finished', zp.kind === 'done', zp.message ?? '')
if (zp.kind === 'done') {
  const frameAt = (args) => execFileSync(FFMPEG, ['-v', 'error', ...args, '-i', zp.result.outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 })
  const centroid = (buf) => {
    let n = 0, sx = 0, sy = 0
    for (let i = 0; i < buf.length; i += 3) {
      if (buf[i] > 150 && buf[i + 1] < 90 && buf[i + 2] < 90) { const p = i / 3; sx += p % 1280; sy += Math.floor(p / 1280); n++ }
    }
    return n ? { x: sx / n, y: sy / n, n } : null
  }
  const first = frameAt([])
  const last = frameAt(['-sseof', '-0.1'])
  const a = centroid(first)
  const b = centroid(last)
  const off = (p) => (p ? Math.hypot(p.x - 640, p.y - 360) : Infinity)
  check('zoom path frames the subject on the first frame (≤2 px)', off(a) <= 2, JSON.stringify(a))
  check('zoom path frames the subject on the last frame (≤2 px)', off(b) <= 2, JSON.stringify(b))
  check('subject is shown enlarged (267 px square at 1.33×)', !!a && Math.abs(a.n - 267 * 267) / (267 * 267) < 0.06, String(a?.n))
  // redaction box center in output: (src - window origin) × 720/540
  const s = 720 / 540
  const rx = Math.round((zbox.x + zbox.w / 2 - (c0.x - 480)) * s)
  const ry = Math.round((zbox.y + zbox.h / 2 - (c0.y - 270)) * s)
  const px = first.subarray((ry * 1280 + rx) * 3, (ry * 1280 + rx) * 3 + 3)
  check('redaction stays on its source spot inside a zoom-path export', px[0] < 40 && px[1] < 40 && px[2] < 40, `rgb ${[...px]} at ${rx},${ry}`)
  const m = JSON.parse(readFileSync(zp.result.manifestPath, 'utf8'))
  const op = m.operations.find((o) => o.type === 'zoom_path')
  check('manifest records the zoom path and its upscale', !!op && op.keyframes.length === 2 && Math.abs(op.maxUpscale - 4 / 3) < 0.01, JSON.stringify(op ?? null).slice(0, 160))
}
// playback follows the path (raw view of a non-fisheye recording)
await win.evaluate((id) => window.__axhibitStore.setState({ selectedId: id, layout: 'single', rightTab: 'view' }), mover)
await win.waitForFunction((id) => window.__axhibitStore.getState().media[id]?.status === 'ready', mover, { timeout: 180000 })
await win.evaluate(({ id, path }) => window.__axhibitStore.getState().updatePer(id, (x) => ({ ...x, zoomPath: path, followZoom: true })), { id: mover, path: zoomPath })
await win.evaluate(() => window.__axhibitPlayer.seek(3.8))
await win.waitForTimeout(1200)
const guide = await win.evaluate((id) => window.__axhibitPlayer.guideWindow(window.__axhibitStore.getState().recordings.find((r) => r.id === id)), mover)
check('playback follows the zoom path', !!guide && Math.abs(guide.cxPx - c1.x) < 1 && Math.abs(guide.cyPx - c1.y) < 1 && Math.abs(guide.hPx - 540) < 1, JSON.stringify(guide))
await win.screenshot({ path: join(OUT, 'zoom-path-follow.png') })

// redaction that follows a moving subject: steer the box with the real mouse while playing at ½×
await win.evaluate((id) => {
  const st = window.__axhibitStore.getState()
  st.updatePer(id, (x) => ({ ...x, followZoom: false, zoomPath: null, view: { ...x.view, normal: { zoom: 1, centerX: 0.5, centerY: 0.5 } }, redactions: [{ id: 'follow', style: 'solid', enabled: true, keyframes: [{ tSec: 0, value: { x: 350, y: 750, w: 300, h: 300 } }] }] }))
  window.__axhibitStore.setState({ rightTab: 'redact', selectedTrack: 'follow' })
}, mover)
await win.evaluate(() => window.__axhibitPlayer.seek(0))
await win.waitForTimeout(800)
const canvas = await win.locator('canvas').first().boundingBox()
const toScreen = (sx, sy) => {
  const sc = Math.min(canvas.width / 3840, canvas.height / 2160)
  return { x: canvas.x + canvas.width / 2 + (sx - 1920) * sc, y: canvas.y + canvas.height / 2 + (sy - 1080) * sc }
}
await win.locator('button', { hasText: 'Follow while playing' }).click()
let p0 = toScreen(500, 900)
await win.mouse.move(p0.x, p0.y)
await win.mouse.down()
for (let i = 0; i < 200; i++) {
  const t = await win.evaluate(() => window.__axhibitPlayer.currentMediaTime())
  if (t >= 2.6) break
  const c = squareCenter(t)
  const p = toScreen(c.x, c.y)
  await win.mouse.move(p.x, p.y)
  await win.waitForTimeout(30)
}
await win.mouse.up()
await win.locator('button', { hasText: 'Stop following' }).click()
await win.waitForTimeout(300)
const followed = await win.evaluate((id) => window.__axhibitStore.getState().per[id].redactions.find((r) => r.id === 'follow').keyframes, mover)
const rate = await win.evaluate(() => window.__axhibitStore.getState().rate)
// how far each recorded keyframe's center is from where the square really was at that moment
const lag = followed.map((k) => { const c = squareCenter(k.tSec); return Math.round(Math.hypot(k.value.x + k.value.w / 2 - c.x, k.value.y + k.value.h / 2 - c.y)) })
check('following a subject records a thinned path', followed.length >= 2 && followed.length <= 30 && rate === 1, `${followed.length} keyframes, rate back to ${rate}; center error px ${JSON.stringify(lag)} at t ${JSON.stringify(followed.map((k) => +k.tSec.toFixed(2)))}`)
const fx = await runJob('exportClip', {
  recordingId: mover, inSec: 0.4, outSec: 2.4, trimMode: 'exact', view: { kind: 'original' }, outW: 1920, outH: 1080,
  redactions: [{ id: 'follow', style: 'solid', enabled: true, keyframes: followed }],
  overlay: { timestamp: false, cameraName: false, customText: null }, includeAudio: false, outputDir: exportDir, fileStem: 'follow-redact', notes: null
})
if (fx.kind === 'done') {
  let worst = 0
  for (const at of ['0.2', '0.8', '1.4', '1.9']) {
    const buf = execFileSync(FFMPEG, ['-v', 'error', '-ss', at, '-i', fx.result.outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 })
    let red = 0
    for (let i = 0; i < buf.length; i += 3) if (buf[i] > 150 && buf[i + 1] < 90 && buf[i + 2] < 90) red++
    worst = Math.max(worst, red / (100 * 100)) // square is 100×100 px at half scale
  }
  check('the followed box keeps the moving subject covered in the export', worst < 0.03, `worst exposed ${(worst * 100).toFixed(1)}% of the square`)
} else check('follow-redaction export finished', false, fx.message ?? '')

// the same in a dewarped PTZ view: treat the clip as a ceiling fisheye, draw a box and follow the square there
const FCAL = { cxPx: 1920, cyPx: 1080, radiusPx: 2200, fovDeg: 180, model: 'equidistant', mount: 'ceiling' }
const D = Math.PI / 180
// independent copy of the projection (source px → PTZ screen) so the test doesn't reuse the app's code
const srcToWorld = (px, py) => {
  const dx = px - FCAL.cxPx, dy = py - FCAL.cyPx
  const th = (Math.hypot(dx, dy) / FCAL.radiusPx) * (FCAL.fovDeg / 2) * D
  const ph = Math.atan2(dy, dx)
  const c = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)]
  return [c[0], c[2], -c[1]] // ceiling: cam = (w.x, -w.z, w.y)
}
const lookAt = (px, py, hfov) => { const w = srcToWorld(px, py); return { panDeg: Math.atan2(w[0], w[2]) / D, tiltDeg: Math.asin(w[1]) / D, hfovDeg: hfov } }
const PTZ = lookAt(1400, 1200, 110)
const toPtzScreen = (px, py, box) => {
  let [x, y, z] = srcToWorld(px, py)
  const p = -PTZ.panDeg * D, t = -PTZ.tiltDeg * D
  ;[x, z] = [x * Math.cos(p) + z * Math.sin(p), -x * Math.sin(p) + z * Math.cos(p)] // undo yaw
  ;[y, z] = [y * Math.cos(t) + z * Math.sin(t), -y * Math.sin(t) + z * Math.cos(t)] // undo pitch
  const tn = Math.tan((PTZ.hfovDeg * D) / 2)
  const u = x / z / tn, v = (y / z) * (box.width / box.height) / tn
  return { x: box.x + ((u + 1) / 2) * box.width, y: box.y + ((v + 1) / 2) * box.height }
}
await win.evaluate(({ id, cal, ptz }) => {
  const st = window.__axhibitStore.getState()
  const r = st.recordings.find((x) => x.id === id)
  const key = r.cameraName ? r.cameraName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : r.cameraId ?? r.fileName
  window.__axhibitStore.setState({ calibrations: { ...st.calibrations, [key]: cal }, rightTab: 'redact', tool: 'none', selectedTrack: null })
  st.updatePer(id, (x) => ({ ...x, fisheye: true, redactions: [], view: { ...x.view, mode: 'ptz', ptz } }))
}, { id: mover, cal: FCAL, ptz: PTZ })
await win.evaluate(() => window.__axhibitPlayer.seek(0))
await win.waitForTimeout(800)
const cv = await win.locator('canvas').first().boundingBox()
// draw a box around the square on the dewarped view
await win.keyboard.press('b')
const sq0 = [[400, 800], [600, 800], [600, 1000], [400, 1000]].map(([x, y]) => toPtzScreen(x, y, cv))
const xs = sq0.map((q) => q.x), ys = sq0.map((q) => q.y)
await win.mouse.move(Math.min(...xs) - 12, Math.min(...ys) - 12)
await win.mouse.down()
await win.mouse.move(Math.max(...xs) + 12, Math.max(...ys) + 12, { steps: 6 })
await win.mouse.up()
const drawn = await win.evaluate((id) => window.__axhibitStore.getState().per[id].redactions[0], mover)
const db = drawn?.keyframes[0]?.value
check('a box drawn on the PTZ view covers the subject in the raw frame', !!db && db.x <= 400 && db.y <= 800 && db.x + db.w >= 600 && db.y + db.h >= 1000, JSON.stringify(db))
await win.screenshot({ path: join(OUT, 'ptz-redact-drawn.png') })
// follow it through the PTZ view
if (drawn) {
  await win.evaluate(({ id, tid }) => { window.__axhibitStore.getState().updatePer(id, (x) => ({ ...x, redactions: x.redactions.map((r) => ({ ...r, style: 'solid' })) })); window.__axhibitStore.setState({ selectedTrack: tid }) }, { id: mover, tid: drawn.id })
  await win.locator('button', { hasText: 'Follow while playing' }).click()
  const s0 = toPtzScreen(500, 900, cv)
  await win.mouse.move(s0.x, s0.y)
  await win.mouse.down()
  for (let i = 0; i < 200; i++) {
    const t = await win.evaluate(() => window.__axhibitPlayer.currentMediaTime())
    if (t >= 2.6) break
    const c = squareCenter(t)
    const p = toPtzScreen(c.x, c.y, cv)
    await win.mouse.move(p.x, p.y)
    await win.waitForTimeout(30)
  }
  await win.screenshot({ path: join(OUT, 'ptz-redact-following.png') })
  await win.mouse.up()
  await win.locator('button', { hasText: 'Stop following' }).click()
  await win.waitForTimeout(300)
  const pk = await win.evaluate(({ id, tid }) => window.__axhibitStore.getState().per[id].redactions.find((r) => r.id === tid).keyframes, { id: mover, tid: drawn.id })
  const px = await runJob('exportClip', {
    recordingId: mover, inSec: 0.4, outSec: 2.4, trimMode: 'exact', view: { kind: 'original' }, outW: 1920, outH: 1080,
    redactions: [{ id: 'p', style: 'solid', enabled: true, keyframes: pk }],
    overlay: { timestamp: false, cameraName: false, customText: null }, includeAudio: false, outputDir: exportDir, fileStem: 'ptz-follow-redact', notes: null
  })
  let worst = 1
  if (px.kind === 'done') {
    worst = 0
    for (const at of ['0.2', '0.8', '1.4', '1.9']) {
      const buf = execFileSync(FFMPEG, ['-v', 'error', '-ss', at, '-i', px.result.outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 })
      let red = 0
      for (let i = 0; i < buf.length; i += 3) if (buf[i] > 150 && buf[i + 1] < 90 && buf[i + 2] < 90) red++
      worst = Math.max(worst, red / (100 * 100))
    }
  }
  check('following through the PTZ view keeps the subject covered', worst < 0.03, `${pk.length} keyframes; worst exposed ${(worst * 100).toFixed(1)}%`)
}

// 4. fast trim keeps original bytes per frame (stream copy)
const fast = await runJob('exportClip', {
  recordingId: fish, inSec: 10, outSec: 14, trimMode: 'fast', view: { kind: 'original' }, outW: 2880, outH: 2880, redactions: [],
  overlay: { timestamp: false, cameraName: false, customText: null }, includeAudio: true, outputDir: exportDir, fileStem: 'fast', notes: null
})
check('fast trim finished', fast.kind === 'done', fast.message ?? '')
if (fast.kind === 'done') {
  const m = JSON.parse(readFileSync(fast.result.manifestPath, 'utf8'))
  const trim = m.operations.find((o) => o.type === 'trim')
  check('fast trim snaps to a keyframe at/before in', trim.actualInSec <= 10 && trim.mode === 'fast', `actualIn ${trim.actualInSec}`)
}

// 5. snapshot via UI path (PTZ on fisheye)
await win.evaluate((id) => window.__axhibitStore.setState({ selectedId: id, layout: 'single' }), fish)
await win.waitForFunction((id) => window.__axhibitStore.getState().media[id]?.status === 'ready', fish, { timeout: 120000 })
await win.waitForTimeout(1500)
for (const [key, mode] of [['3', 'pano'], ['4', 'dualpano'], ['5', 'quad'], ['2', 'ptz']]) {
  await win.keyboard.press(key)
  await win.waitForTimeout(800)
  if (mode !== 'ptz') await win.screenshot({ path: join(OUT, `mode-${mode}.png`) })
  const m = await win.evaluate((id) => window.__axhibitStore.getState().per[id]?.view.mode, fish)
  check(`dewarp mode ${mode} selectable`, m === mode, m)
}
// current PTZ view with pixelate redaction + custom overlay (what the Export dialog sends)
const ptz = await win.evaluate(async ({ id, dir }) => {
  const st = window.__axhibitStore.getState()
  const calib = Object.values(st.calibrations)[0] ?? { cxPx: 1441, cyPx: 1437, radiusPx: 1443, fovDeg: 180, model: 'equidistant', mount: 'ceiling' }
  const jobId = await window.axhibit.exportClip({
    recordingId: id, inSec: 2, outSec: 3.5, trimMode: 'exact', view: { kind: 'current', view: st.per[id].view, calib },
    outW: 1280, outH: 720, redactions: [{ id: 'r1', style: 'pixelate', enabled: true, keyframes: [{ tSec: 0, value: { x: 1100, y: 1100, w: 500, h: 400 } }] }],
    overlay: { timestamp: true, cameraName: true, customText: 'Case 1234' }, includeAudio: true, outputDir: dir, fileStem: 'ptz', notes: 'e2e'
  })
  return await new Promise((resolve) => { const off = window.axhibit.onJobEvent((e) => { if (e.jobId === jobId && e.kind !== 'progress') { off(); resolve(e) } }) })
}, { id: fish, dir: exportDir })
check('PTZ view export with pixelate + overlay finished', ptz.kind === 'done', ptz.message ?? '')
if (ptz.kind === 'done') {
  const m = JSON.parse(readFileSync(ptz.result.manifestPath, 'utf8'))
  check('PTZ manifest records dewarp + overlay text', m.operations.some((o) => o.type === 'dewarp' && o.mode === 'ptz') && m.operations.some((o) => o.type === 'overlay' && o.customText === 'Case 1234'))
}
await win.evaluate((dir) => { const s = window.__axhibitStore.getState(); window.__axhibitStore.setState({ settings: { ...s.settings, defaultOutputDir: dir } }) }, exportDir)
await win.keyboard.press('s')
await win.waitForTimeout(4000)
const pngs = readdirSync(exportDir).filter((f) => f.endsWith('.png'))
check('snapshot saved with manifest', pngs.length === 1 && readdirSync(exportDir).includes(pngs[0] + '.manifest.json'), pngs.join(','))

// 6. grid sync of a multi-sensor camera (every recording whose file name starts with CFG.gridPrefix)
const keys = await win.evaluate((prefix) => [...new Set(window.__axhibitStore.getState().recordings.filter((r) => r.fileName.startsWith(prefix)).map((r) => r.cameraName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()))], CFG.gridPrefix)
await win.evaluate((k) => { window.__axhibitStore.setState({ gridCameras: k }); window.__axhibitStartGrid(k) }, keys)
await win.waitForTimeout(700)
const tileState = await win.evaluate(() => window.__axhibitPlayer.tiles.map((t) => ({ active: !!t.activeId, pending: !!t.pendingId, empty: t.empty })))
const blank = tileState.filter((t) => !t.active && !t.pending && !t.empty).length
const preparingShown = await win.locator('text=/Preparing|Making a playable copy/').count()
check('grid tiles are never blank while loading', blank === 0 && (tileState.every((t) => t.active || t.empty) || preparingShown > 0), JSON.stringify(tileState))
const allSegs = await win.evaluate(() => window.__axhibitPlayer.tiles.flatMap((t) => t.segments.map((s) => s.id)))
await win.waitForFunction((ids) => ids.every((id) => window.__axhibitStore.getState().media[id]?.status === 'ready'), allSegs, { timeout: 180000 }).catch(() => undefined)
const readyCount = await win.evaluate((ids) => ids.filter((id) => window.__axhibitStore.getState().media[id]?.status === 'ready').length, allSegs)
check('grid prepares every segment of every camera', readyCount === allSegs.length, `${readyCount}/${allSegs.length}`)
await win.waitForTimeout(1000)
await win.keyboard.press('Space')
await win.waitForTimeout(4000)
const spread = await win.evaluate(() => {
  const s = window.__axhibitStore.getState()
  const vids = [...document.querySelectorAll('video')].filter((v) => v.src && !v.paused)
  return vids.map((v) => v.currentTime)
})
await win.keyboard.press('Space')
await win.screenshot({ path: join(OUT, 'grid.png') })
check('grid plays several cameras', spread.length >= 2, JSON.stringify(spread))

check('no renderer page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
await app.close()

// originals untouched
const after = hashTree(SAMPLES)
const changed = Object.keys(before).filter((k) => before[k] !== after[k])
check('no original file changed (hash + mtime)', changed.length === 0 && Object.keys(after).length === Object.keys(before).length, changed.join(', '))
console.log('\nSUMMARY', results.filter((r) => r[0] === 'PASS').length, 'passed,', results.filter((r) => r[0] === 'FAIL').length, 'failed,', results.filter((r) => r[0] === 'SKIP').length, 'skipped')
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0)
