import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Running } from './source.js'

/**
 * Each running `sosie` writes what `sosie mcp` needs to
 * $SOSIE_HOME/running/<pid>.json: the local address, the source kind and the
 * neutral schema. Nothing real: no upstream, no credentials, no values.
 */
const DIR = 'running'

export function writeRunning(home: string, running: Running, pid = process.pid): void {
  mkdirSync(join(home, DIR), { recursive: true, mode: 0o700 })
  writeFileSync(join(home, DIR, `${pid}.json`), JSON.stringify({ ...running, pid, startedAt: Date.now() }, null, 2), { mode: 0o600 })
}

/** Every Sosie running on this machine, the newest first. Throws a message for the agent when none is. */
export function readRunning(home: string): Running[] {
  let files: string[] = []
  try {
    files = readdirSync(join(home, DIR)).filter((f) => f.endsWith('.json'))
  } catch {
    // None has run yet.
  }
  const running: (Running & { pid: number; startedAt: number })[] = []
  for (const file of files) {
    try {
      const entry = JSON.parse(readFileSync(join(home, DIR, file), 'utf8'))
      if (alive(entry.pid)) running.push(entry)
      else rmSync(join(home, DIR, file), { force: true })
    } catch {
      // Being written, or not ours.
    }
  }
  if (!running.length) throw new Error(NOT_RUNNING)
  return running.sort((a, b) => b.startedAt - a.startedAt).map(({ pid: _, startedAt: __, ...r }) => r)
}

/** Remove this process's entry. */
export function clearRunning(home: string, pid = process.pid): void {
  rmSync(join(home, DIR, `${pid}.json`), { force: true })
}

const NOT_RUNNING =
  'Sosie is not running. Ask the developer to start it in their own terminal with `npx @sosie/cli`, then try again.'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
