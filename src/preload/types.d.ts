import type { AxhibitApi } from '../shared/ipc'

declare global {
  interface Window {
    axhibit: AxhibitApi
  }
}

export {}
