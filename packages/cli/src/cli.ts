#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs, styleText } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  clearRunning,
  createFaker,
  loadRules,
  NO_RULES,
  readRunning,
  RulesError,
  scan,
  serveMcp,
  sosieHome,
  Store,
  storeDir,
  storeDirs,
  writeRunning,
  type Rules,
  type Schema,
} from '@sosie/core'
import { loopback } from './listen.js'
import { hiddenPrompt } from './prompt.js'
import { sources } from './sources.js'

const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const USAGE = `Sosie: your AI agent sees a double of your data. Never the real thing.

Usage:
  sosie                 Start. Reads SOSIE_UPSTREAM, or asks for it.
  sosie mcp             MCP server over stdio, for every running sosie.
  sosie scan <path>...  Search files and folders for real values; exit 1 if one is found.

Options for sosie:
  --port <n>       Port to listen on (7674)
  --host <host>    Address to listen on (127.0.0.1)
  --rules <file>   Rules file (./sosie.yml when present)
  --max-rows <n>   Rows a query returns at most (1000)
  --timeout <s>    Seconds a statement or request may run upstream (30, at most 3600)

Environment:
  SOSIE_UPSTREAM          A database's connection string, or an API's base URL
  SOSIE_UPSTREAM_HEADERS  For an API: headers Sosie sends it, one 'Name: value'
                          per line, such as 'Authorization: Bearer ...'
  SOSIE_OPENAPI           For a REST API: its OpenAPI document, a file or URL
                          (otherwise Sosie looks for one at the usual paths)
  SOSIE_GRAPHQL_SCHEMA    For a GraphQL API without introspection, or at a path
                          without graphql in it: its SDL file, or a file of its
                          introspection result as JSON
  SOSIE_HOME              Where Sosie keeps its store (~/.sosie)

The upstream and its credentials are never arguments: arguments show in shell
history and the process list, where an agent can read them.
`

class Exit extends Error {
  constructor(
    readonly code: number,
    message = '',
  ) {
    super(message)
  }
}

const ok = (text: string) => `  ${styleText('green', '✓', { stream: process.stdout })} ${text}`
const warn = (text: string) => `  ${styleText('yellow', '!', { stream: process.stdout })} ${text}`
const fail = (text: string) => `  ${styleText('red', '✗', { stream: process.stderr })} ${text}`
const found = (text: string) => `  ${styleText('red', '✗', { stream: process.stdout })} ${text}`

async function main(argv: string[]): Promise<void> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        rules: { type: 'string' },
        'max-rows': { type: 'string' },
        timeout: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    })
  } catch (error) {
    throw new Exit(2, `${(error as Error).message}\n\n${USAGE}`)
  }
  const { values, positionals } = parsed
  if (values.help) return void process.stdout.write(USAGE)
  if (values.version) return void process.stdout.write(`${VERSION}\n`)
  const [command, ...rest] = positionals
  if (command === 'mcp') return mcp()
  if (command === 'scan') return scanCommand(rest)
  if (command !== undefined) throw new Exit(2, `Unknown command: ${command}\n\n${USAGE}`)
  return start({
    port: number(values.port, DEFAULT_PORT, '--port', 0, 65_535),
    portChosen: values.port !== undefined,
    host: values.host ?? '127.0.0.1',
    rules: values.rules,
    maxRows: number(values['max-rows'], 1000, '--max-rows', 1),
    timeout: number(values.timeout, 30, '--timeout', 1, 3600),
  })
}

function number(value: string | undefined, fallback: number, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `from ${min}` : `from ${min} to ${max}`
    throw new Exit(2, fail(`${name} takes a whole number ${range}, not ${value}.`))
  }
  return n
}

/* sosie */

const DEFAULT_PORT = 7674
/** Ports a Sosie started without --port tries, so a second one, for another upstream, just starts. */
const PORTS_TO_TRY = 10

async function start(options: {
  port: number
  portChosen: boolean
  host: string
  rules: string | undefined
  maxRows: number
  /** Seconds. */
  timeout: number
}): Promise<void> {
  const upstream = await readUpstream()
  // Until sosie.yml names the sources: the variables earlier versions read, as the settings sources now take.
  const env = process.env
  const headers = Object.fromEntries(
    (env.SOSIE_UPSTREAM_HEADERS ?? '').split(/\r?\n|\\n/).filter((l) => l.trim()).map((l) => [l.slice(0, Math.max(0, l.indexOf(':'))).trim(), l.slice(l.indexOf(':') + 1)]),
  )
  const schema = env.SOSIE_OPENAPI || env.SOSIE_GRAPHQL_SCHEMA || undefined
  const source = env.SOSIE_GRAPHQL_SCHEMA && /^https?:$/.test(upstream.protocol) ? sources.find((s) => s.kind === 'graphql') : sources.find((s) => s.matches(upstream))
  if (!source) {
    throw new Exit(2, fail(`Sosie reads postgres://, mysql:// and mongodb:// databases, and http:// or https:// APIs, for now; not ${upstream.protocol}//.`))
  }

  // A rules file that is not there is a usage error, told before Sosie connects; what it says is checked after, against
  // the schema.
  const rulesFile = options.rules ?? (existsSync('sosie.yml') ? 'sosie.yml' : undefined)
  if (rulesFile && !existsSync(rulesFile)) throw new Exit(2, fail(`No rules file at ${rulesFile}.`))

  let connection
  try {
    connection = await source.connect(upstream, { maxRows: options.maxRows, statementTimeout: options.timeout * 1000, headers, ...(schema && { schema }) })
  } catch (error) {
    throw new Exit(1, fail((error as Error).message))
  }

  let rules: Rules = NO_RULES
  if (rulesFile) {
    try {
      rules = loadRules(readFileSync(rulesFile, 'utf8'), connection.schema, rulesFile, { learns: !!connection.learns })
    } catch (error) {
      await connection.close()
      if (error instanceof RulesError) throw new Exit(1, error.problems.map(fail).join('\n'))
      throw error
    }
  }

  const home = sosieHome()
  const store = Store.open(storeDir(home))
  const faker = createFaker({ schema: connection.schema, rules, store })
  // What sosie mcp reads: written once the endpoint listens, and again as a source that learns its fields meets them.
  const startedAt = Date.now()
  let stopping = false
  let address = ''
  let grown: Schema | undefined
  let rewrite: NodeJS.Timeout | undefined
  const entry = (schema: Schema) => {
    const passing = new Set([...rules.pass, ...schema.entities.flatMap((e) => e.fields.filter((f) => faker.passes(f)).map((f) => f.id))])
    writeRunning(home, { kind: source.kind, address, schema, passing: [...passing] }, process.pid, startedAt)
  }
  const learned = (schema: Schema) => {
    grown = schema
    rewrite ??= setTimeout(() => {
      rewrite = undefined
      if (!stopping && grown) entry(grown)
    }, 200)
  }
  let endpoint
  for (let port = options.port; !endpoint; port++) {
    try {
      endpoint = await connection.serve({ host: options.host, port }, faker, connection.learns ? learned : undefined)
    } catch (error) {
      const busy = (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
      if (busy && !options.portChosen && port < options.port + PORTS_TO_TRY - 1) continue
      store.close()
      await connection.close()
      if (busy) throw new Exit(1, fail(`Port ${port} is in use. Is Sosie already running? Choose another with --port.`))
      throw error
    }
  }
  // Ctrl+C, a kill, or the terminal closing: each stops Sosie and leaves no running/ file behind, from before
  // the file is written and the address printed, so a client that starts on the address can stop it too.
  const stopped = new Promise<void>((done) => {
    const stop = async () => {
      stopping = true
      clearTimeout(rewrite)
      clearRunning(home)
      await endpoint.close()
      await connection.close()
      store.close()
      done()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    process.once('SIGHUP', stop)
  })
  address = endpoint.address
  entry(connection.schema)

  const passing = rules.pass.size
  const lines = [
    '',
    ok(`${connection.label}, read-only: ${connection.summary}`),
    ok(passing ? `Every value is faked; ${passing} ${passing === 1 ? 'field passes' : 'fields pass'} (${rulesFile})` : 'Every value is faked'),
    ...connection.warnings.map(warn),
    ...rules.warnings.map(warn),
    ...(loopback(options.host)
      ? []
      : [warn(`Listening on ${options.host}, with no password: anyone who can reach it can query the fakes and filter on the real values.`)]),
    '',
    ...banner([
      [`Your agent, app and ${connection.client ?? 'tools'}:`, endpoint.address],
      ['Claude Code:', 'claude plugin marketplace add monkilabs/sosie'],
      ['', 'claude plugin install sosie@sosie'],
      ['Any MCP client:', 'npx @sosie/cli mcp'],
    ]),
    '',
  ]
  process.stdout.write(lines.join('\n') + '\n')
  await stopped
}

/** Labels and what they say, in two columns: the second starts one space past the longest label, at 29 at least. */
function banner(rows: [string, string][]): string[] {
  const width = Math.max(27, ...rows.map(([label]) => label.length + 1))
  return rows.map(([label, text]) => `  ${label.padEnd(width)}${text}`)
}

/** SOSIE_UPSTREAM, or a hidden prompt in a terminal. Never an argument, never echoed. */
async function readUpstream(): Promise<URL> {
  let text = process.env.SOSIE_UPSTREAM
  if (!text) {
    if (!process.stdin.isTTY) {
      throw new Exit(2, fail("Set SOSIE_UPSTREAM to your database's connection string or your API's base URL, or run sosie in a terminal to type it."))
    }
    try {
      text = await hiddenPrompt('  Connection string (hidden): ', process.stdin, process.stdout)
    } catch (error) {
      throw new Exit(2, fail((error as Error).message))
    }
  }
  // A replica set's string may list its hosts, with ports (no URL) or without (a URL whose host is h1,h2): one is
  // enough, as the driver finds the others from it.
  if (/^mongodb:\/\/[^/?#]*,/.test(text)) {
    throw new Exit(2, fail('Give one host of the replica set, with its replicaSet option: mongodb://user:password@host:27017/database?replicaSet=rs0. The driver finds the others.'))
  }
  try {
    return new URL(text)
  } catch {
    throw new Exit(
      2,
      fail('The upstream is not a URL. It looks like postgres://user:password@host:5432/database, or https://api.example.com/v1.'),
    )
  }
}

/* sosie mcp */

/** Set once the MCP server serves: it runs on stdio until its client closes, so main's end is not the process's. */
let serving = false

async function mcp(): Promise<void> {
  serving = true
  const home = sosieHome()
  await serveMcp({
    version: VERSION,
    tools: sources.flatMap((s) => (s.tools ?? []).map((tool) => ({ kind: s.kind, tool }))),
    running: async () => readRunning(home),
    transport: new StdioServerTransport(),
  })
}

/* sosie scan */

async function scanCommand(paths: string[]): Promise<void> {
  if (!paths.length) throw new Exit(2, `Name the files or folders to scan.\n\n${USAGE}`)
  for (const path of paths) if (!existsSync(path)) throw new Exit(2, fail(`No such file or folder: ${path}`))
  const dirs = storeDirs(sosieHome())
  if (!dirs.length) throw new Exit(2, fail('Nothing to compare with: Sosie has not faked any values on this machine yet.'))
  const stores = dirs.map((dir) => Store.open(dir, { create: false }))
  const result = await scan(
    paths.map((p) => resolve(p)),
    stores.map((s) => s.scanIndex()),
  )
  for (const store of stores) store.close()

  const files = `${result.files} ${result.files === 1 ? 'file' : 'files'}`
  for (const f of result.findings) process.stdout.write(`${found(`${f.file}:${f.line}`)}  a real value from ${f.domain}\n`)
  if (result.findings.length) {
    const n = result.findings.length
    process.stdout.write(`  ${n} real ${n === 1 ? 'value' : 'values'} found in ${files}.\n`)
    throw new Exit(1)
  }
  process.stdout.write(`${ok(`No real values found in ${files}.`)}\n`)
}

main(process.argv.slice(2)).then(
  () => {
    // By the command parsed, not by the first argument: `sosie --rules x mcp` serves MCP too.
    if (!serving) process.exit(0)
  },
  (error) => {
    if (error instanceof Exit) {
      if (error.message) process.stderr.write(`${error.message}\n`)
      process.exit(error.code)
    }
    process.stderr.write(`${fail((error as Error).stack ?? String(error))}\n`)
    process.exit(1)
  },
)
