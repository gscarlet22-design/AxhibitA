import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type AxhibitApi } from '../shared/ipc'
import type { JobEvent } from '../shared/types'

const api: AxhibitApi = {
  openPaths: (paths) => ipcRenderer.invoke(IPC.openPaths, paths),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  pickFiles: () => ipcRenderer.invoke(IPC.pickFiles),
  pickOutputDir: () => ipcRenderer.invoke(IPC.pickOutputDir),
  prepareMedia: (id, needProxy) => ipcRenderer.invoke(IPC.prepareMedia, id, needProxy),
  thumbnail: (id) => ipcRenderer.invoke(IPC.thumbnail, id),
  keyframes: (id) => ipcRenderer.invoke(IPC.keyframes, id),
  hashSource: (id) => ipcRenderer.invoke(IPC.hashSource, id),
  exportClip: (req) => ipcRenderer.invoke(IPC.exportClip, req),
  exportSnapshot: (req) => ipcRenderer.invoke(IPC.exportSnapshot, req),
  verifySigned: (id) => ipcRenderer.invoke(IPC.verifySigned, id),
  cancelJob: (jobId) => ipcRenderer.invoke(IPC.cancelJob, jobId),
  onJobEvent: (cb) => {
    const h = (_: unknown, e: JobEvent) => cb(e)
    ipcRenderer.on(IPC.jobEvent, h)
    return () => ipcRenderer.removeListener(IPC.jobEvent, h)
  },
  onOpenPaths: (cb) => {
    const h = (_: unknown, p: string[]) => cb(p)
    ipcRenderer.on(IPC.openPathsPush, h)
    return () => ipcRenderer.removeListener(IPC.openPathsPush, h)
  },
  storeGet: (key) => ipcRenderer.invoke(IPC.storeGet, key),
  storeSet: (key, value) => ipcRenderer.invoke(IPC.storeSet, key, value),
  reveal: (p) => ipcRenderer.invoke(IPC.reveal, p),
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  pathForFile: (file) => webUtils.getPathForFile(file),
  saveProject: (dir, stem, project) => ipcRenderer.invoke(IPC.saveProject, dir, stem, project),
  loadProject: () => ipcRenderer.invoke(IPC.loadProject)
}

contextBridge.exposeInMainWorld('axhibit', api)

// Export renderer: forward the MessagePort from main into the page (ports can't cross contextBridge directly).
ipcRenderer.on('render:port', (e) => {
  window.postMessage('axhibit-render-port', '*', e.ports)
})
