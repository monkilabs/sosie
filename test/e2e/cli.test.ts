import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { startApi, TOKEN } from './api.js'
import { canariesIn } from './canaries.js'
import { SDL, startGraphql } from './graphql-api.js'

const CLI = fileURLToPath(new URL('../../packages/cli/dist/cli.js', import.meta.url))
const VERSION: string = JSON.parse(readFileSync(new URL('../../packages/cli/package.json', import.meta.url), 'utf8')).version
if (!existsSync(CLI)) throw new Error('Build the packages first: npm run build')

const env = (more: Record<string, string | undefined> = {}) => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, NO_COLOR: '1', ...more })) if (v !== undefined) out[k] = v
  return out
}

/**
 * Node's flags that have the CLI take its stdin, a pipe, for a terminal. A pipe has no raw mode, so the CLI reads
 * each answer as a line, as it does when typed ahead.
 */
const TERMINAL = ['--import', 'data:text/javascript,process.stdin.isTTY=true']

/**
 * Run the CLI to the end, within 20 s: spawnSync holds the test's thread, where no test timeout can fire, so one
 * that never ends is killed and fails the test with what it printed. With `typed`, it runs in a terminal, these lines
 * typed in it.
 */
function run(args: string[], more: Record<string, string | undefined> = {}, cwd?: string, typed?: string) {
  const flags = typed === undefined ? [] : TERMINAL
  const result = spawnSync(process.execPath, [...flags, CLI, ...args], { env: env(more), encoding: 'utf8', cwd, input: typed ?? '', timeout: 20_000, killSignal: 'SIGKILL' })
  if (result.error || result.signal) {
    throw new Error(`sosie ${args.join(' ')} did not end: ${result.error?.message ?? result.signal}\n${result.stdout}${result.stderr}`)
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * Run the CLI to the end without holding the test's thread, within 20 s. One that does not end is asked for Node's
 * diagnostic report before it is killed, and fails the test with where it was: its JavaScript stack, and what kept it
 * waiting. No report at all means it was held in native code, outside JavaScript.
 */
async function watched(args: string[], more: Record<string, string | undefined> = {}, cwd?: string) {
  const reports = mkdtempSync(join(tmpdir(), 'sosie-report-'))
  const child = spawn(process.execPath, ['--report-on-signal', '--report-signal=SIGUSR2', `--report-directory=${reports}`, CLI, ...args], {
    env: env(more),
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))
  const status = await new Promise<number | null | 'late'>((resolve) => {
    const timer = setTimeout(() => resolve('late'), 20_000)
    child.on('exit', (code) => (clearTimeout(timer), resolve(code)))
  })
  if (status !== 'late') return { status, stdout, stderr }
  child.kill('SIGUSR2')
  await new Promise((r) => setTimeout(r, 3000))
  const [file] = readdirSync(reports)
  // On Linux, what the process is doing, as the kernel sees it: running or asleep, on what, with which files open.
  const proc = (path: string) => {
    try {
      return readFileSync(`/proc/${child.pid}/${path}`, 'utf8').trim()
    } catch {
      return ''
    }
  }
  const tasks = (() => {
    try {
      return readdirSync(`/proc/${child.pid}/task`).map((t) => `${t}: ${proc(`task/${t}/stat`).split(') ')[1]?.split(' ')[0] ?? '?'} ${proc(`task/${t}/wchan`)} ${proc(`task/${t}/comm`)}`)
    } catch {
      return []
    }
  })()
  const fds = (() => {
    try {
      return readdirSync(`/proc/${child.pid}/fd`).map((fd) => {
        try {
          return readlinkSync(`/proc/${child.pid}/fd/${fd}`)
        } catch {
          return fd
        }
      })
    } catch {
      return []
    }
  })()
  const kernel = tasks.length ? ['Threads (state, wchan, name):', ...tasks, 'Open:', ...fds, `Syscall: ${proc('syscall')}`] : []
  child.kill('SIGKILL')
  let where = 'No report: it was busy, or held in native code.'
  if (file) {
    const report = JSON.parse(readFileSync(join(reports, file), 'utf8'))
    const handles = (report.libuv ?? []).filter((h: { is_active?: boolean }) => h.is_active).map((h: { type: string; details?: string }) => `${h.type}${h.details ? ` ${h.details}` : ''}`)
    const native = (report.nativeStack ?? []).slice(0, 25).map((f: { symbol: string }) => f.symbol)
    where = [...(report.javascriptStack?.stack ?? []), 'Active handles:', ...handles, 'Native stack:', ...native].join('\n')
  }
  throw new Error(`sosie ${args.join(' ')} did not end in 20 s. Where it was:\n${where}\n${kernel.join('\n')}\n${stdout}${stderr}`)
}

/** Every Sosie a test started: one that a failing test left running is stopped with the file. */
const children = new Set<ChildProcess>()
afterAll(() => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
})

/** A project: a folder with this sosie.yml, and its other files. */
function project(yaml: string, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'sosie-project-'))
  writeFileSync(join(dir, 'sosie.yml'), yaml)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

/** One source, named app, its upstream in APP_URL, on a port the system picks. */
const ONE = (more = '') => `sources:\n  app:\n    upstream: \${APP_URL}\n    port: 0\n${more}`

/**
 * Start `sosie` in a project and wait for its banner; `address` says where a source of it listens. With `typed`, it
 * starts in a terminal, these lines typed in it, and the terminal left open.
 */
async function start(more: Record<string, string | undefined>, cwd: string, typed?: string) {
  const flags = typed === undefined ? [] : TERMINAL
  const child = spawn(process.execPath, [...flags, CLI], { env: env(more), cwd, stdio: 'pipe' })
  children.add(child)
  if (typed === undefined) child.stdin.end()
  else child.stdin.write(typed)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no banner: ${stdout}${stderr}`)), 15_000)
    child.stdout.on('data', () => stdout.includes('Any MCP client:') && (clearTimeout(timer), resolve()))
    child.on('exit', () => (clearTimeout(timer), reject(new Error(`exited: ${stdout}${stderr}`))))
  })
  const address = (name = 'app') => new RegExp(`^  ${name}:\\s+(\\S+)`, 'm').exec(stdout)![1]!
  return { child, address, stdout: () => stdout, stderr: () => stderr }
}

function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGINT'): Promise<number | null> {
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code))
    child.kill(signal)
  })
}

async function mcpClient(home: string, args = ['mcp']) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, ...args], env: env({ SOSIE_HOME: home }), stderr: 'pipe' })
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

const text = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text

describe('sosie', () => {
  const home = mkdtempSync(join(tmpdir(), 'sosie-cli-'))
  let sosie: Awaited<ReturnType<typeof start>>
  const transcript: string[] = []

  beforeAll(async () => {
    sosie = await start({ APP_URL: inject('upstream'), SOSIE_HOME: home }, project(ONE()))
  })
  afterAll(async () => {
    if (sosie.child.exitCode === null) await stop(sosie.child)
  })

  it('prints where it reads from and where clients connect, and no credentials', () => {
    const out = sosie.stdout()
    expect(out).toMatch(/✓ app {2}127\.0\.0\.1:\d+\/sosie_test_\w+, read-only: 6 tables, 2 views/)
    expect(out).toContain('✓ Every value is faked')
    expect(out).toMatch(/\n {2}app: +postgres:\/\/localhost:\d+\/sosie_test_\w+\n/)
    // The plugin for Claude Code, from this repository's marketplace; the bare server for any other client.
    expect(out).toContain('claude plugin marketplace add monkilabs/sosie')
    expect(out).toContain('claude plugin install sosie@sosie')
    expect(out).toContain('Any MCP client:            npx @sosie/cli mcp')
    expect(out).not.toContain('reader')
    const running = readFileSync(join(home, 'running', `${sosie.child.pid}.json`), 'utf8')
    expect(running).not.toContain('reader')
    expect(JSON.parse(running).sources).toMatchObject([{ name: 'app', kind: 'postgres', address: sosie.address() }])
  })

  it('serves fakes to node-postgres', async () => {
    const client = new pg.Client({ connectionString: sosie.address() })
    await client.connect()
    const { rows } = await client.query('SELECT email, full_name, phone FROM users ORDER BY id')
    await client.end()
    expect(rows).toHaveLength(40)
    expect(canariesIn(JSON.stringify(rows))).toEqual([])
    transcript.push(JSON.stringify(rows))
  })

  it('serves describe and query over MCP', async () => {
    const mcp = await mcpClient(home)
    expect((await mcp.listTools()).tools.map((t) => t.name)).toEqual(['describe', 'query', 'find', 'aggregate', 'graphql', 'request'])
    const users = JSON.parse(text(await mcp.callTool({ name: 'describe', arguments: { entity: 'users' } })))
    expect(users.sources[0]).toMatchObject({ source: 'app', kind: 'postgres' })
    expect(users.sources[0].entities[0].fields).toContainEqual({ field: 'email', type: 'string', key: 'unique' })
    const result = await mcp.callTool({ name: 'query', arguments: { sql: 'SELECT * FROM users u JOIN orders o ON o.user_id = u.id' } })
    expect(result.isError).toBeFalsy()
    const body = JSON.parse(text(result))
    expect(body.rows).toHaveLength(5)
    expect(canariesIn(text(result))).toEqual([])
    transcript.push(text(result))
    const several = JSON.parse(text(await mcp.callTool({ name: 'query', arguments: { sql: 'SELECT 1 AS a; SELECT 2 AS b', source: 'app' } })))
    expect(several.results.map((r: { rows: unknown[] }) => r.rows)).toEqual([[{ a: 1 }], [{ b: 2 }]])
    const refused = await mcp.callTool({ name: 'query', arguments: { sql: 'DELETE FROM users' } })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toBe('This statement changes data. Sosie is read-only.')
    await mcp.close()
  })

  it('scans: nothing real in what it served, and the real value where one is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sosie-transcripts-'))
    writeFileSync(join(dir, 'session.jsonl'), transcript.join('\n'))
    const clean = await watched(['scan', dir], { SOSIE_HOME: home })
    expect(clean.stdout).toContain('✓ No real values found in 1 file.')
    expect(clean.status).toBe(0)
    writeFileSync(join(dir, 'leak.md'), 'The agent wrote:\nZephyrine Orrowmoor ordered twice.\n')
    const leak = await watched(['scan', dir], { SOSIE_HOME: home })
    expect(leak.status).toBe(1)
    // Zephyrine is also a key in a profile, so the first real value found on the line may be either.
    expect(leak.stdout).toMatch(new RegExp(`✗ ${join(dir, 'leak.md')}:2  a real value from (format:full_name|users\\.profile\\.\\$\\.\\*key)\n`))
    expect(leak.stdout).toContain('1 real value found in 2 files.')
    expect(leak.stdout).not.toContain('Zephyrine')
  })

  it('stops on Ctrl+C, and MCP then says how to start it', async () => {
    expect(await stop(sosie.child)).toBe(0)
    expect(existsSync(join(home, 'running', `${sosie.child.pid}.json`))).toBe(false)
    const mcp = await mcpClient(home)
    const result = await mcp.callTool({ name: 'describe', arguments: {} })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^Sosie is not running\. Ask the developer to start it/)
    await mcp.close()
  })
})

describe('sosie, every source of a project in one', () => {
  it('serves a database, a REST API and a GraphQL API, each at its own address, the same person one fake in all', async () => {
    const api = await startApi()
    const gql = await startGraphql()
    const home = mkdtempSync(join(tmpdir(), 'sosie-cli-all-'))
    const dir = project(`# A rule at the top holds for every source that has the table.
pass: [countries.*]
# Only members learns its fields, and has met none yet: kept, and told, as it may be a typo.
format:
  member.nick: username
sources:
  shop:
    upstream: \${SHOP_URL}
    port: 0
  members:
    upstream: \${MEMBERS_URL}
    port: 0
    headers:
      Authorization: Bearer \${MEMBERS_TOKEN}
  directory:
    upstream: \${DIRECTORY_URL}
    port: 0
    headers:
      Authorization: Bearer \${MEMBERS_TOKEN}
    max-rows: 2
`)
    const sosie = await start({ SHOP_URL: inject('upstream'), MEMBERS_URL: api.url, DIRECTORY_URL: gql.url, MEMBERS_TOKEN: TOKEN, SOSIE_HOME: home }, dir)
    try {
      const out = sosie.stdout()
      expect(out).toMatch(/✓ shop {7}127\.0\.0\.1:\d+\/sosie_test_\w+, read-only: 6 tables, 2 views/)
      expect(out).toMatch(/✓ members {4}127\.0\.0\.1:\d+\/v1, read-only: no OpenAPI document/)
      expect(out).toMatch(/✓ directory {2}127\.0\.0\.1:\d+\/api\/graphql, read-only: 10 types, 19 queries/)
      expect(out).toContain('✓ Every value is faked; 2 fields pass (sosie.yml)')
      expect(out).toContain('! members: No OpenAPI document found')
      // countries.* is the shop's: known, and not told.
      expect(out.match(/^ {2}! sosie\.yml: .*$/gm)).toEqual(['  ! sosie.yml: member.nick is not known yet: it applies once Sosie meets it.'])
      expect(out).not.toContain(TOKEN)
      for (const name of ['shop', 'members', 'directory']) expect(sosie.address(name)).toMatch(/^(postgres|http):\/\/localhost:\d+\//)

      const db = new pg.Client({ connectionString: sosie.address('shop') })
      await db.connect()
      const { rows } = await db.query("SELECT email FROM users WHERE full_name = 'Quillon Vantablack'")
      await db.end()
      // The two answers below are real ones Sosie faked: the same person, one fake, in every source.
      const people = (await (await fetch(`${sosie.address('members')}/users`)).json()) as { data: { email: string }[] }
      const graphqlAnswer = await fetch(sosie.address('directory'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ users { email } }' }) })
      const directory = (await graphqlAnswer.json()) as { data: { users: { email: string }[] } }
      expect(directory.data.users).toHaveLength(2)
      expect(people.data.map((u) => u.email)).toContain(rows[0].email)
      expect(directory.data.users.map((u) => u.email)).toContain(rows[0].email)
      expect(canariesIn(JSON.stringify([rows, people, directory]))).toEqual([])

      const running = JSON.parse(readFileSync(join(home, 'running', `${sosie.child.pid}.json`), 'utf8'))
      expect(running.sources.map((s: { name: string; kind: string }) => [s.name, s.kind])).toEqual([
        ['shop', 'postgres'],
        ['members', 'rest'],
        ['directory', 'graphql'],
      ])
      const mcp = await mcpClient(home)
      try {
        const described = JSON.parse(text(await mcp.callTool({ name: 'describe', arguments: {} })))
        expect(described.sources.map((s: { source: string }) => s.source)).toEqual(['shop', 'members', 'directory'])
        // One source of each kind: each tool finds its own without a name.
        expect(JSON.parse(text(await mcp.callTool({ name: 'query', arguments: { sql: 'SELECT count(*) AS n FROM users' } }))).rows).toEqual([{ n: '40' }])
        expect(JSON.parse(text(await mcp.callTool({ name: 'request', arguments: { path: '/users' } }))).body.data).toHaveLength(3)
        expect(JSON.parse(text(await mcp.callTool({ name: 'graphql', arguments: { query: '{ users { email } }', source: 'directory' } }))).data.users).toHaveLength(2)
      } finally {
        await mcp.close()
      }
    } finally {
      expect(await stop(sosie.child)).toBe(0)
      await api.close()
      await gql.close()
    }
  })

  it('starts none when one cannot connect, and names it', () => {
    const dir = project(`sources:\n  shop:\n    upstream: \${SHOP_URL}\n    port: 0\n  crm:\n    upstream: \${CRM_URL}\n    port: 0\n`)
    // Port 1: nothing listens there, and no test's server can take it meanwhile, as one could a port just closed.
    const result = run([], { SHOP_URL: inject('upstream'), CRM_URL: 'postgres://kim:secret@127.0.0.1:1/crm', SOSIE_HOME: mkdtempSync(join(tmpdir(), 'sosie-cli-')) }, dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('✗ crm: Cannot connect to 127.0.0.1:1/crm')
    expect(result.stderr).not.toContain('secret')
    expect(result.stdout).not.toContain('shop:')
  })
})

describe('sosie, in front of an API', () => {
  it('starts, serves curl and MCP, and says it found no OpenAPI document', async () => {
    const api = await startApi()
    const home = mkdtempSync(join(tmpdir(), 'sosie-cli-rest-'))
    const dir = project(`sources:\n  app:\n    upstream: \${APP_URL}\n    port: 0\n    headers:\n      Authorization: Bearer \${APP_TOKEN}\n`)
    const sosie = await start({ APP_URL: api.url, APP_TOKEN: TOKEN, SOSIE_HOME: home }, dir)
    const out = sosie.stdout()
    expect(out).toMatch(/✓ app {2}127\.0\.0\.1:\d+\/v1, read-only: no OpenAPI document/)
    expect(out).toContain('! app: No OpenAPI document found')
    expect(sosie.address()).toMatch(/^http:\/\/localhost:\d+\/v1$/)
    expect(out).not.toContain(TOKEN)
    const users = (await (await fetch(`${sosie.address()}/users`)).json()) as { data: unknown[] }
    expect(users.data).toHaveLength(3)
    // The running file is written again as the API's answers show fields, so describe lists them.
    const entry = join(home, 'running', `${sosie.child.pid}.json`)
    for (let i = 0; i < 40 && !readFileSync(entry, 'utf8').includes('user.email'); i++) await new Promise((r) => setTimeout(r, 50))
    const mcp = await mcpClient(home)
    expect((await mcp.listTools()).tools.map((t) => t.name)).toEqual(['describe', 'query', 'find', 'aggregate', 'graphql', 'request'])
    const described = JSON.parse(text(await mcp.callTool({ name: 'describe', arguments: {} })))
    expect(described.sources[0].entities.map((e: { entity: string }) => e.entity)).toEqual(['user'])
    expect(described.sources[0].entities[0].fields.map((f: { field: string }) => f.field)).toEqual(expect.arrayContaining(['id', 'email', 'name']))
    const result = JSON.parse(text(await mcp.callTool({ name: 'request', arguments: { path: '/users' } })))
    expect(result.body.data).toHaveLength(3)
    expect(canariesIn(JSON.stringify([users, result]))).toEqual([])
    const query = await mcp.callTool({ name: 'query', arguments: { sql: 'SELECT 1' } })
    expect(text(query)).toBe('Sosie serves rest here, not postgres or mysql: query is for postgres or mysql.')
    await mcp.close()
    expect(await stop(sosie.child)).toBe(0)
    await api.close()
  })
})

describe('sosie, in front of a GraphQL API', () => {
  const graphqlSource = (more = '') => `sources:\n  app:\n    upstream: \${APP_URL}\n    port: 0\n    headers:\n      Authorization: Bearer \${APP_TOKEN}\n${more}`

  it('starts on its path, and serves GraphQL clients and MCP', async () => {
    const api = await startGraphql()
    const home = mkdtempSync(join(tmpdir(), 'sosie-cli-gql-'))
    const sosie = await start({ APP_URL: api.url, APP_TOKEN: TOKEN, SOSIE_HOME: home }, project(graphqlSource()))
    expect(sosie.stdout()).toMatch(/✓ app {2}127\.0\.0\.1:\d+\/api\/graphql, read-only: 10 types, 19 queries/)
    expect(sosie.address()).toMatch(/^http:\/\/localhost:\d+\/api\/graphql$/)
    const mcp = await mcpClient(home)
    const result = JSON.parse(text(await mcp.callTool({ name: 'graphql', arguments: { query: '{ users { email } }' } })))
    expect(result.data.users).toHaveLength(3)
    expect(canariesIn(JSON.stringify(result))).toEqual([])
    await mcp.close()
    expect(await stop(sosie.child)).toBe(0)
    await api.close()
  })

  it("starts at a path such as Supabase's /graphql/v1, or at any path with kind: graphql and its schema", async () => {
    const api = await startGraphql()
    const home = mkdtempSync(join(tmpdir(), 'sosie-cli-gql-'))
    for (const [path, more] of [['/graphql/v1', ''], ['/query', '    kind: graphql\n    schema: ./schema.graphql\n']] as const) {
      const upstream = api.url.replace('/api/graphql', path)
      const sosie = await start({ APP_URL: upstream, APP_TOKEN: TOKEN, SOSIE_HOME: home }, project(graphqlSource(more), { 'schema.graphql': SDL }))
      expect(sosie.stdout()).toMatch(/read-only: 10 types, 19 queries/)
      expect(sosie.address()).toMatch(new RegExp(`^http://localhost:\\d+${path}$`))
      const answer = await fetch(sosie.address(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ users { email } }' }) })
      const body = (await answer.json()) as { data: { users: unknown[] } }
      expect(body.data.users).toHaveLength(3)
      expect(canariesIn(JSON.stringify(body))).toEqual([])
      expect(await stop(sosie.child)).toBe(0)
    }
    await api.close()
  })
})

describe('sosie, beyond this machine', () => {
  it('warns once that anyone who can reach a host other than this machine can query the fakes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sosie-cli-host-'))
    const dir = project(`host: 0.0.0.0\nsources:\n  a:\n    upstream: \${APP_URL}\n    port: 0\n  b:\n    upstream: \${APP_URL}\n    port: 0\n  c:\n    upstream: \${APP_URL}\n    port: 0\n    host: 127.0.0.1\n`)
    const sosie = await start({ APP_URL: inject('upstream'), SOSIE_HOME: home }, dir)
    try {
      expect(sosie.stdout().match(/^ {2}! Listening on .*$/gm)).toEqual(['  ! Listening on 0.0.0.0, with no password: anyone who can reach it can query the fakes and filter on the real values.'])
    } finally {
      expect(await stop(sosie.child)).toBe(0)
    }
  })
})

describe('sosie, upgraded from 0.3', () => {
  const home = mkdtempSync(join(tmpdir(), 'sosie-cli-upgraded-'))
  const gone = { SOSIE_UPSTREAM: 'postgres://kim:secret@db/app', SOSIE_UPSTREAM_HEADERS: 'Authorization: Bearer secret', SOSIE_OPENAPI: './openapi.json', SOSIE_GRAPHQL_SCHEMA: './schema.graphql' }

  it('says each variable of an earlier version left set is not read any more, and what in sosie.yml says it, never its value', async () => {
    const sosie = await start({ ...gone, APP_URL: inject('upstream'), SOSIE_HOME: home }, project(ONE()))
    try {
      expect(sosie.stdout().match(/^ {2}! SOSIE_.*$/gm)).toEqual([
        "  ! SOSIE_UPSTREAM is not read any more: sosie.yml says it, as a source's upstream: upstream: ${SOSIE_UPSTREAM} reads it.",
        "  ! SOSIE_UPSTREAM_HEADERS is not read any more: sosie.yml says it, as a source's headers.",
        "  ! SOSIE_OPENAPI is not read any more: sosie.yml says it, as a source's schema.",
        "  ! SOSIE_GRAPHQL_SCHEMA is not read any more: sosie.yml says it, as a source's schema, with kind: graphql.",
      ])
      expect(sosie.stdout() + sosie.stderr()).not.toContain('secret')
    } finally {
      expect(await stop(sosie.child)).toBe(0)
    }
  })

  it('reads SOSIE_UPSTREAM where sosie.yml names it, as upgrading says to, and tells none as not read', async () => {
    const sosie = await start({ SOSIE_UPSTREAM: inject('upstream'), SOSIE_HOME: home }, project('sources:\n  app:\n    upstream: ${SOSIE_UPSTREAM}\n    port: 0\n'))
    try {
      expect(sosie.stdout()).toMatch(/✓ app {2}127\.0\.0\.1:\d+\/sosie_test_\w+, read-only: 6 tables, 2 views/)
      expect(sosie.stdout()).not.toContain('is not read any more')
    } finally {
      expect(await stop(sosie.child)).toBe(0)
    }
  })

  it('says how to add the first source to a sosie.yml of rules only, with no terminal to write it in', () => {
    const text = 'pass: [orders.status]\n'
    const dir = project(text)
    const result = run([], { SOSIE_UPSTREAM: gone.SOSIE_UPSTREAM, SOSIE_HOME: home }, dir)
    expect(result.status).toBe(2)
    expect(result.stderr).toBe(
      '  ✗ sosie.yml names no sources. Run sosie init in a terminal, or write it:\n\n  sources:\n    shop:\n      upstream: ${SHOP_URL}     # set SHOP_URL in your terminal, never here\n\n  SOSIE_UPSTREAM is set: upstream: ${SOSIE_UPSTREAM} reads it.\n\n',
    )
    expect(readFileSync(join(dir, 'sosie.yml'), 'utf8')).toBe(text)
  })

  it('adds the first source to a sosie.yml of rules only in a terminal, its rules kept, and starts with them', async () => {
    const dir = project('pass: [orders.status]\n')
    const sosie = await start({ APP_URL: undefined, SOSIE_HOME: home }, dir, `${inject('upstream')}\napp\n\n`)
    try {
      expect(sosie.stdout()).toContain('  sosie.yml names no sources yet: the first, a database or an API.')
      expect(sosie.stdout()).toContain('✓ Every value is faked; 1 field passes (sosie.yml)')
      expect(readFileSync(join(dir, 'sosie.yml'), 'utf8')).toBe('pass: [orders.status]\n\nsources:\n  app:\n    upstream: ${APP_URL}\n')
    } finally {
      expect(await stop(sosie.child)).toBe(0)
    }
  })
})

describe('sosie, in a terminal', () => {
  const home = mkdtempSync(join(tmpdir(), 'sosie-cli-tty-'))
  const empty = () => mkdtempSync(join(tmpdir(), 'sosie-empty-project-'))

  it('writes sosie.yml where there is none, then starts with the string typed, never asking for it again nor printing it', async () => {
    const dir = empty()
    const sosie = await start({ SHOP_URL: undefined, SOSIE_HOME: home }, dir, `${inject('upstream')}\nshop\n\n`)
    try {
      const out = sosie.stdout()
      expect(out).toContain('  No sosie.yml here yet: one, with the first database or API Sosie reads.')
      expect(out).toMatch(/ {2}Its connection string, or the API's URL \(hidden\): \n {2}✓ A Postgres database: 127\.0\.0\.1:\d+\/sosie_test_\w+\n/)
      expect(out).toContain('✓ Wrote sosie.yml: shop, its upstream read from ${SHOP_URL}, never written there. Commit it.')
      expect(out).not.toContain('SHOP_URL (hidden)')
      expect(out).not.toContain('Start Sosie with npx @sosie/cli.')
      expect(out).toMatch(/✓ shop {2}127\.0\.0\.1:\d+\/sosie_test_\w+, read-only: 6 tables, 2 views/)
      expect(out + sosie.stderr()).not.toContain('reader')
      expect(readFileSync(join(dir, 'sosie.yml'), 'utf8')).toMatch(/^# Sosie: this project's sources[^]*\nsources:\n {2}shop:\n {4}upstream: \$\{SHOP_URL\}\n$/)
    } finally {
      expect(await stop(sosie.child)).toBe(0)
    }
  })

  it('asks at a hidden prompt for each variable sosie.yml names that is not set, in the order named', async () => {
    const api = await startApi()
    const dir = project(`sources:\n  a:\n    upstream: \${A_URL}\n    port: 0\n  b:\n    upstream: \${B_URL}\n    port: 0\n    headers:\n      Authorization: Bearer \${B_TOKEN}\n`)
    const sosie = await start({ A_URL: undefined, B_URL: undefined, B_TOKEN: TOKEN, SOSIE_HOME: home }, dir, `${inject('upstream')}\n${api.url}\n`)
    try {
      const out = sosie.stdout()
      // B_TOKEN is set: only the two that are not are asked for.
      expect(out).toMatch(/^ {2}A_URL \(hidden\): \n {2}B_URL \(hidden\): \n\n {2}✓ a {2}/)
      expect(out).toMatch(/✓ a {2}127\.0\.0\.1:\d+\/sosie_test_\w+, read-only: 6 tables, 2 views/)
      expect(out).toMatch(/✓ b {2}127\.0\.0\.1:\d+\/v1, read-only: no OpenAPI document/)
      expect(out + sosie.stderr()).not.toContain('reader')
      expect(out + sosie.stderr()).not.toContain(TOKEN)
    } finally {
      expect(await stop(sosie.child)).toBe(0)
      await api.close()
    }
    const closed = run([], { APP_URL: undefined, SOSIE_HOME: home }, project(ONE()), '')
    expect(closed.status).toBe(2)
    expect(closed.stdout).toBe('  APP_URL (hidden): \n')
    expect(closed.stderr).toBe('  ✗ No input.\n')
  })

  it('writes sosie.yml with sosie init, and ends with 1 for a sosie.yml with a problem, 2 for anything else', () => {
    const dir = empty()
    const wrote = run(['init'], { SOSIE_HOME: home }, dir, 'postgres://kim:secret@db.internal/shop\n\n\n')
    expect(wrote.status).toBe(0)
    expect(wrote.stdout).toContain(
      '✓ Wrote sosie.yml: shop, its upstream read from ${SHOP_URL}, never written there. Commit it.\n    Set SHOP_URL in your terminal, and Sosie starts without asking for it.\n    Start Sosie with npx @sosie/cli.\n',
    )
    expect(wrote.stdout + wrote.stderr).not.toContain('secret')
    expect(readFileSync(join(dir, 'sosie.yml'), 'utf8')).toContain('\nsources:\n  shop:\n    upstream: ${SHOP_URL}\n')

    const misspelt = run(['init'], { SOSIE_HOME: home }, project('sourcs:\n  app:\n    upstream: ${APP_URL}\n'), '')
    expect(misspelt.status).toBe(1)
    expect(misspelt.stderr).toContain('  ✗ sosie.yml: sourcs is not a key. Did you mean sources?')
    const named = run(['init'], { SOSIE_HOME: home }, dir, '')
    expect(named.status).toBe(2)
    expect(named.stderr).toBe('  ✗ sosie.yml names its sources already: shop. Add another under sources:.\n')
    const unreadable = empty()
    const thrice = run(['init'], { SOSIE_HOME: home }, unreadable, 'redis://kim:secret@cache/0\nftp://kim:secret@files\nkim:secret\n')
    expect(thrice.status).toBe(2)
    expect(thrice.stderr).toBe('  ✗ Nothing written.\n')
    expect(thrice.stdout).not.toContain('secret')
    expect(existsSync(join(unreadable, 'sosie.yml'))).toBe(false)
  })
})

describe('sosie, when something is wrong', () => {
  const home = mkdtempSync(join(tmpdir(), 'sosie-cli-'))
  const empty = () => mkdtempSync(join(tmpdir(), 'sosie-empty-project-'))

  it('says how to write sosie.yml when there is none, and no terminal to write it in', () => {
    const result = run([], { SOSIE_HOME: home }, empty())
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('✗ There is no sosie.yml here. Run sosie init in a terminal, or write it:')
    expect(result.stderr).toContain('upstream: ${SHOP_URL}')
    // An earlier version's variable, still set: what reads it now.
    expect(run([], { SOSIE_UPSTREAM: 'postgres://kim:secret@db/app', SOSIE_HOME: home }, empty()).stderr).toContain('SOSIE_UPSTREAM is set: upstream: ${SOSIE_UPSTREAM} reads it.')
    const init = run(['init'], { SOSIE_HOME: home }, empty())
    expect(init.status).toBe(2)
    expect(init.stderr).toContain('sosie init asks for the first source at a hidden prompt: run it in a terminal')
  })

  it('asks for a variable sosie.yml names, when there is no terminal to type it in', () => {
    const result = run([], { APP_URL: undefined, SOSIE_HOME: home }, project(ONE()))
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('✗ Set APP_URL, which sosie.yml names, in the terminal Sosie starts in, or start it in a terminal to type it.')
  })

  it('names an upstream it cannot read, without echoing it', () => {
    const dir = project(ONE())
    const result = run([], { APP_URL: 'redis://kim:secret@db/0', SOSIE_HOME: home }, dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('✗ sosie.yml: sources.app: Sosie reads postgres://, postgresql://, mysql://, mongodb://, mongodb+srv://, http:// and https:// upstreams, for now; not redis://.')
    expect(result.stderr).not.toContain('secret')
    const notUrl = run([], { APP_URL: 'host=db password=secret', SOSIE_HOME: home }, dir)
    expect(notUrl.stderr).toContain('✗ sosie.yml: sources.app: APP_URL: it is not a URL.')
    expect(notUrl.stderr).not.toContain('secret')
    // A replica set's hosts, with their ports or without: one is enough.
    for (const hosts of ['h1:27017,h2:27017', 'h1,h2']) {
      const listed = run([], { APP_URL: `mongodb://kim:secret@${hosts}/app?replicaSet=rs0`, SOSIE_HOME: home }, dir)
      expect(listed.status).toBe(1)
      expect(listed.stderr).toContain('Give one host of the replica set')
      expect(listed.stderr).not.toContain('secret')
    }
  })

  it('refuses an upstream written in sosie.yml, without echoing it', () => {
    const result = run([], { SOSIE_HOME: home }, project('sources:\n  app:\n    upstream: postgres://kim:secret@db/app\n'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('✗ sosie.yml: sources.app.upstream is one variable, such as ${APP_URL}, set in the terminal Sosie starts in')
    expect(result.stderr).not.toContain('secret')
  })

  it('names a typo in sosie.yml and suggests what was meant', () => {
    const top = run([], { APP_URL: inject('upstream'), SOSIE_HOME: home }, project(`pass:\n  - users.emial\n${ONE()}`))
    expect(top.status).toBe(1)
    expect(top.stderr).toContain("✗ sosie.yml: users.emial is not a field of app's users. Did you mean users.email? A rule for one source goes under it.")
    const own = run([], { APP_URL: inject('upstream'), SOSIE_HOME: home }, project(ONE('    pass: [users.emial]\n')))
    expect(own.stderr).toContain('✗ sosie.yml: sources.app: users.emial is not a field. Did you mean users.email?')
    const key = run([], { SOSIE_HOME: home }, project(`max_rows: 5\n${ONE()}`))
    expect(key.stderr).toContain('✗ sosie.yml: max_rows is not a key. Did you mean max-rows?')
  })

  it('tells every problem with the rules at once: a top rule no source holds among a source’s own', () => {
    const result = run([], { APP_URL: inject('upstream'), SOSIE_HOME: home }, project(`pass: [contacts.region]\n${ONE('    pass: [users.citi]\n')}`))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('✗ sosie.yml: sources.app: users.citi is not a field. Did you mean users.city?')
    expect(result.stderr).toContain('✗ sosie.yml: contacts.region is not a table of any source.')
  })

  it('names a misspelt sources key, and never writes a second one', () => {
    const text = 'sourcs:\n  app:\n    upstream: ${APP_URL}\n'
    const dir = project(text)
    const result = run([], { APP_URL: inject('upstream'), SOSIE_HOME: home }, dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('✗ sosie.yml: sourcs is not a key. Did you mean sources?')
    expect(readFileSync(join(dir, 'sosie.yml'), 'utf8')).toBe(text)
  })

  it('says to add a source under a sources key that has none, not to run sosie init, which would refuse', () => {
    for (const text of ['sources:\n', 'sources: {}\n']) {
      const result = run([], { SOSIE_HOME: home }, project(text))
      expect(result.status, text).toBe(1)
      expect(result.stderr, text).toBe('  ✗ sosie.yml has a sources: key with none under it. Add one there, such as shop: { upstream: ${SHOP_URL} }.\n')
    }
  })

  it('starts a second Sosie, for another project, on the next free port, and MCP serves both', async () => {
    const shared = mkdtempSync(join(tmpdir(), 'sosie-two-'))
    const shopAt = project('sources:\n  shop:\n    upstream: ${SHOP_URL}\n')
    const adminAt = project('sources:\n  admin:\n    upstream: ${ADMIN_URL}\n')
    const first = await start({ SHOP_URL: inject('upstream'), SOSIE_HOME: shared }, shopAt)
    const second = await start({ ADMIN_URL: inject('admin'), SOSIE_HOME: shared }, adminAt).catch(async (error) => {
      await stop(first.child)
      throw error
    })
    try {
      // Other programs may hold and free ports meanwhile: the second only needs one of its own.
      expect(new URL(second.address('admin')).port).not.toBe(new URL(first.address('shop')).port)
      const mcp = await mcpClient(shared)
      try {
        const all = JSON.parse(text(await mcp.callTool({ name: 'describe', arguments: { entity: 'countries' } })))
        expect(all.sources.map((s: { source: string; address: string }) => [s.source, s.address])).toEqual([
          ['admin', second.address('admin')],
          ['shop', first.address('shop')],
        ])
      } finally {
        await mcp.close()
      }
    } finally {
      await stop(second.child)
      await stop(first.child)
    }
  })

  it('stops when its terminal closes, and leaves no running file', async () => {
    const sosie = await start({ APP_URL: inject('upstream'), SOSIE_HOME: home }, project(ONE()))
    expect(existsSync(join(home, 'running', `${sosie.child.pid}.json`))).toBe(true)
    expect(await stop(sosie.child, 'SIGHUP')).toBe(0)
    expect(existsSync(join(home, 'running', `${sosie.child.pid}.json`))).toBe(false)
  })

  it('counts the fields that pass, and names a port in use', async () => {
    const sosie = await start({ APP_URL: inject('upstream'), SOSIE_HOME: home }, project(`pass:\n  - countries.*\n${ONE()}`))
    expect(sosie.stdout()).toContain('✓ Every value is faked; 2 fields pass (sosie.yml)')
    const port = new URL(sosie.address()).port
    const busy = run([], { APP_URL: inject('upstream'), SOSIE_HOME: home }, project(`sources:\n  app:\n    upstream: \${APP_URL}\n    port: ${port}\n`))
    expect(busy.status).toBe(1)
    expect(busy.stderr).toContain(`✗ app: port ${port} is in use. Is Sosie already running? Give it another in sosie.yml.`)
    await stop(sosie.child)
  })

  it('names why it cannot listen on a host, and starts nothing', () => {
    // 192.0.2.1 is for documentation: no machine has it, so nothing can listen on it.
    const result = run([], { APP_URL: inject('upstream'), SOSIE_HOME: home }, project(ONE('    host: 192.0.2.1\n')))
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('  ✗ app: listen EADDRNOTAVAIL: address not available 192.0.2.1\n')
    expect(result.stdout).toBe('')
  })

  it('stops a statement at the timeout sosie.yml gives, and refuses lifting it', async () => {
    const sosie = await start({ APP_URL: inject('upstream'), SOSIE_HOME: home }, project(`timeout: 1\n${ONE()}`))
    const client = new pg.Client({ connectionString: sosie.address() })
    await client.connect()
    const slow = await client.query('SELECT pg_sleep(3)').catch((error: { code: string }) => error)
    expect((slow as { code: string }).code).toBe('57014')
    const lifted = await client.query("SET statement_timeout = '2s'").catch((error: { message: string }) => error)
    expect((lifted as { message: string }).message).toContain('1000')
    await client.end()
    await stop(sosie.child)
  })

  it('explains its commands, and says where a flag of an earlier version went', () => {
    expect(run(['--help']).stdout).toContain('sosie init            Write sosie.yml, with the first source.')
    expect(run(['--version']).stdout.trim()).toBe(VERSION)
    expect(run(['serve']).status).toBe(2)
    const port = run(['--port', '7674'])
    expect(port.status).toBe(2)
    expect(port.stderr).toContain('✗ --port is in sosie.yml now: port, under a source.')
    expect(run(['--max-rows=5']).stderr).toContain('✗ --max-rows is in sosie.yml now: max-rows.')
    expect(run(['scan']).status).toBe(2)
    const nothing = run(['scan', '.'], { SOSIE_HOME: mkdtempSync(join(tmpdir(), 'sosie-empty-')) })
    expect(nothing.status).toBe(2)
    expect(nothing.stderr).toContain('Nothing to compare with')
    expect(run(['scan', '/no/such/path'], { SOSIE_HOME: home }).stderr).toContain('No such file or folder: /no/such/path')
  })
})
