/**
 * Paths passed on the command line ("Open with Axhibit A", dropping a folder onto the exe, or a second launch).
 * Electron/Chromium may add switches anywhere in argv; only existing paths count. Relative paths resolve
 * against the launching process's working directory (which differs from ours for a second instance).
 */
export function argvPaths(argv: string[], packaged: boolean, cwd: string, exists: (p: string) => boolean, resolve: (cwd: string, p: string) => string): string[] {
  const out: string[] = []
  for (const a of argv.slice(packaged ? 1 : 2)) {
    if (!a || a.startsWith('-')) continue
    const p = resolve(cwd, a)
    if (exists(p) && !out.includes(p)) out.push(p)
  }
  return out
}
