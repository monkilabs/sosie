import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Connection } from 'tedious'
import { expect, inject, it } from 'vitest'
import { canariesIn } from '../canaries.js'
import { ask } from './sosie.js'

const CLI = fileURLToPath(new URL('../../../packages/cli/dist/cli.js', import.meta.url))
if (!existsSync(CLI)) throw new Error('Build the packages first: npm run build')
const upstream = inject('sqlserverUpstream')

it.skipIf(!upstream)('starts in front of SQL Server from the command, says where clients connect, and serves them fakes, over MCP too', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sosie-cli-sqlserver-'))
  const project = mkdtempSync(join(tmpdir(), 'sosie-project-'))
  writeFileSync(join(project, 'sosie.yml'), 'sources:\n  app:\n    upstream: ${APP_URL}\n    port: 0\n')
  const child = spawn(process.execPath, [CLI], {
    cwd: project,
    env: { ...process.env, NO_COLOR: '1', APP_URL: upstream, SOSIE_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no banner: ${out}`)), 30_000)
      child.stdout.on('data', () => out.includes('Any MCP client:') && (clearTimeout(timer), resolve()))
      child.on('exit', () => (clearTimeout(timer), reject(new Error(`exited: ${out}`))))
    })
    expect(out).toMatch(/✓ app  [\w.]+:\d+\/sosie_test_\w+, read-only: 5 tables, 1 view/)
    const address = /\n  app:\s+(Server=127\.0\.0\.1,\d+;Database=\w+;TrustServerCertificate=true)/.exec(out)![1]!
    expect(out).not.toContain(decodeURIComponent(new URL(upstream).password))
    // Its certificate's CA is in SOSIE_HOME, for a client that would rather trust it.
    expect(existsSync(join(home, 'tls', 'ca.pem'))).toBe(true)
    const port = Number(/,(\d+);/.exec(address)![1])
    const database = /Database=(\w+)/.exec(address)![1]!
    const client = await new Promise<Connection>((resolve, reject) => {
      const c = new Connection({ server: '127.0.0.1', authentication: { type: 'default', options: { userName: 'kim', password: 'x' } }, options: { port, database, trustServerCertificate: true } })
      c.on('connect', (e) => (e ? reject(e) : resolve(c)))
      c.connect()
    })
    const answer = await ask(client, 'SELECT TOP 2 email, full_name FROM users ORDER BY id')
    client.close()
    expect(canariesIn(JSON.stringify(answer))).toEqual([])
    expect(answer.sets[0]![0]!.email).toMatch(/@example\./)
    // Its entry for sosie mcp says what it is, and holds nothing real.
    const entry = readFileSync(join(home, 'running', `${child.pid}.json`), 'utf8')
    expect(JSON.parse(entry).sources[0]).toMatchObject({ kind: 'sqlserver', address })
    expect(entry).not.toContain(decodeURIComponent(new URL(upstream).password))
    // The query tool runs T-SQL through the running Sosie, several statements at once.
    const mcp = new Client({ name: 'test', version: '0.0.0' })
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: { ...process.env, SOSIE_HOME: home } as Record<string, string>, stderr: 'pipe' }))
    try {
      const text = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text
      const result = await mcp.callTool({ name: 'query', arguments: { sql: 'SELECT TOP 2 email, avatar FROM users ORDER BY id; SELECT COUNT(*) AS n FROM orders' } })
      expect(result.isError).toBeFalsy()
      expect(canariesIn(text(result))).toEqual([])
      const body = JSON.parse(text(result))
      expect(body.results[0].rows).toHaveLength(2)
      expect(body.results[0].rows[0].email).toMatch(/@example\./)
      expect(body.results[0].rows[0].avatar).toMatch(/^0x[0-9a-f]{8}$/)
      expect(body.results[1].rows).toEqual([{ n: 5 }])
      const refused = await mcp.callTool({ name: 'query', arguments: { sql: 'DELETE FROM users' } })
      expect(refused.isError).toBe(true)
      expect(text(refused)).toBe('This statement changes data. Sosie is read-only.')
    } finally {
      await mcp.close()
    }
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGINT')
      await exited
    }
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
