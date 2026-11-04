// `sosie scan` on one session's transcript and the files beside it, in the background, keeping what it found for the
// next session to report. It keeps what `sosie scan` prints: the file, the line and the field of a real value, never
// the value.
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { cli, keep } from './sosie.mjs'

const [out, transcript, ...beside] = process.argv.slice(2)
const scan = spawnSync('npx', ['-y', cli(), 'scan', transcript, ...beside], {
  // Not the project's folder: a @sosie/cli in its node_modules would run instead of the one the plugin pins.
  cwd: dirname(out),
  encoding: 'utf8',
  env: { ...process.env, NO_COLOR: '1' },
  shell: process.platform === 'win32',
  timeout: 10 * 60_000,
})

const plain = (text) => (text ?? '').replace(/\x1b\[[0-9;]*m/g, '')
if (scan.status === 1) {
  const findings = [...plain(scan.stdout).matchAll(/✗ (.+):(\d+)\s+a real value from (\S+)/g)].map(([, file, line, field]) => ({
    file,
    line: Number(line),
    field,
  }))
  keep(out, { transcript, findings })
} else if (scan.status !== 0) {
  const why = plain(scan.stderr).trim().split('\n').pop() || scan.error?.message || `exit ${scan.status ?? scan.signal}`
  keep(out, { transcript, failed: why.replace(/^✗\s*/, '') })
}
