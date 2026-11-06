import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { MongoClient } from 'mongodb'
import { expect, inject, it } from 'vitest'
import { canariesIn } from '../canaries.js'

const CLI = fileURLToPath(new URL('../../../packages/cli/dist/cli.js', import.meta.url))
if (!existsSync(CLI)) throw new Error('Build the packages first: npm run build')

const text = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text

it('starts in front of MongoDB from the command, says where clients connect, and serves them fakes, over MCP too', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sosie-cli-mongodb-'))
  const upstream = inject('mongodbUpstream')
  // The project: one source, its upstream in the variable sosie.yml names.
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
    expect(out).toMatch(/✓ app  127\.0\.0\.1:\d+\/sosie_test_\w+, read-only: 3 collections, 1 view/)
    const address = /\n  app:\s+(mongodb:\/\/127\.0\.0\.1:\d+\/\S+)/.exec(out)![1]!
    expect(address).toContain('directConnection=true')
    expect(out).not.toContain(new URL(upstream).password)
    const client = new MongoClient(address, { serverMonitoringMode: 'poll' })
    const users = await client.db().collection('users').find({}, { projection: { email: 1, fullName: 1 } }).toArray()
    await client.close()
    expect(users).toHaveLength(40)
    expect(canariesIn(JSON.stringify(users))).toEqual([])
    const entry = readFileSync(join(home, 'running', `${child.pid}.json`), 'utf8')
    expect(JSON.parse(entry).sources[0]).toMatchObject({ kind: 'mongodb', address })
    expect(entry).not.toContain(new URL(upstream).password)

    const mcp = new Client({ name: 'test', version: '0.0.0' })
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: { ...process.env, SOSIE_HOME: home } as Record<string, string>, stderr: 'pipe' }))
    try {
      const names = (await mcp.listTools()).tools.map((t) => t.name)
      expect(names).toEqual(expect.arrayContaining(['describe', 'find', 'aggregate']))
      // The fields met so far are in describe, written to the running entry as documents came.
      for (let i = 0; i < 40 && !readFileSync(join(home, 'running', `${child.pid}.json`), 'utf8').includes('users.email'); i++) await new Promise((r) => setTimeout(r, 50))
      const described = JSON.parse(text(await mcp.callTool({ name: 'describe', arguments: { entity: 'users' } })))
      expect(described.sources[0].entities[0].fields).toContainEqual({ field: 'email', type: 'string' })
      const found = await mcp.callTool({ name: 'find', arguments: { collection: 'users', filter: '{"active": true}', projection: '{"email": 1}', limit: '3' } })
      expect(found.isError).toBeFalsy()
      expect(canariesIn(text(found))).toEqual([])
      const docs = JSON.parse(text(found)).documents
      expect(docs).toHaveLength(3)
      expect(docs[0]._id).toEqual({ $oid: expect.stringMatching(/^[0-9a-f]{24}$/) })
      // The fake a find showed finds its document again.
      const again = JSON.parse(text(await mcp.callTool({ name: 'find', arguments: { collection: 'users', filter: JSON.stringify({ _id: docs[0]._id }) } })))
      expect(again.documents[0].email).toBe(docs[0].email)
      const grouped = await mcp.callTool({ name: 'aggregate', arguments: { collection: 'orders', pipeline: '[{"$group": {"_id": "$status", "n": {"$sum": 1}}}]' } })
      expect(JSON.parse(text(grouped)).documents.map((d: { n: number }) => d.n).reduce((a: number, b: number) => a + b, 0)).toBe(5)
      const refused = await mcp.callTool({ name: 'aggregate', arguments: { collection: 'users', pipeline: '[{"$out": "copy"}]' } })
      expect(refused.isError).toBe(true)
      expect(text(refused)).toMatch(/Sosie does not run \$out/)
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
