// Export speed benchmark: runs one export against the fisheye sample and prints wall time.
// Needs a build. Usage: AXHIBIT_SAMPLES=<samples dir> [SPEC='{"dur":2,"w":1280,"h":720}'] node scripts/bench-export.mjs
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const OUT = resolve(process.env.OUT || 'test-output')
const exportDir = join(OUT, 'bench')
mkdirSync(exportDir, { recursive: true })
const SAMPLES = resolve(process.env.AXHIBIT_SAMPLES || 'samples')
// default: the fisheye MKV named in tests/e2e/samples.local.json
const localCfg = resolve('tests/e2e/samples.local.json')
const FILE = process.env.BENCH_FILE || (existsSync(localCfg) ? JSON.parse(readFileSync(localCfg, 'utf8')).fisheyeMkv : undefined)
if (!FILE) throw new Error('Set BENCH_FILE or create tests/e2e/samples.local.json (see samples.example.json)')
const spec = JSON.parse(process.env.SPEC || '{}')

const app = await electron.launch({ args: ['.', SAMPLES], env: { ...process.env, AXHIBIT_DEBUG: '1', AXHIBIT_USER_DATA: join(OUT, 'userdata-bench') } })
app.process().stdout.on('data', (d) => process.stdout.write('[main] ' + d))
const win = await app.firstWindow()
win.on('console', (m) => console.log('[renderer]', m.text()))
await win.waitForFunction((f) => window.__axhibitStore?.getState().recordings.some((r) => r.fileName === f), FILE, { timeout: 90000 })
const t0 = Date.now()
const res = await win.evaluate(async ({ dir, spec, file }) => {
  const r = window.__axhibitStore.getState().recordings.find((x) => x.fileName === file)
  const calib = { cxPx: 1441, cyPx: 1437, radiusPx: 1443, fovDeg: 180, model: 'equidistant', mount: 'ceiling' }
  const view = { mode: 'ptz', normal: { zoom: 1, centerX: 0.5, centerY: 0.5 }, ptz: { panDeg: 200, tiltDeg: 35, hfovDeg: 80 }, pano: { offsetDeg: 0, topDeg: 0, bottomDeg: 70 }, quad: [] }
  const jobId = await window.axhibit.exportClip({
    recordingId: r.id, inSec: 2, outSec: 2 + (spec.dur ?? 2), trimMode: 'exact', view: spec.view ?? { kind: 'current', view, calib },
    outW: spec.w ?? 1280, outH: spec.h ?? 720, redactions: spec.red ?? [{ id: 'r1', style: 'pixelate', enabled: true, keyframes: [{ tSec: 0, value: { x: 900, y: 1300, w: 500, h: 400 } }] }],
    overlay: { timestamp: true, cameraName: true, customText: 'Case 1234' }, includeAudio: true, outputDir: dir, fileStem: spec.stem ?? 'bench', notes: 'bench'
  })
  return await new Promise((resolve) => {
    let last = 0
    const off = window.axhibit.onJobEvent((e) => {
      if (e.jobId !== jobId) return
      if (e.kind === 'progress') { if (e.progress - last > 0.1) { last = e.progress; console.log('progress', e.progress.toFixed(2), e.message) } } else { off(); resolve(e) }
    })
  })
}, { dir: exportDir, spec, file: FILE })
console.log('RESULT', (Date.now() - t0) / 1000, 's', JSON.stringify(res).slice(0, 500))
console.log(readdirSync(exportDir))
await app.close()
