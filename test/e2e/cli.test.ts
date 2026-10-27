import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { startApi, TOKEN } from './api.js'
import { canariesIn } from './canaries.js'
import { startGraphql } from './graphql-api.js'

const CLI = fileURLToPath(new URL('../../packages/cli/dist/cli.js', import.meta.url))
if (!existsSync(CLI)) throw new Error('Build the packages first: npm run build')

const env = (more: Record<string, string | undefined> = {}) => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, NO_COLOR: '1', ...more })) if (v !== undefined) out[k] = v
  return out
}

/** Run the CLI to the end. */
function run(args: string[], more: Record<string, string | undefined> = {}, cwd?: string) {
  const result = spawnSync(process.execPath, [CLI, ...args], { env: env(more), encoding: 'utf8', cwd, input: '' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Start `sosie` and wait for its banner. */
async function start(more: Record<string, string | undefined>, args: string[] = ['--port', '0']) {
  const child = spawn(process.execPath, [CLI, ...args], { env: env(more), stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no banner: ${stdout}${stderr}`)), 15_000)
    child.stdout.on('data', () => stdout.includes('Claude Code:') && (clearTimeout(timer), resolve()))
    child.on('exit', () => (clearTimeout(timer), reject(new Error(`exited: ${stdout}${stderr}`))))
  })
  const address = /Your agent, app and \w+:\s+(\S+)/.exec(stdout)![1]!
  return { child, address, stdout: () => stdout }
}

function stop(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code))
    child.kill('SIGINT')
  })
}

async function mcpClient(home: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: env({ SOSIE_HOME: home }), stderr: 'pipe' })
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
    sosie = await start({ SOSIE_UPSTREAM: inject('upstream'), SOSIE_HOME: home })
  })
  afterAll(async () => {
    if (sosie.child.exitCode === null) await stop(sosie.child)
  })

  it('prints where it reads from and where clients connect, and no credentials', () => {
    const out = sosie.stdout()
    expect(out).toMatch(/✓ 127\.0\.0\.1:\d+\/sosie_test_\w+, read-only: 5 tables, 2 views/)
    expect(out).toContain('✓ Every value is faked')
    expect(out).toMatch(/Your agent, app and psql:\s+postgres:\/\/localhost:\d+\/sosie_test_\w+/)
    expect(out).toContain('claude mcp add sosie -- npx @sosie/cli mcp')
    expect(out).not.toContain('reader')
    const running = readFileSync(join(home, 'running', `${sosie.child.pid}.json`), 'utf8')
    expect(running).not.toContain('reader')
    expect(JSON.parse(running).address).toBe(sosie.address)
  })

  it('serves fakes to node-postgres', async () => {
    const client = new pg.Client({ connectionString: sosie.address })
    await client.connect()
    const { rows } = await client.query('SELECT email, full_name, phone FROM users ORDER BY id')
    await client.end()
    expect(rows).toHaveLength(40)
    expect(canariesIn(JSON.stringify(rows))).toEqual([])
    transcript.push(JSON.stringify(rows))
  })

  it('serves describe and query over MCP', async () => {
    const mcp = await mcpClient(home)
    expect((await mcp.listTools()).tools.map((t) => t.name)).toEqual(['describe', 'query', 'graphql', 'request'])
    const users = JSON.parse(text(await mcp.callTool({ name: 'describe', arguments: { entity: 'users' } })))
    expect(users.entities[0].fields).toContainEqual({ field: 'email', type: 'string', key: 'unique' })
    const result = await mcp.callTool({ name: 'query', arguments: { sql: 'SELECT * FROM users u JOIN orders o ON o.user_id = u.id' } })
    expect(result.isError).toBeFalsy()
    const body = JSON.parse(text(result))
    expect(body.rows).toHaveLength(5)
    expect(canariesIn(text(result))).toEqual([])
    transcript.push(text(result))
    const several = JSON.parse(text(await mcp.callTool({ name: 'query', arguments: { sql: 'SELECT 1 AS a; SELECT 2 AS b' } })))
    expect(several.results.map((r: { rows: unknown[] }) => r.rows)).toEqual([[{ a: 1 }], [{ b: 2 }]])
    const refused = await mcp.callTool({ name: 'query', arguments: { sql: 'DELETE FROM users' } })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toBe('This statement changes data. Sosie is read-only.')
    await mcp.close()
  })

  it('scans: nothing real in what it served, and the real value where one is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sosie-transcripts-'))
    writeFileSync(join(dir, 'session.jsonl'), transcript.join('\n'))
    const clean = run(['scan', dir], { SOSIE_HOME: home })
    expect(clean.stdout).toContain('✓ No real values found in 1 file.')
    expect(clean.status).toBe(0)
    writeFileSync(join(dir, 'leak.md'), 'The agent wrote:\nZephyrine Orrowmoor ordered twice.\n')
    const leak = run(['scan', dir], { SOSIE_HOME: home })
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

describe('sosie, in front of an API', () => {
  it('starts, serves curl and MCP, and says it found no OpenAPI document', async () => {
    const api = await startApi()
    const home = mkdtempSync(join(tmpdir(), 'sosie-cli-rest-'))
    const sosie = await start({ SOSIE_UPSTREAM: api.url, SOSIE_UPSTREAM_HEADERS: `Authorization: Bearer ${TOKEN}`, SOSIE_HOME: home }, ['--port', '0'])
    const out = sosie.stdout()
    expect(out).toMatch(/✓ 127\.0\.0\.1:\d+\/v1, read-only: no OpenAPI document/)
    expect(out).toContain('! No OpenAPI document found')
    expect(out).toMatch(/Your agent, app and curl:\s+http:\/\/localhost:\d+\/v1/)
    expect(out).not.toContain(TOKEN)
    const users = (await (await fetch(`${sosie.address}/users`)).json()) as { data: unknown[] }
    expect(users.data).toHaveLength(3)
    const mcp = await mcpClient(home)
    expect((await mcp.listTools()).tools.map((t) => t.name)).toEqual(['describe', 'query', 'graphql', 'request'])
    const result = JSON.parse(text(await mcp.callTool({ name: 'request', arguments: { path: '/users' } })))
    expect(result.body.data).toHaveLength(3)
    expect(canariesIn(JSON.stringify([users, result]))).toEqual([])
    const query = await mcp.callTool({ name: 'query', arguments: { sql: 'SELECT 1' } })
    expect(text(query)).toBe('Sosie serves rest here, not postgres: query is for postgres.')
    await mcp.close()
    expect(await stop(sosie.child)).toBe(0)
    await api.close()
  })
})

describe('sosie, in front of a GraphQL API', () => {
  it('starts on its path, and serves GraphQL clients and MCP', async () => {
    const api = await startGraphql()
    const home = mkdtempSync(join(tmpdir(), 'sosie-cli-gql-'))
    const sosie = await start({ SOSIE_UPSTREAM: api.url, SOSIE_UPSTREAM_HEADERS: `Authorization: Bearer ${TOKEN}`, SOSIE_HOME: home }, ['--port', '0'])
    expect(sosie.stdout()).toMatch(/✓ 127\.0\.0\.1:\d+\/api\/graphql, read-only: 5 types, 8 queries/)
    expect(sosie.address).toMatch(/^http:\/\/localhost:\d+\/api\/graphql$/)
    const mcp = await mcpClient(home)
    const result = JSON.parse(text(await mcp.callTool({ name: 'graphql', arguments: { query: '{ users { email } }' } })))
    expect(result.data.users).toHaveLength(3)
    expect(canariesIn(JSON.stringify(result))).toEqual([])
    await mcp.close()
    expect(await stop(sosie.child)).toBe(0)
    await api.close()
  })
})

describe('sosie, when something is wrong', () => {
  const home = mkdtempSync(join(tmpdir(), 'sosie-cli-'))

  it('asks for SOSIE_UPSTREAM when there is no terminal to type it in', () => {
    const result = run([], { SOSIE_UPSTREAM: undefined, SOSIE_HOME: home })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("Set SOSIE_UPSTREAM to your database's connection string")
  })

  it('names an upstream it cannot read, without echoing it', () => {
    const result = run([], { SOSIE_UPSTREAM: 'mysql://kim:secret@db/app', SOSIE_HOME: home })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Sosie reads postgres:// databases and http:// or https:// APIs for now, not mysql://.')
    expect(result.stderr).not.toContain('secret')
    const notUrl = run([], { SOSIE_UPSTREAM: 'host=db password=secret', SOSIE_HOME: home })
    expect(notUrl.stderr).toContain('The upstream is not a URL.')
    expect(notUrl.stderr).not.toContain('secret')
  })

  it('says when it cannot connect', async () => {
    const port = await closedPort()
    const result = run([], { SOSIE_UPSTREAM: `postgres://kim:secret@127.0.0.1:${port}/app`, SOSIE_HOME: home })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`✗ Cannot connect to 127.0.0.1:${port}/app`)
    expect(result.stderr).not.toContain('secret')
  })

  it('names a typo in sosie.yml and suggests the field meant', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sosie-rules-'))
    writeFileSync(join(dir, 'sosie.yml'), 'pass:\n  - users.emial\n')
    const result = run([], { SOSIE_UPSTREAM: inject('upstream'), SOSIE_HOME: home }, dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('✗ sosie.yml: users.emial is not a field. Did you mean users.email?')
  })

  it('starts a second Sosie on the next free port, and MCP serves both', async () => {
    const shared = mkdtempSync(join(tmpdir(), 'sosie-two-'))
    const first = await start({ SOSIE_UPSTREAM: inject('upstream'), SOSIE_HOME: shared }, [])
    const second = await start({ SOSIE_UPSTREAM: inject('admin'), SOSIE_HOME: shared }, [])
    expect(Number(new URL(second.address).port)).toBeGreaterThan(Number(new URL(first.address).port))
    const mcp = await mcpClient(shared)
    const all = JSON.parse(text(await mcp.callTool({ name: 'describe', arguments: { entity: 'countries' } })))
    expect(all.sources.map((s: { address: string }) => s.address)).toEqual([second.address, first.address])
    await mcp.close()
    await stop(second.child)
    await stop(first.child)
  })

  it('counts the fields that pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sosie-rules-'))
    writeFileSync(join(dir, 'rules.yml'), 'pass:\n  - countries.*\n')
    const sosie = await start({ SOSIE_UPSTREAM: inject('upstream'), SOSIE_HOME: home }, ['--port', '0', '--rules', join(dir, 'rules.yml')])
    expect(sosie.stdout()).toContain(`✓ Every value is faked; 2 fields pass (${join(dir, 'rules.yml')})`)
    const busy = run(['--port', new URL(sosie.address).port], { SOSIE_UPSTREAM: inject('upstream'), SOSIE_HOME: home })
    expect(busy.status).toBe(1)
    expect(busy.stderr).toMatch(/Port \d+ is in use\. Is Sosie already running\?/)
    await stop(sosie.child)
  })

  it('explains its commands', () => {
    expect(run(['--help']).stdout).toContain('sosie scan <path>...')
    expect(run(['--version']).stdout.trim()).toBe('0.1.0')
    expect(run(['serve']).status).toBe(2)
    expect(run(['--port', 'x'], { SOSIE_UPSTREAM: 'postgres://x' }).stderr).toContain('--port takes a whole number from 0, not x.')
    expect(run(['--max-rows', '0'], { SOSIE_UPSTREAM: 'postgres://x' }).stderr).toContain('--max-rows takes a whole number from 1, not 0.')
    expect(run(['scan']).status).toBe(2)
    const empty = run(['scan', '.'], { SOSIE_HOME: mkdtempSync(join(tmpdir(), 'sosie-empty-')) })
    expect(empty.status).toBe(2)
    expect(empty.stderr).toContain('Nothing to compare with')
    expect(run(['scan', '/no/such/path'], { SOSIE_HOME: home }).stderr).toContain('No such file or folder: /no/such/path')
  })
})

function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 1))
    })
  })
}
