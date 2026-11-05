// What the plugin's hooks read of Sosie, the files it writes for `sosie mcp` and its stores, never a value; and where
// they keep what a scan found until a session reports it. Claude Code, Copilot CLI and VS Code run them alike.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where Sosie keeps its stores, as `sosie` reads it: $SOSIE_HOME, or ~/.sosie. */
export const home = process.env.SOSIE_HOME || join(homedir(), '.sosie')

/** The plugin's own folder. */
export const root = fileURLToPath(new URL('..', import.meta.url))

/** Copilot CLI runs this hook: it gives plugin hooks COPILOT_PLUGIN_DATA beside CLAUDE_PLUGIN_DATA. */
export const copilotCli = !!process.env.COPILOT_PLUGIN_DATA

/** The folder the assistant keeps for the plugin across updates (Claude Code, Copilot CLI); Sosie's own otherwise (VS Code). */
const data = process.env.CLAUDE_PLUGIN_DATA || join(home, 'plugin')

/** `@sosie/cli` at the version the plugin's MCP server runs, so a scan reads the store the way it was written. */
export function cli() {
  try {
    const args = JSON.parse(readFileSync(join(root, 'mcp.json'), 'utf8')).mcpServers.sosie.args
    return args.find((a) => a.startsWith('@sosie/cli')) ?? '@sosie/cli'
  } catch {
    return '@sosie/cli'
  }
}

/** The hook's input, which the assistant writes to stdin as JSON. */
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

export function alive(pid) {
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

/**
 * What to scan of a session: its transcript, and the folder beside it, named the same, where Claude Code keeps its
 * subagents' transcripts and long tool results. Copilot CLI says where neither is: its session lives in its own
 * folder under session-state/, as a folder of its id, or a file in older versions.
 */
export function sessionFiles({ session_id: session, transcript_path: transcript }, env = process.env) {
  if (transcript) {
    const beside = transcript.replace(/\.jsonl$/, '')
    return [transcript, ...(beside !== transcript ? [beside] : [])].filter((p) => existsSync(p))
  }
  if (!env.COPILOT_PLUGIN_DATA || !/^[\w-]+$/.test(String(session ?? ''))) return []
  for (const folder of copilotFolders(env)) {
    const state = join(folder, 'session-state')
    const found = [join(state, session), join(state, `${session}.jsonl`)].filter((p) => existsSync(p))
    if (found.length) return found
  }
  return []
}

/**
 * Where Copilot CLI may keep its sessions. It keeps a plugin's data in <its folder>/plugin-data/<marketplace>/<plugin>,
 * its folder being the one --config-dir names, or $COPILOT_HOME, or ~/.copilot; failing that, the last two.
 */
function copilotFolders(env) {
  const folders = []
  for (let dir = env.COPILOT_PLUGIN_DATA; dir && dirname(dir) !== dir; dir = dirname(dir)) {
    if (basename(dir) === 'plugin-data') {
      folders.push(dirname(dir))
      break
    }
  }
  folders.push(env.COPILOT_HOME || join(homedir(), '.copilot'))
  return [...new Set(folders)]
}

/** A session's id, safe as a file name. */
const named = (session) => String(session ?? 'unknown').replace(/[^\w-]/g, '_')

function folder(name) {
  const dir = join(data, name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** A scan runs for 10 minutes at most: a lock older than that was left by one that was killed. */
export const SCAN_TIMEOUT = 10 * 60_000

/** Where a session's scan keeps what it found, and its lock: one scan of a session at a time. */
export function scanPaths(session) {
  return pathsOf(join(folder('scans'), named(session)))
}

/** A scan's files, from the one it keeps its findings in: `scan.mjs` is given that, and finds its lock beside it. */
export function pathsOf(file) {
  const base = file.replace(/\.json$/, '')
  return { out: `${base}.json`, lock: `${base}.lock`, again: `${base}.again` }
}

/** Whether a scan of this session is running now: one that ends a turn while it does asks it to run once more. */
export function scanning(paths) {
  try {
    const pid = Number(readFileSync(paths.lock, 'utf8'))
    // A scan touches its lock each time it runs: an older one was killed, and its pid may be another process's now.
    if (!Number.isInteger(pid) || pid <= 0 || Date.now() - statSync(paths.lock).mtimeMs > SCAN_TIMEOUT + 60_000) return false
    // The scan runs as this user: a pid this user cannot signal is not the scan's.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A file written whole: to a draft beside it, then renamed, so it is never read half written. */
export function keep(file, result) {
  const draft = `${file}.${process.pid}.draft`
  writeFileSync(draft, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  renameSync(draft, file)
}

function textOf(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function read(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

const key = (f) => `${f.file}:${f.line}:${f.field}`

/**
 * What one scan of a session found, added to what earlier scans of it found that no session has reported yet: a scan
 * that fails, or finds less, never drops a finding. A scan that fails says so beside them; a clean one ends that.
 */
export function addScan(out, { transcript, findings = [], failed, project }) {
  const kept = read(out)
  const all = [...(kept?.findings ?? [])]
  // By key, in one pass: a scan may find thousands.
  const known = new Set(all.map(key))
  for (const f of findings) {
    if (known.has(key(f))) continue
    known.add(key(f))
    all.push(f)
  }
  const where = project ?? kept?.project
  if (all.length || failed) keep(out, { transcript, ...(where && { project: where }), ...(all.length && { findings: all }), ...(failed && { failed }) })
  else rmSync(out, { force: true })
}

const MONTH = 30 * 24 * 3600 * 1000

/** What `pendingScans` read, for `reported` to mark told. */
let taken = []

/**
 * What scans found since sessions last reported, each finding once: a session scanned after each turn (VS Code)
 * finds the same lines again, and only lines not told yet are reported. Nothing is marked told until `reported()`,
 * so a session start that fails on the way leaves them for the next.
 */
export function pendingScans(cwd) {
  taken = []
  const scans = join(data, 'scans')
  if (!existsSync(scans)) return []
  const seenDir = folder('seen')
  for (const name of readdirSync(seenDir)) {
    try {
      const file = join(seenDir, name)
      if (Date.now() - statSync(file).mtimeMs > MONTH) rmSync(file, { force: true })
    } catch {
      // Another session start forgot it first.
    }
  }
  const results = []
  for (const name of readdirSync(scans).filter((f) => f.endsWith('.json'))) {
    const file = join(scans, name)
    const text = textOf(file)
    let result
    try {
      result = JSON.parse(text)
    } catch {
      continue // taken by another session start
    }
    // A session of another project is told in that project, by a session there: not in one the developer may not read.
    if (result.project && cwd && result.project !== resolve(cwd)) continue
    const seenFile = join(seenDir, name)
    // A seen file that cannot be read tells again what it held, rather than nothing.
    const seen = read(seenFile)
    const told = new Set(Array.isArray(seen) ? seen : [])
    const findings = result.findings ?? []
    taken.push({ file, text, seenFile, told, findings })
    const fresh = findings.filter((f) => !told.has(key(f)))
    if (fresh.length || result.failed) {
      results.push({ transcript: result.transcript, ...(fresh.length && { findings: fresh }), ...(result.failed && { failed: result.failed }) })
    }
  }
  return results
}

/** Marks what `pendingScans` read as told. A result a scan added to since stays, for what it added. */
export function reported() {
  for (const { file, text, seenFile, told, findings } of taken) {
    if (findings.length) keep(seenFile, [...new Set([...told, ...findings.map(key)])])
    if (textOf(file) === text) rmSync(file, { force: true })
  }
  taken = []
}

/** What scans found, marked told at once. */
export function takeScans() {
  const results = pendingScans()
  reported()
  return results
}
