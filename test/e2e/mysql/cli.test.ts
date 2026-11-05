import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import mysql2 from 'mysql2/promise'
import { expect, inject, it } from 'vitest'
import { canariesIn } from '../canaries.js'

const CLI = fileURLToPath(new URL('../../../packages/cli/dist/cli.js', import.meta.url))
if (!existsSync(CLI)) throw new Error('Build the packages first: npm run build')

it('starts in front of MySQL from the command, says where clients connect, and serves them fakes, over MCP too', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sosie-cli-mysql-'))
  const upstream = inject('mysqlUpstream')
  const child = spawn(process.execPath, [CLI, '--port', '0'], {
    env: { ...process.env, NO_COLOR: '1', SOSIE_UPSTREAM: upstream, SOSIE_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no banner: ${out}`)), 30_000)
      child.stdout.on('data', () => out.includes('Claude Code:') && (clearTimeout(timer), resolve()))
      child.on('exit', () => (clearTimeout(timer), reject(new Error(`exited: ${out}`))))
    })
    expect(out).toMatch(/✓ 127\.0\.0\.1:\d+\/sosie_test_\w+, read-only: 3 tables, 1 view/)
    const address = /Your agent, app and mysql:\s+(mysql:\/\/127\.0\.0\.1:\d+\/\S+)/.exec(out)![1]!
    expect(out).not.toContain(new URL(upstream).password)
    const client = await mysql2.createConnection(address.replace('mysql://', 'mysql://kim@'))
    const [rows] = await client.query('SELECT email, full_name FROM users ORDER BY id LIMIT 2')
    expect(canariesIn(JSON.stringify(rows))).toEqual([])
    expect((rows as { email: string }[])[0]!.email).toMatch(/@example\./)
    await client.end()
    // Its entry for sosie mcp says what it is, and holds nothing real.
    const entry = readFileSync(join(home, 'running', `${child.pid}.json`), 'utf8')
    expect(JSON.parse(entry)).toMatchObject({ kind: 'mysql', address })
    expect(entry).not.toContain(new URL(upstream).password)
    // The query tool runs SQL through the running Sosie, several statements at once.
    const mcp = new Client({ name: 'test', version: '0.0.0' })
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: { ...process.env, SOSIE_HOME: home } as Record<string, string>, stderr: 'pipe' }))
    try {
      const text = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text
      const result = await mcp.callTool({ name: 'query', arguments: { sql: 'SELECT email, avatar FROM users ORDER BY id LIMIT 2; SELECT COUNT(*) AS n FROM orders' } })
      expect(result.isError).toBeFalsy()
      expect(canariesIn(text(result))).toEqual([])
      const body = JSON.parse(text(result))
      expect(body.results[0].rows).toHaveLength(2)
      expect(body.results[0].rows[0].email).toMatch(/@example\./)
      expect(body.results[0].rows[0].avatar).toMatch(/^0x[0-9a-f]{8}$/)
      expect(body.results[1].rows).toEqual([{ n: '5' }])
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
  }
})
