import type { Settings } from '@shared/ipc'

export const DEFAULT_SETTINGS_RENDERER: Settings = {
  theme: 'dark',
  cacheLimitGb: 20,
  defaultOutputDir: null,
  defaultTrimMode: 'exact',
  encoderOverride: null,
  operatorName: '',
  integrityNoticeAcknowledged: false
}
