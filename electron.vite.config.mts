import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = dirname(fileURLToPath(import.meta.url))
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: { resolve: { alias: shared }, build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } } },
  preload: { resolve: { alias: shared }, build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } } },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: shared },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          export: resolve(__dirname, 'src/renderer/export.html')
        }
      }
    }
  }
})
