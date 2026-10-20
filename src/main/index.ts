import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { argvPaths } from '../shared/argv'
import { APP_NAME, PROJECT_SCHEMA } from '../shared/constants'
import { sanitizeStem, uniqueStem } from '../shared/files'
import { IPC, type AppInfo, type ExportRequest, type ProjectFile, type SnapshotRequest, type StoreShape } from '../shared/ipc'
import { configureRenderWindow, exportClip, exportSnapshot } from './exporter'
import { cancelAll, cancelJob, startJob } from './jobs'
import { detectEncoders, getFfmpegVersion, keyframes, openPaths, sha256File } from './library'
import { log } from './log'
import { handleMediaProtocol, prepareMedia, registerSchemePrivileges, thumbnail } from './media'
import { getStore } from './store'
import { validatorAvailable, verifySigned } from './verify'

registerSchemePrivileges()
app.setName(APP_NAME)
// Tests run against a throwaway profile so they neither share the user's settings nor hit the single-instance lock.
if (!app.isPackaged && process.env.AXHIBIT_USER_DATA) app.setPath('userData', process.env.AXHIBIT_USER_DATA)
// Tests: run as a machine without a usable GPU would (WebGL on SwiftShader, the software fallback).
if (!app.isPackaged && process.env.AXHIBIT_DISABLE_GPU === '1') app.disableHardwareAcceleration()
// WebGL must work on blocklisted GPUs, Remote Desktop sessions and VMs: allow the software (SwiftShader) fallback.
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-unsafe-swiftshader')

let mainWindow: BrowserWindow | null = null
const pendingOpen: string[] = []

/** Paths passed on the command line (e.g. "Open with Axhibit A", or dragging a folder onto the exe). */
function pathsFromArgv(argv: string[], cwd = process.cwd()): string[] {
  return argvPaths(argv, app.isPackaged, cwd, existsSync, resolve)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv, workingDirectory) => {
    const p = pathsFromArgv(argv, workingDirectory)
    if (!mainWindow) {
      // still starting up: hand them over once the window has loaded
      pendingOpen.push(...p)
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    if (p.length) mainWindow.webContents.send(IPC.openPathsPush, p)
  })
}

function rendererUrl(page: 'index' | 'export'): { dev?: string; file: string } {
  const file = join(__dirname, `../renderer/${page}.html`)
  const devBase = process.env['ELECTRON_RENDERER_URL']
  return { dev: !app.isPackaged && devBase ? `${devBase}/${page}.html` : undefined, file }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0b0d10',
    title: APP_NAME,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())
  const u = rendererUrl('index')
  if (u.dev) void mainWindow.loadURL(u.dev)
  else void mainWindow.loadFile(u.file)
  mainWindow.webContents.once('did-finish-load', () => {
    const p = [...pendingOpen, ...pathsFromArgv(process.argv)]
    pendingOpen.length = 0
    if (p.length) mainWindow?.webContents.send(IPC.openPathsPush, p)
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function registerIpc() {
  ipcMain.handle(IPC.openPaths, (_e, paths: string[]) => {
    if (!Array.isArray(paths)) throw new Error('Invalid paths')
    return openPaths(paths.filter((p) => typeof p === 'string'))
  })
  ipcMain.handle(IPC.pickFolder, async () => {
    const r = await dialog.showOpenDialog(mainWindow!, { title: 'Open ACS Pro export folder', properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle(IPC.pickFiles, async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: 'Open recordings',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Recordings', extensions: ['asf', 'mkv', 'mp4'] }]
    })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle(IPC.pickOutputDir, async () => {
    const r = await dialog.showOpenDialog(mainWindow!, { title: 'Choose export folder', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle(IPC.prepareMedia, (_e, id: string, needProxy: boolean) => startJob('prepare', (ctx) => prepareMedia(String(id), !!needProxy, ctx)))
  ipcMain.handle(IPC.thumbnail, (_e, id: string) => thumbnail(String(id)).catch(() => null))
  ipcMain.handle(IPC.keyframes, (_e, id: string) => keyframes(String(id)))
  ipcMain.handle(IPC.hashSource, (_e, id: string) => startJob('hash', (ctx) => sha256File(String(id), ctx)))
  ipcMain.handle(IPC.exportClip, (_e, req: ExportRequest) => {
    if (!req || typeof req.outputDir !== 'string' || !existsSync(req.outputDir)) throw new Error('Choose an existing export folder')
    return startJob('export', (ctx) => exportClip(req, ctx))
  })
  ipcMain.handle(IPC.exportSnapshot, (_e, req: SnapshotRequest) => {
    if (!req || typeof req.outputDir !== 'string' || !existsSync(req.outputDir)) throw new Error('Choose an existing export folder')
    return exportSnapshot(req)
  })
  ipcMain.handle(IPC.verifySigned, (_e, id: string) => startJob('verify', (ctx) => verifySigned(String(id), ctx)))
  ipcMain.handle(IPC.cancelJob, (_e, jobId: string) => cancelJob(String(jobId)))
  ipcMain.handle(IPC.storeGet, (_e, key: keyof StoreShape) => getStore().get(key))
  ipcMain.handle(IPC.storeSet, (_e, key: keyof StoreShape, value: StoreShape[keyof StoreShape]) => {
    if (!['settings', 'calibrations', 'recent'].includes(key)) throw new Error('Invalid key')
    getStore().set(key, value as never)
  })
  ipcMain.handle(IPC.reveal, (_e, p: string) => {
    if (typeof p === 'string' && existsSync(p)) shell.showItemInFolder(p)
  })
  ipcMain.handle(IPC.appInfo, async (): Promise<AppInfo> => {
    const enc = await detectEncoders()
    const override = getStore().get('settings').encoderOverride
    let osUser = 'unknown'
    try {
      osUser = userInfo().username
    } catch {
      /* ignore */
    }
    return {
      name: APP_NAME,
      version: app.getVersion(),
      ffmpegVersion: getFfmpegVersion(),
      encoders: enc.working,
      encoder: override && enc.working.includes(override as never) ? override : enc.working[0] ?? null,
      platform: process.platform,
      signedVideoValidator: validatorAvailable(),
      osUser
    }
  })
  ipcMain.handle(IPC.saveProject, async (_e, dir: string, stem: string, project: ProjectFile) => {
    if (!existsSync(dir)) throw new Error('Folder does not exist')
    const s = uniqueStem(sanitizeStem(stem), ['.axhibit.json'], (f) => existsSync(join(dir, f)))
    const p = join(dir, s + '.axhibit.json')
    await writeFile(p, JSON.stringify({ ...project, schema: PROJECT_SCHEMA, savedAt: new Date().toISOString() }, null, 2), { flag: 'wx' })
    return p
  })
  ipcMain.handle(IPC.loadProject, async () => {
    const r = await dialog.showOpenDialog(mainWindow!, { title: 'Open Axhibit project', properties: ['openFile'], filters: [{ name: 'Axhibit project', extensions: ['json'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    const data = JSON.parse(await readFile(r.filePaths[0], 'utf8'))
    if (data?.schema !== PROJECT_SCHEMA) throw new Error('Not an Axhibit project file')
    return data
  })
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  // Lock down: no permissions, CSP enforced via meta in pages, block all remote requests.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url
    const allowed = u.startsWith('file:') || u.startsWith('axhibit-media:') || u.startsWith('devtools:') || u.startsWith('data:') || u.startsWith('blob:') ||
      (!app.isPackaged && (u.startsWith('http://localhost') || u.startsWith('ws://localhost') || u.startsWith('http://127.0.0.1')))
    cb({ cancel: !allowed })
  })
  handleMediaProtocol()
  configureRenderWindow(rendererUrl('export'))
  registerIpc()
  createWindow()
  void detectEncoders()
  log(`${APP_NAME} ${app.getVersion()} started (${process.platform})`)
})

app.on('open-file', (e, p) => {
  e.preventDefault()
  if (mainWindow) mainWindow.webContents.send(IPC.openPathsPush, [p])
  else pendingOpen.push(p)
})

app.on('window-all-closed', () => {
  cancelAll()
  app.quit()
})
