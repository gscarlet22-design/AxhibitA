import { createRoot } from 'react-dom/client'
// Inter ships with the app (CSP blocks remote fonts); latin + other subsets load on demand
import '@fontsource-variable/inter/wght.css'
import './index.css'
import { useApp } from './state/store'
import { App } from './ui/App'
import { startGrid } from './ui/Sidebar'
import { player } from './player/player'

// test/diagnostic hooks (renderer-local state only)
Object.assign(window, { __axhibitStore: useApp, __axhibitStartGrid: startGrid, __axhibitPlayer: player })

createRoot(document.getElementById('root')!).render(<App />)
