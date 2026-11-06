#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  clearRunning,
  ConfigError,
  createFaker,
  headerVariables,
  interpolate,
  readConfig,
  readRunning,
  RulesError,
  rulesFor,
  scan,
  serveMcp,
  settingsProblems,
  sosieHome,
  Store,
  storeDir,
  storeDirs,
  unheldRules,
  unmetRules,
  variablesOf,
  writeRunning,
  type Config,
  type Connection,
  type Endpoint,
  type Running,
  type Schema,
  type Source,
  type SourceConfig,
  type SourceRules,
} from '@sosie/core'
import { allow, unallowed } from './allowed.js'
import { init, labelOf, sourceFor, upstreamUrl } from './init.js'
import { loopback } from './listen.js'
import { columns, fail, found, ok, warn } from './print.js'
import { hiddenPrompt, prompt } from './prompt.js'
import { serveAll } from './serve.js'
import { sources } from './sources.js'

const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const USAGE = `Sosie: your AI agent sees a double of your data. Never the real thing.

Usage:
  sosie                 Start every source sosie.yml names. Without a sosie.yml, write one first.
  sosie init            Write sosie.yml, with the first source.
  sosie mcp             MCP server over stdio, for every running sosie.
  sosie scan <path>...  Search files and folders for real values; exit 1 if one is found.

sosie.yml, in the folder Sosie starts in, is all there is to set:

  sources:
    shop:
      upstream: \${SHOP_URL}

Each upstream is read from the variable it names, set in your terminal, or asked
for at a hidden prompt: never an argument, never written in sosie.yml.
https://monkilabs.github.io/sosie/docs/configuration/
`

/** What earlier versions read, and what in sosie.yml says it now. */
const GONE_VARIABLES: Record<string, string> = {
  SOSIE_UPSTREAM: "a source's upstream: upstream: ${SOSIE_UPSTREAM} reads it",
  SOSIE_UPSTREAM_HEADERS: "a source's headers",
  SOSIE_OPENAPI: "a source's schema",
  SOSIE_GRAPHQL_SCHEMA: "a source's schema, with kind: graphql",
}
const GONE_FLAGS: Record<string, string> = {
  port: 'port, under a source',
  host: 'host',
  rules: 'pass and format, in sosie.yml itself',
  'max-rows': 'max-rows',
  timeout: 'timeout',
}

class Exit extends Error {
  constructor(
    readonly code: number,
    message = '',
  ) {
    super(message)
  }
}

async function main(argv: string[]): Promise<void> {
  // A flag of an earlier version is said to be in sosie.yml now, not refused as unknown.
  for (const arg of argv) {
    const flag = /^--([a-z-]+)(=|$)/.exec(arg)?.[1]
    if (flag && GONE_FLAGS[flag]) throw new Exit(2, fail(`--${flag} is in sosie.yml now: ${GONE_FLAGS[flag]}.`))
  }
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } },
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
  if (command === 'init') return initCommand()
  if (command !== undefined) throw new Exit(2, `Unknown command: ${command}\n\n${USAGE}`)
  return start()
}

/* sosie init */

const FILE = 'sosie.yml'

const EXAMPLE = `  sources:
    shop:
      upstream: \${SHOP_URL}     # set SHOP_URL in your terminal, never here
`

/** Write sosie.yml with its first source. Starting, the string typed is kept in `typed`, for this run only. */
async function initCommand(typed?: Record<string, string>): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Exit(2, `${fail('sosie init asks for the first source at a hidden prompt: run it in a terminal, or write sosie.yml yourself:')}\n\n${EXAMPLE}`)
  }
  try {
    const written = await init(resolve(FILE), { input: process.stdin, output: process.stdout }, sources)
    if (typed) typed[written.variable] = written.value
    else process.stdout.write('    Start Sosie with npx @sosie/cli.\n')
  } catch (error) {
    if (error instanceof ConfigError) throw new Exit(1, error.problems.map(fail).join('\n'))
    throw new Exit(2, fail((error as Error).message))
  }
}

/* sosie */

/** A source of sosie.yml, its upstream read and its kind's source found. */
interface Plan {
  config: SourceConfig
  source: Source
  upstream: URL
  headers: Record<string, string>
}

async function start(): Promise<void> {
  // Without a sosie.yml, or one that names no sources, its first source is asked for, then Sosie starts with it.
  const file = resolve(FILE)
  const typed: Record<string, string> = {}
  if (!existsSync(file) || noSources(file)) {
    if (!process.stdin.isTTY) {
      const why = existsSync(file) ? 'sosie.yml names no sources.' : 'There is no sosie.yml here.'
      const hint = process.env.SOSIE_UPSTREAM ? '\n  SOSIE_UPSTREAM is set: upstream: ${SOSIE_UPSTREAM} reads it.\n' : ''
      throw new Exit(2, `${fail(`${why} Run sosie init in a terminal, or write it:`)}\n\n${EXAMPLE}${hint}`)
    }
    await initCommand(typed)
  }

  let config: Config
  try {
    config = readConfig(readFileSync(file, 'utf8'), file, sources)
  } catch (error) {
    if (error instanceof ConfigError) throw new Exit(1, error.problems.map(fail).join('\n'))
    throw error
  }
  // A variable an earlier version read, left set, is told; not one sosie.yml reads, as upgrading says to.
  const read = variablesOf(config)
  const notes = Object.entries(GONE_VARIABLES)
    .filter(([name]) => process.env[name] && !read.includes(name))
    .map(([name, now]) => `${name} is not read any more: sosie.yml says it, as ${now}.`)

  const values = await readVariables(config, typed)
  const plans = planSources(config, values)
  await askToSend(file, plans)

  const connections: Connection[] = []
  const closeAll = async () => {
    for (const connection of connections) await connection.close().catch(() => {})
  }
  for (const plan of plans) {
    try {
      connections.push(await plan.source.connect(plan.upstream, optionsOf(plan)))
    } catch (error) {
      await closeAll()
      throw new Exit(1, fail(`${plan.config.name}: ${(error as Error).message}`))
    }
  }

  const rules: SourceRules[] = []
  const problems: string[] = []
  // The top's rules each source holds, its own rules right or wrong: one that no source holds is told with the rest.
  const held: Set<string>[] = []
  plans.forEach((plan, i) => {
    const connection = connections[i]!
    try {
      rules.push(rulesFor(connection.schema, { own: plan.config.rules, shared: config.rules, file: FILE, source: plan.config.name, learns: !!connection.learns }))
      held.push(rules.at(-1)!.applied)
    } catch (error) {
      if (!(error instanceof RulesError)) throw error
      problems.push(...error.problems)
      if (error.applied) held.push(error.applied)
    }
  })
  problems.push(...unheldRules(config.rules, held, FILE))
  if (problems.length) {
    await closeAll()
    throw new Exit(1, problems.map(fail).join('\n'))
  }

  const home = sosieHome()
  const store = Store.open(storeDir(home))
  const fakers = plans.map((_, i) => createFaker({ schema: connections[i]!.schema, rules: rules[i]!, store }))

  // What sosie mcp reads: written once every endpoint listens, and again as a source that learns its fields meets them.
  const startedAt = Date.now()
  const schemas = connections.map((c) => c.schema)
  const addresses: string[] = []
  let stopping = false
  let rewrite: NodeJS.Timeout | undefined
  const entry = () => {
    const running: Running[] = plans.map((plan, i) => {
      const passing = new Set([...rules[i]!.pass, ...schemas[i]!.entities.flatMap((e) => e.fields.filter((f) => fakers[i]!.passes(f)).map((f) => f.id))])
      return { name: plan.config.name, kind: plan.source.kind, address: addresses[i]!, schema: schemas[i]!, passing: [...passing] }
    })
    writeRunning(home, running, process.pid, startedAt)
  }
  const learned = (i: number) => (schema: Schema) => {
    schemas[i] = schema
    rewrite ??= setTimeout(() => {
      rewrite = undefined
      if (!stopping && addresses.length) entry()
    }, 200)
  }

  let endpoints: Endpoint[]
  try {
    endpoints = await serveAll(
      plans.map((plan, i) => ({
        name: plan.config.name,
        port: plan.config.port,
        listen: (port: number) => connections[i]!.serve({ host: plan.config.host, port }, fakers[i]!, connections[i]!.learns ? learned(i) : undefined),
      })),
    )
  } catch (error) {
    store.close()
    await closeAll()
    throw new Exit(1, fail((error as Error).message))
  }
  // Ctrl+C, a kill, or the terminal closing: each stops Sosie and leaves no running/ file behind, from before
  // the file is written and the addresses printed, so a client that starts on an address can stop it too.
  const stopped = new Promise<void>((done) => {
    const stop = async () => {
      stopping = true
      clearTimeout(rewrite)
      clearRunning(home)
      for (const endpoint of endpoints) await endpoint.close()
      await closeAll()
      store.close()
      done()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    process.once('SIGHUP', stop)
  })
  addresses.push(...endpoints.map((e) => e.address))
  entry()

  const width = Math.max(...plans.map((p) => p.config.name.length))
  // Fields each source has: a rule kept for fields a source may meet later passes none yet.
  const passing = rules.reduce((n, r, i) => n + schemas[i]!.entities.reduce((m, e) => m + e.fields.filter((f) => r.pass.has(f.id)).length, 0), 0)
  const hosts = [...new Set(plans.map((p) => p.config.host))].filter((host) => !loopback(host))
  const lines = [
    '',
    ...plans.map((plan, i) => ok(`${plan.config.name.padEnd(width)}  ${connections[i]!.label}, read-only: ${connections[i]!.summary}`)),
    ok(passing ? `Every value is faked; ${passing} ${passing === 1 ? 'field passes' : 'fields pass'} (${FILE})` : 'Every value is faked'),
    ...plans.flatMap((plan, i) => connections[i]!.warnings.map((w) => warn(`${plan.config.name}: ${w}`))),
    ...rules.flatMap((r) => r.warnings).map(warn),
    ...unmetRules(rules, FILE).map(warn),
    ...notes.map(warn),
    ...hosts.map((host) => warn(`Listening on ${host}, with no password: anyone who can reach it can query the fakes and filter on the real values.`)),
    '',
    ...columns([
      ...plans.map((plan, i): [string, string] => [`${plan.config.name}:`, endpoints[i]!.address]),
      ['Claude Code:', 'claude plugin marketplace add monkilabs/sosie'],
      ['', 'claude plugin install sosie@sosie'],
      ['Any MCP client:', 'npx @sosie/cli mcp'],
    ]),
    '',
  ]
  process.stdout.write(lines.join('\n') + '\n')
  await stopped
}

/**
 * Whether sosie.yml has no sources key and nothing else wrong, so that its first source is still to be written. One
 * with something else wrong (a sources key misspelt) is told when it is read, never written a second.
 */
function noSources(file: string): boolean {
  try {
    readConfig(readFileSync(file, 'utf8'), file, sources)
    return false
  } catch (error) {
    return error instanceof ConfigError && error.unwritten
  }
}

/** Every variable sosie.yml names: from the terminal's environment, or asked for at a hidden prompt. Never echoed. */
async function readVariables(config: Config, typed: Record<string, string>): Promise<Record<string, string>> {
  const values: Record<string, string> = {}
  const missing: string[] = []
  for (const name of variablesOf(config)) {
    const value = typed[name] ?? process.env[name]
    if (value) values[name] = value
    else missing.push(name)
  }
  if (!missing.length) return values
  if (!process.stdin.isTTY) {
    const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}`
    throw new Exit(2, fail(`Set ${list}, which sosie.yml names, in the terminal Sosie starts in, or start it in a terminal to type ${missing.length === 1 ? 'it' : 'them'}.`))
  }
  for (const name of missing) {
    try {
      values[name] = await hiddenPrompt(`  ${name} (hidden): `, process.stdin, process.stdout)
    } catch (error) {
      throw new Exit(2, fail((error as Error).message))
    }
  }
  return values
}

/**
 * A source that sends a variable it has not sent to its upstream before, as sosie.yml now says, is asked about before
 * anything is sent: an agent may edit sosie.yml, and have a header carry another of the terminal's variables, or send
 * one to a host another variable holds. Once allowed, this machine remembers it; without a terminal, Sosie stops.
 */
async function askToSend(file: string, plans: Plan[]): Promise<void> {
  const home = sosieHome()
  const asked = unallowed(home, file, plans.map((p) => p.config))
  if (!asked.length) return
  let count = 0
  const lines = asked.map((config) => {
    const plan = plans.find((p) => p.config === config)!
    const sent = Object.entries(config.headers).flatMap(([header, template]) => {
      const names = headerVariables(template)
      count += names.length
      return names.length ? [`${names.join(' and ')}, in ${header}`] : []
    })
    return `    ${config.name} sends ${sent.join('; ')}, to ${labelOf(plan.upstream)} (${config.upstream}).`
  })
  const what = 'sosie.yml has a source send a variable it has not sent to its upstream before'
  if (!process.stdin.isTTY) throw new Exit(2, [fail(`${what}, and there is no terminal to ask in. Start Sosie in a terminal once to allow it:`), ...lines].join('\n'))
  process.stdout.write(`${[warn(`${what}:`), ...lines].join('\n')}\n`)
  let answer: string
  try {
    answer = await prompt(`  Send ${count === 1 ? 'it' : 'them'}? (y/N) `, process.stdin, process.stdout)
  } catch (error) {
    throw new Exit(2, fail((error as Error).message))
  }
  if (!/^y(es)?$/i.test(answer)) throw new Exit(1, fail('Nothing sent.'))
  allow(home, file, plans.map((p) => p.config))
}

/** Each source's upstream read, its kind's source found, its headers' variables filled in: every problem at once. */
function planSources(config: Config, values: Record<string, string>): Plan[] {
  const plans: Plan[] = []
  const problems: string[] = []
  for (const source of config.sources) {
    let upstream: URL
    let kind: Source
    try {
      upstream = upstreamUrl(values[source.upstream]!)
    } catch (error) {
      // Never the value: it may hold a credential.
      problems.push(`${FILE}: sources.${source.name}: ${source.upstream}: ${(error as Error).message.replace(/^That is/, 'it is')}`)
      continue
    }
    try {
      kind = sourceFor(upstream, source.kind, sources)
    } catch (error) {
      problems.push(`${FILE}: sources.${source.name}: ${(error as Error).message}`)
      continue
    }
    problems.push(...settingsProblems(source, kind, FILE))
    const headers = Object.fromEntries(Object.entries(source.headers).map(([name, template]) => [name, interpolate(template, values)]))
    plans.push({ config: source, source: kind, upstream, headers })
  }
  if (problems.length) throw new Exit(1, problems.map(fail).join('\n'))
  return plans
}

const optionsOf = (plan: Plan) => ({
  maxRows: plan.config.maxRows,
  statementTimeout: plan.config.timeout * 1000,
  headers: plan.headers,
  ...(plan.config.schema && { schema: plan.config.schema }),
})

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

/**
 * End with this exit code by letting the event loop run dry, never by process.exit() alone: that joins V8's worker
 * threads while one may be waiting on the main thread, and can hang there for good (nodejs/node#54918). A command
 * that left a handle open would keep running, so after a second process.exit() ends it all the same.
 */
function end(code: number): void {
  process.exitCode = code
  setTimeout(() => process.exit(code), 1000).unref()
}

main(process.argv.slice(2)).then(
  () => {
    // By the command parsed, not by the first argument: `sosie -v mcp` is the version, `sosie mcp` serves.
    if (!serving) end(0)
  },
  (error) => {
    if (error instanceof Exit) {
      if (error.message) process.stderr.write(`${error.message}\n`)
      return end(error.code)
    }
    process.stderr.write(`${fail((error as Error).stack ?? String(error))}\n`)
    end(1)
  },
)
