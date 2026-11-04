// What the plugin's hooks read of Sosie, the files it writes for `sosie mcp` and its stores, never a value; and where
// they keep what a scan found until a session reports it. Claude Code, Copilot CLI and VS Code run them alike.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
 * subagents' transcripts and long tool results. Copilot CLI says where neither is: its session lives in
 * $COPILOT_HOME (or ~/.copilot) under session-state/, as a folder of its id, or a file in older versions.
 */
export function sessionFiles({ session_id: session, transcript_path: transcript }, env = process.env) {
  if (transcript) {
    const beside = transcript.replace(/\.jsonl$/, '')
    return [transcript, ...(beside !== transcript ? [beside] : [])].filter((p) => existsSync(p))
  }
  if (!env.COPILOT_PLUGIN_DATA || !/^[\w-]+$/.test(String(session ?? ''))) return []
  const state = join(env.COPILOT_HOME || join(homedir(), '.copilot'), 'session-state')
  return [join(state, session), join(state, `${session}.jsonl`)].filter((p) => existsSync(p))
}

/** A session's id, safe as a file name. */
const named = (session) => String(session ?? 'unknown').replace(/[^\w-]/g, '_')

function folder(name) {
  const dir = join(data, name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Where a session's scan keeps what it found, and its lock: one scan of a session at a time. */
export function scanPaths(session) {
  const dir = folder('scans')
  const base = join(dir, named(session))
  return { out: `${base}.json`, lock: `${base}.lock`, again: `${base}.again` }
}

/** Whether a scan of this session is running now: one that ends a turn while it does asks it to run once more. */
export function scanning(paths) {
  try {
    return alive(Number(readFileSync(paths.lock, 'utf8')))
  } catch {
    return false
  }
}

export function keep(file, result) {
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
}

const MONTH = 30 * 24 * 3600 * 1000

/**
 * What scans found since sessions last reported, each finding once: a session scanned after each turn (VS Code)
 * finds the same lines again, and only lines not told yet are reported.
 */
export function takeScans() {
  const scans = join(data, 'scans')
  if (!existsSync(scans)) return []
  const seenDir = folder('seen')
  for (const name of readdirSync(seenDir)) {
    const file = join(seenDir, name)
    if (Date.now() - statSync(file).mtimeMs > MONTH) rmSync(file, { force: true })
  }
  const results = []
  for (const name of readdirSync(scans).filter((f) => f.endsWith('.json'))) {
    const file = join(scans, name)
    let result
    try {
      result = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue // still being written
    }
    rmSync(file, { force: true })
    const seenFile = join(seenDir, name)
    const seen = new Set(existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, 'utf8')) : [])
    const key = (f) => `${f.file}:${f.line}:${f.field}`
    const fresh = (result.findings ?? []).filter((f) => !seen.has(key(f)))
    if (result.findings?.length) keep(seenFile, [...seen, ...fresh.map(key)])
    if (fresh.length) results.push({ ...result, findings: fresh })
    else if (result.failed) results.push(result)
  }
  return results
}
