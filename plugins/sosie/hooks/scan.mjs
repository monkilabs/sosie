// `sosie scan` on one session's transcript and the files beside it, in the background, keeping what it found for the
// next session to report: the file, the line and the field of a real value, never the value. Run again while it
// runs, for a turn that ended meanwhile, it scans once more when done.
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { addScan, cli, pathsOf, SCAN_TIMEOUT } from './sosie.mjs'

const [file, ...paths] = process.argv.slice(2)
const project = process.env.SOSIE_SCAN_PROJECT || undefined
const { out, lock, again } = pathsOf(file)
const plain = (text) => (text ?? '').replace(/\x1b\[[0-9;]*m/g, '')

/**
 * npx, without a shell where it can: on Windows npx is a batch file, which only cmd.exe runs, and cmd.exe splits an
 * argument at its spaces. So there, npm's own npx-cli.js beside node, or each argument in double quotes, which a
 * Windows path never holds.
 */
function npx(args) {
  if (process.platform !== 'win32') return ['npx', args, {}]
  const js = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js')
  if (existsSync(js)) return [process.execPath, [js, ...args], {}]
  return ['npx', args.map((a) => `"${a}"`), { shell: true }]
}

try {
  for (;;) {
    // Written each time it scans, so a lock older than a scan's limit is one a killed scan left.
    writeFileSync(lock, String(process.pid), { mode: 0o600 })
    rmSync(again, { force: true })
    const [command, args, options] = npx(['-y', cli(), 'scan', ...paths])
    const scan = spawnSync(command, args, {
      ...options,
      // Not the project's folder: a @sosie/cli in its node_modules would run instead of the one the plugin pins.
      cwd: dirname(out),
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      timeout: SCAN_TIMEOUT,
      // A session that leaked much prints much: a line per finding, with no cap on how many.
      maxBuffer: Infinity,
      windowsHide: true,
    })
    const findings = [...plain(scan.stdout).matchAll(/✗ (.+):(\d+)\s+a real value from (\S+)/g)].map(([, file, line, field]) => ({
      file,
      line: Number(line),
      field,
    }))
    if (scan.status === 0 || (scan.status === 1 && findings.length)) {
      addScan(out, { transcript: paths[0], findings, project })
    } else {
      // Exit 1 with nothing found is the CLI's own error, its message on the first line; npm's is on its last.
      const lines = plain(scan.stderr).trim().split('\n')
      const why = (scan.status === 1 ? lines[0] : lines.at(-1)) || scan.error?.message || `exit ${scan.status ?? scan.signal}`
      // What it found before it failed is kept, beside why it failed.
      addScan(out, { transcript: paths[0], findings, failed: why.replace(/^✗\s*/, ''), project })
    }
    if (existsSync(again)) continue
    rmSync(lock, { force: true })
    // A turn that ended between that look and the lock's going asked for one more scan.
    if (!existsSync(again)) break
  }
} catch (error) {
  rmSync(lock, { force: true })
  throw error
}
