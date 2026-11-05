import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql2 from 'mysql2/promise'
import { expect, inject, it } from 'vitest'
import { canariesIn } from '../canaries.js'

const CLI = fileURLToPath(new URL('../../../packages/cli/dist/cli.js', import.meta.url))
if (!existsSync(CLI)) throw new Error('Build the packages first: npm run build')

it('starts in front of MySQL from the command, says where clients connect, and serves them fakes', async () => {
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
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGINT')
      await exited
    }
    rmSync(home, { recursive: true, force: true })
  }
})
