module.exports = {
  content: ['./src/renderer/**/*.{html,tsx,ts}'],
  theme: {
    extend: {
      colors: {
        ink: { 100: '#eef1f5', 950: '#0b0d10', 900: '#111418', 850: '#16191e', 800: '#1d2127', 750: '#22262d', 700: '#262c34', 600: '#353d49', 500: '#7d8794', 400: '#9aa3af', 300: '#b4bcc8', 200: '#d8dde5' },
        amber: { 400: '#ffcc33', 500: '#f5b800', 600: '#d99e00' },
        evid: { ok: '#3ecf8e', warn: '#f5a524', bad: '#f0566a' },
        path: { view: '#6ea8ff', zoom: '#8b95ff' }
      },
      borderRadius: { panel: '12px', card: '10px' },
      fontFamily: { sans: ['Inter Variable', 'Inter', 'Segoe UI Variable Text', 'Segoe UI', 'system-ui', 'sans-serif'], mono: ['JetBrains Mono', 'Cascadia Mono', 'Consolas', 'monospace'] }
    }
  }
}
