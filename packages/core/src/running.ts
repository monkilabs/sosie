import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Running } from './source.js'

/**
 * Each running `sosie` writes what `sosie mcp` needs to $SOSIE_HOME/running/<pid>.json: each source's name, kind,
 * local address and neutral schema. Nothing real: no upstream, no credentials, no values.
 */
const DIR = 'running'

/** Write this Sosie's entry: its sources. Written again as a schema grows, with the time it started, so the newest stays the newest. */
export function writeRunning(home: string, sources: Running[], pid = process.pid, startedAt = Date.now()): void {
  mkdirSync(join(home, DIR), { recursive: true, mode: 0o700 })
  // Whole or not at all: sosie mcp may read it while it is written again.
  const file = join(home, DIR, `${pid}.json`)
  writeFileSync(`${file}.draft`, JSON.stringify({ pid, startedAt, sources }, null, 2), { mode: 0o600 })
  renameSync(`${file}.draft`, file)
}

/** Every source of every Sosie running on this machine, the newest Sosie's first. Throws a message for the agent when none is. */
export function readRunning(home: string): Running[] {
  let files: string[] = []
  try {
    files = readdirSync(join(home, DIR)).filter((f) => f.endsWith('.json'))
  } catch {
    // None has run yet.
  }
  const running: { startedAt: number; sources: Running[] }[] = []
  for (const file of files) {
    try {
      const entry = JSON.parse(readFileSync(join(home, DIR, file), 'utf8'))
      if (!alive(entry.pid)) rmSync(join(home, DIR, file), { force: true })
      // An earlier version's entry is one source, named by its kind.
      else running.push({ startedAt: entry.startedAt, sources: entry.sources ?? [{ name: entry.kind, kind: entry.kind, address: entry.address, schema: entry.schema, passing: entry.passing }] })
    } catch {
      // Being written, or not ours.
    }
  }
  const sources = running.sort((a, b) => b.startedAt - a.startedAt).flatMap((r) => r.sources)
  if (!sources.length) throw new Error(NOT_RUNNING)
  return sources
}

/** Remove this process's entry. */
export function clearRunning(home: string, pid = process.pid): void {
  rmSync(join(home, DIR, `${pid}.json`), { force: true })
}

const NOT_RUNNING =
  'Sosie is not running. Ask the developer to start it in their own terminal, in the project’s folder, with `npx @sosie/cli`, then try again.'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
