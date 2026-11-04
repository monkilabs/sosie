// What Claude Code's hooks read of Sosie: the files it writes for `sosie mcp` and its stores, never a value.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where Sosie keeps its stores, as `sosie` reads it: $SOSIE_HOME, or ~/.sosie. */
export const home = process.env.SOSIE_HOME || join(homedir(), '.sosie')

/** The plugin's own folder, and the one Claude Code keeps for its data across updates. */
export const root = fileURLToPath(new URL('..', import.meta.url))
const data = process.env.CLAUDE_PLUGIN_DATA

/** `@sosie/cli` at the version the plugin's MCP server runs, so a scan reads the store the way it was written. */
export function cli() {
  try {
    const args = JSON.parse(readFileSync(join(root, 'mcp.json'), 'utf8')).mcpServers.sosie.args
    return args.find((a) => a.startsWith('@sosie/cli')) ?? '@sosie/cli'
  } catch {
    return '@sosie/cli'
  }
}

/** The hook's input, which Claude Code writes to stdin as JSON. */
export async function input() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** Every Sosie running on this machine, from $SOSIE_HOME/running/: its kind and address. */
export function running() {
  const dir = join(home, 'running')
  if (!existsSync(dir)) return []
  const found = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const { kind, address, pid } = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      if (alive(pid)) found.push({ kind, address })
    } catch {
      // Being written, or not Sosie's.
    }
  }
  return found
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Whether Sosie has faked anything on this machine, so a scan has a store to compare with. */
export function hasStore() {
  if (!existsSync(home)) return false
  return readdirSync(home, { withFileTypes: true }).some((d) => d.isDirectory() && existsSync(join(home, d.name, 'store.db')))
}

/** Where a session's scan result waits for the next session; null outside Claude Code. */
export function scanFile(sessionId) {
  if (!data) return null
  mkdirSync(join(data, 'scans'), { recursive: true })
  return join(data, 'scans', `${String(sessionId).replace(/[^\w-]/g, '_')}.json`)
}

export function keep(file, result) {
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
}

/** The results scans left since the last session started, each taken once. */
export function takeScans() {
  if (!data || !existsSync(join(data, 'scans'))) return []
  const results = []
  for (const name of readdirSync(join(data, 'scans')).filter((f) => f.endsWith('.json'))) {
    const file = join(data, 'scans', name)
    try {
      results.push(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      continue // still being written
    }
    rmSync(file, { force: true })
  }
  return results
}
