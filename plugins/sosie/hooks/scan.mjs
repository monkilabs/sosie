// `sosie scan` on one session's transcript and the files beside it, in the background, keeping what it found for the
// next session to report: the file, the line and the field of a real value, never the value. Run again while it
// runs, for a turn that ended meanwhile, it scans once more when done.
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { cli, keep } from './sosie.mjs'

const [out, ...paths] = process.argv.slice(2)
const lock = out.replace(/\.json$/, '.lock')
const again = out.replace(/\.json$/, '.again')
const plain = (text) => (text ?? '').replace(/\x1b\[[0-9;]*m/g, '')

writeFileSync(lock, String(process.pid), { mode: 0o600 })
try {
  do {
    rmSync(again, { force: true })
    const scan = spawnSync('npx', ['-y', cli(), 'scan', ...paths], {
      // Not the project's folder: a @sosie/cli in its node_modules would run instead of the one the plugin pins.
      cwd: dirname(out),
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      shell: process.platform === 'win32',
      timeout: 10 * 60_000,
    })
    if (scan.status === 1) {
      const findings = [...plain(scan.stdout).matchAll(/✗ (.+):(\d+)\s+a real value from (\S+)/g)].map(([, file, line, field]) => ({
        file,
        line: Number(line),
        field,
      }))
      keep(out, { transcript: paths[0], findings })
    } else if (scan.status !== 0) {
      const why = plain(scan.stderr).trim().split('\n').pop() || scan.error?.message || `exit ${scan.status ?? scan.signal}`
      keep(out, { transcript: paths[0], failed: why.replace(/^✗\s*/, '') })
    }
    // A clean scan keeps nothing: a session's transcript only grows, so an earlier finding not reported yet stays.
  } while (existsSync(again))
} finally {
  rmSync(lock, { force: true })
}
