import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { headerVariables, type SourceConfig } from '@sosie/core'

/**
 * What each project's sources may send their upstreams of the terminal's variables, as the developer allowed it on
 * this machine: $SOSIE_HOME/allowed.json. sosie.yml is the agent's to edit, and this is not: an edit that has a source
 * send a variable it never sent, or send one to an upstream another variable names, is asked about before anything is
 * sent. A variable's value is never kept here, only its name.
 */
const FILE = 'allowed.json'

/** project (sosie.yml's real path) → source → each `sends` allowed for it. */
type Allowed = Record<string, Record<string, string[]>>

/**
 * What a source sends of the terminal's variables, as one line that changes when any of it does: the variable its
 * upstream is read from, and each header's. Nothing for a source whose headers name no variable.
 */
export function sendsOf(source: SourceConfig): string | undefined {
  const headers = Object.entries(source.headers)
    .map(([header, template]) => `${header}: ${headerVariables(template).join(' ')}`)
    .filter((line) => !line.endsWith(': '))
  return headers.length ? `${source.upstream} ← ${headers.sort().join('; ')}` : undefined
}

/** sosie.yml's sources whose sends this machine has not allowed, as sosie.yml now says them. */
export function unallowed(home: string, file: string, sources: SourceConfig[]): SourceConfig[] {
  const allowed = read(home)[realpathSync(file)] ?? {}
  return sources.filter((source) => {
    const sends = sendsOf(source)
    return sends !== undefined && !allowed[source.name]?.includes(sends)
  })
}

/** Allow what each source sends, as sosie.yml now says it, besides what it was allowed before: a branch of the project may say otherwise. */
export function allow(home: string, file: string, sources: SourceConfig[]): void {
  const all = read(home)
  const project = (all[realpathSync(file)] ??= {})
  for (const source of sources) {
    const sends = sendsOf(source)
    if (sends !== undefined && !project[source.name]?.includes(sends)) project[source.name] = [...(project[source.name] ?? []), sends]
  }
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const path = join(home, FILE)
  writeFileSync(`${path}.draft`, JSON.stringify(all, null, 2), { mode: 0o600 })
  renameSync(`${path}.draft`, path)
}

function read(home: string): Allowed {
  try {
    const all = JSON.parse(readFileSync(join(home, FILE), 'utf8'))
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
  } catch {
    // None yet, or not Sosie's: nothing allowed.
    return {}
  }
}
