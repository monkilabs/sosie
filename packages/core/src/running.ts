import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Running } from './source.js'

/**
 * `sosie` writes what `sosie mcp` needs to $SOSIE_HOME/current.json: the local
 * address, the source kind and the neutral schema. Nothing real: no upstream,
 * no credentials, no values.
 */
const FILE = 'current.json'

export function writeRunning(home: string, running: Running, pid = process.pid): void {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeFileSync(join(home, FILE), JSON.stringify({ ...running, pid }, null, 2), { mode: 0o600 })
}

export function readRunning(home: string): Running {
  let current: Running & { pid: number }
  try {
    current = JSON.parse(readFileSync(join(home, FILE), 'utf8'))
  } catch {
    throw new Error(NOT_RUNNING)
  }
  if (!alive(current.pid)) throw new Error(NOT_RUNNING)
  const { pid: _, ...running } = current
  return running
}

/** Remove current.json if this process wrote it. */
export function clearRunning(home: string, pid = process.pid): void {
  try {
    const current = JSON.parse(readFileSync(join(home, FILE), 'utf8'))
    if (current.pid === pid) rmSync(join(home, FILE))
  } catch {
    // Nothing to clear.
  }
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
