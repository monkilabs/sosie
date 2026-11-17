import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { ConfigError, isSourceName, noSourcesProblem, readConfig, sourceNames, variableFor, type Source } from '@sosie/core'
import { fail, ok } from './print.js'
import { hiddenPrompt, prompt } from './prompt.js'

/** Where a terminal's answers come from, and where its questions go. */
export interface Terminal {
  input: Parameters<typeof prompt>[1]
  output: NodeJS.WritableStream
}

/** The first source written: its name, the variable that holds its upstream, and the string typed, for this run only. */
export interface Written {
  name: string
  variable: string
  value: string
}

const HEADER = `# Sosie: this project's sources, and how their values are faked.
# https://monkilabs.github.io/sosie/docs/configuration/
# Each upstream is read from the variable it names, set in your terminal: never write a connection string here.
`

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * sosie init: the first source, its connection string asked for at a hidden prompt, then a name for it and the
 * variable to keep the string in; sosie.yml written with them, never with the string. A sosie.yml that names no
 * sources yet (rules only, as earlier versions wrote) gets the source added, its rules kept.
 */
export async function init(file: string, terminal: Terminal, sources: Source[]): Promise<Written> {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : undefined
  if (existing !== undefined) {
    const names = sourceNames(existing)
    if (names?.length) throw new Error(`sosie.yml names its sources already: ${names.join(', ')}. Add another under sources:.`)
    // Anything else wrong is told, as starting tells it, and nothing written: a sources key misspelt would end up
    // beside a second one. Not that it names no sources, or to run sosie init: that is what runs.
    try {
      readConfig(existing, file, sources)
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error
      if (!error.unwritten) throw new ConfigError(error.problems.filter((p) => p !== noSourcesProblem()))
    }
  }
  const say = (line = '') => terminal.output.write(`${line}\n`)
  say()
  say(existing === undefined ? '  No sosie.yml here yet: one, with the first database or API Sosie reads.' : '  sosie.yml names no sources yet: the first, a database or an API.')
  say()

  let url: URL | undefined
  let source: Source | undefined
  let value = ''
  for (let tries = 0; !source; tries++) {
    value = await hiddenPrompt("  Its connection string, or the API's URL (hidden): ", terminal.input, terminal.output)
    try {
      url = upstreamUrl(value)
      source = sourceFor(url, undefined, sources)
    } catch (error) {
      say(fail((error as Error).message))
      if (tries >= 2) throw new Error('Nothing written.')
    }
  }
  say(ok(`A ${source.title}: ${labelOf(url!)}`))

  const suggested = suggestName(url!, source)
  let name = ''
  while (!name) {
    const answer = (await prompt(`  A name for it (${suggested}): `, terminal.input, terminal.output)) || suggested
    if (isSourceName(answer)) name = answer
    else say(fail('A source is named in lowercase letters, digits, - and _, a letter first.'))
  }
  const fallback = variableFor(name)
  let variable = ''
  while (!variable) {
    const answer = (await prompt(`  The variable to keep it in (${fallback}): `, terminal.input, terminal.output)) || fallback
    if (VARIABLE.test(answer)) variable = answer
    else say(fail('A variable is named in letters, digits and _, not a digit first.'))
  }

  const block = `sources:\n  ${name}:\n    upstream: \${${variable}}\n`
  // An empty sosie.yml is written as a new one is, with its header.
  writeFileSync(file, !existing?.trim() ? `${HEADER}${block}` : `${existing}${existing.endsWith('\n') ? '' : '\n'}\n${block}`)
  say(ok(`Wrote sosie.yml: ${name}, its upstream read from \${${variable}}, never written there. Commit it.`))
  say(`    Set ${variable} in your terminal, and Sosie starts without asking for it.`)
  return { name, variable, value }
}

/** A connection string or base URL, as a URL. Never quoted when it is none: it may hold a credential. */
export function upstreamUrl(text: string): URL {
  // A replica set's string may list its hosts, with ports (no URL) or without (a URL whose host is h1,h2): one is
  // enough, as the driver finds the others from it.
  if (/^mongodb:\/\/[^/?#]*,/.test(text)) {
    throw new Error('Give one host of the replica set, with its replicaSet option: mongodb://user:password@host:27017/database?replicaSet=rs0. The driver finds the others.')
  }
  const none = new Error('That is not a URL. It looks like postgres://user:password@host:5432/database, or https://api.example.com/v1.')
  // SQL Server's connection strings are seldom URLs: ADO.NET's, JDBC's and Prisma's are read as the URL they stand for.
  const sqlServer = sqlServerUrl(text)
  if (sqlServer) return sqlServer
  // new URL() reads kim:secret@db, or localhost:5432/db, as a scheme and a path: the scheme said would quote the user
  // name or the host. Every upstream has // after its scheme.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) throw none
  try {
    return new URL(text)
  } catch {
    throw none
  }
}

/** ADO.NET's and ODBC's names for each part of a SQL Server's connection string, and JDBC's and Prisma's. */
const SQL_SERVER_KEYS: Record<string, 'server' | 'database' | 'user' | 'password' | 'encrypt' | 'trust' | 'certificateHost' | 'intent'> = {
  server: 'server',
  'data source': 'server',
  address: 'server',
  addr: 'server',
  'network address': 'server',
  servername: 'server',
  database: 'database',
  'initial catalog': 'database',
  databasename: 'database',
  'user id': 'user',
  userid: 'user',
  uid: 'user',
  user: 'user',
  username: 'user',
  password: 'password',
  pwd: 'password',
  encrypt: 'encrypt',
  trustservercertificate: 'trust',
  'trust server certificate': 'trust',
  hostnameincertificate: 'certificateHost',
  'host name in certificate': 'certificateHost',
  applicationintent: 'intent',
  'application intent': 'intent',
}

/**
 * A SQL Server connection string as the sqlserver:// URL the source reads: ADO.NET's and ODBC's (Server=host,1433;
 * Database=app;User Id=kim;Password=…), JDBC's (jdbc:sqlserver://host:1433;databaseName=app;…) and Prisma's
 * (sqlserver://host:1433;database=app;…). Undefined for anything else. Never quoted: it holds a password.
 */
export function sqlServerUrl(text: string): URL | undefined {
  const trimmed = text.trim()
  const prefixed = /^(?:jdbc:)?(?:sqlserver|mssql):\/\/([^;/?]*)(;.*)?$/i.exec(trimmed)
  if (!prefixed && (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || !/(^|;)\s*(server|data source|address|addr|network address)\s*=/i.test(trimmed))) return undefined
  if (prefixed && !prefixed[2] && !/^jdbc:/i.test(trimmed)) return undefined
  const parts: Partial<Record<(typeof SQL_SERVER_KEYS)[string], string>> = {}
  let host = prefixed?.[1] ?? ''
  const settings = prefixed ? (prefixed[2] ?? '') : trimmed
  for (const piece of splitSettings(settings)) {
    const at = piece.indexOf('=')
    if (at < 0) continue
    const key = SQL_SERVER_KEYS[piece.slice(0, at).trim().toLowerCase()]
    if (key) parts[key] = unquote(piece.slice(at + 1).trim())
  }
  host = parts.server ?? host
  const server = /^(?:tcp:)?\[?([^\]\\,]*?)\]?(?:\\([^,]*))?(?:[,:](\d+))?$/i.exec(host)
  if (!server || !server[1]) throw new Error('That connection string names no server. It looks like Server=host,1433;Database=app;User Id=kim;Password=….')
  if (server[2] && !server[3]) throw new Error("Give the named instance's port: Server=host,1433. Sosie does not ask SQL Browser where an instance is.")
  const url = new URL('sqlserver://localhost')
  url.hostname = server[1].includes(':') ? `[${server[1]}]` : server[1]
  url.port = server[3] ?? '1433'
  url.pathname = `/${encodeURIComponent(parts.database ?? '')}`
  url.username = encodeURIComponent(parts.user ?? '')
  url.password = encodeURIComponent(parts.password ?? '')
  if (parts.encrypt) url.searchParams.set('encrypt', parts.encrypt.toLowerCase())
  if (parts.trust) url.searchParams.set('trustServerCertificate', /^(true|yes)$/i.test(parts.trust) ? 'true' : 'false')
  if (parts.certificateHost) url.searchParams.set('hostNameInCertificate', parts.certificateHost)
  if (parts.intent) url.searchParams.set('applicationIntent', parts.intent)
  return url
}

/** Settings split at their semicolons, a value in braces or quotes kept whole. */
function splitSettings(text: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      current += ch
      if (ch === quote) {
        if (text[i + 1] === quote) current += text[++i]
        else quote = undefined
      }
    } else if (ch === ';') {
      if (current.trim()) out.push(current)
      current = ''
    } else {
      if ((ch === '"' || ch === "'" || ch === '{') && current.trim().endsWith('=')) quote = ch === '{' ? '}' : ch
      current += ch
    }
  }
  if (current.trim()) out.push(current)
  return out
}

function unquote(value: string): string {
  const m = /^(["'])([\s\S]*)\1$/.exec(value) ?? /^\{([\s\S]*)\}$/.exec(value)
  if (!m) return value
  return m.length === 3 ? m[2]!.replaceAll(m[1]! + m[1]!, m[1]!) : m[1]!.replaceAll('}}', '}')
}

/** The source of a kind, or the one that reads the URL; the kind's must read its scheme. */
export function sourceFor(url: URL, kind: string | undefined, sources: Source[]): Source {
  const source = kind ? sources.find((s) => s.kind === kind) : sources.find((s) => s.matches(url))
  if (source && (!kind || source.schemes.includes(url.protocol))) return source
  const schemes = [...new Set(sources.flatMap((s) => s.schemes))].map((s) => `${s}//`)
  if (kind) throw new Error(`A ${kind} source reads ${source!.schemes.map((s) => `${s}//`).join(' or ')} upstreams, not ${url.protocol}//.`)
  throw new Error(`Sosie reads ${schemes.slice(0, -1).join(', ')} and ${schemes.at(-1)} upstreams, for now; not ${url.protocol}//.`)
}

/** Where an upstream is, without its credentials: db.internal:5432/shop. */
export const labelOf = (url: URL) => `${url.host}${url.pathname.replace(/\/$/, '')}`

/** A name for a source: the database's, or the API's host's first word that says something; else its kind. */
function suggestName(url: URL, source: Source): string {
  const clean = (text: string) => text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').replace(/[-_]+$/, '').slice(0, 40)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    const database = clean(decodeURIComponent(url.pathname.split('/').find(Boolean) ?? ''))
    if (database) return database
  } else if (!url.hostname.startsWith('[')) {
    const word = url.hostname.split('.').find((part) => !/^(api|www|localhost|\d.*)$/i.test(part))
    const named = clean(word ?? '')
    if (named) return named
  }
  return source.kind
}
