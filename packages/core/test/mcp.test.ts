import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { serveMcp } from '../src/mcp.js'
import type { McpTool, Running } from '../src/source.js'
import { schema } from '../../../test/memory-source/fixtures.js'

const echo: McpTool = {
  name: 'echo',
  description: 'Echo the input.',
  input: { text: { description: 'Text.' }, extra: { description: 'More.', optional: true } },
  run: async (input, running) => ({ ...input, address: running.address }),
}

async function connect(running: () => Promise<Running[]>, tools = [{ kind: 'memory', tool: echo }]) {
  const [server, client] = InMemoryTransport.createLinkedPair()
  await serveMcp({ version: '0.0.0', tools, running, transport: server })
  const mcp = new Client({ name: 'test', version: '0.0.0' })
  await mcp.connect(client)
  return mcp
}

const text = (result: unknown) => ((result as { content: { text: string }[] }).content[0]!.text)

describe('sosie mcp', () => {
  const one: Running = { name: 'app', kind: 'memory', address: 'memory://app', schema, passing: ['orders.status'] }
  const running = async (): Promise<Running[]> => [one]

  it('lists describe and the source tools', async () => {
    const mcp = await connect(running)
    const { tools } = await mcp.listTools()
    expect(tools.map((t) => t.name)).toEqual(['describe', 'echo'])
    expect(tools[1]!.inputSchema.required).toEqual(['text'])
    expect(Object.keys(tools[1]!.inputSchema.properties!)).toEqual(['text', 'extra', 'source'])
  })

  it('marks every tool read-only: describe, one two kinds share, and one of a single kind', async () => {
    const tools = [
      { kind: 'memory', tool: echo },
      { kind: 'other', tool: echo },
      { kind: 'memory', tool: { ...echo, name: 'count' } },
    ]
    const mcp = await connect(running, tools)
    expect((await mcp.listTools()).tools.map((t) => [t.name, t.annotations])).toEqual([
      ['describe', { readOnlyHint: true }],
      ['echo', { readOnlyHint: true }],
      ['count', { readOnlyHint: true }],
    ])
  })

  it('describes entities, fields, keys, references and what passes', async () => {
    const mcp = await connect(running)
    const all = JSON.parse(text(await mcp.callTool({ name: 'describe', arguments: {} })))
    expect(all.sources.map((s: { source: string; kind: string; address: string }) => [s.source, s.kind, s.address])).toEqual([['app', 'memory', 'memory://app']])
    expect(all.sources[0].entities.map((e: { entity: string }) => e.entity)).toEqual(['users', 'orders', 'countries'])
    const orders = JSON.parse(text(await mcp.callTool({ name: 'describe', arguments: { entity: 'orders' } })))
    expect(orders.note).toMatch(/consistent fake/)
    expect(orders.sources[0].entities[0].fields).toContainEqual({ field: 'user_id', type: 'integer', references: 'users.id' })
    expect(orders.sources[0].entities[0].fields).toContainEqual({
      field: 'status',
      type: 'enum(new, paid, shipped)',
      passes: 'real values, listed in sosie.yml',
    })
    const missing = await mcp.callTool({ name: 'describe', arguments: { entity: 'order' } })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toMatch(/order is not an entity of any upstream/)
  })

  it('runs a source tool against the running endpoint', async () => {
    const mcp = await connect(running)
    const result = JSON.parse(text(await mcp.callTool({ name: 'echo', arguments: { text: 'hi' } })))
    expect(result).toEqual({ text: 'hi', address: 'memory://app' })
  })

  it('says how to start Sosie when it is not running, and refuses a tool of another source', async () => {
    const stopped = await connect(async () => {
      throw new Error('Sosie is not running.')
    })
    const result = await stopped.callTool({ name: 'describe', arguments: {} })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Sosie is not running.')
    const other = await connect(async () => [{ ...one, name: 'shop', kind: 'postgres' }])
    expect(text(await other.callTool({ name: 'echo', arguments: { text: 'hi' } }))).toBe('Sosie serves postgres here, not memory: echo is for memory.')
  })

  it('serves a tool two kinds share by one name, run by the kind of the source it goes to', async () => {
    const other: McpTool = { ...echo, run: async (input, running) => ({ ...input, by: 'other', address: running.address }) }
    const sql: Running = { ...one, name: 'db', kind: 'other', address: 'other://db' }
    const tools = [
      { kind: 'memory', tool: echo },
      { kind: 'other', tool: other },
    ]
    const mcp = await connect(async () => [sql, one], tools)
    expect((await mcp.listTools()).tools.map((t) => t.name)).toEqual(['describe', 'echo'])
    expect(text(await mcp.callTool({ name: 'echo', arguments: { text: 'hi' } }))).toBe('Several memory or other sources run: db, app. Name the one to use in source.')
    expect(JSON.parse(text(await mcp.callTool({ name: 'echo', arguments: { text: 'hi', source: 'db' } })))).toEqual({ text: 'hi', by: 'other', address: 'other://db' })
    const chosen = await mcp.callTool({ name: 'echo', arguments: { text: 'hi', source: 'app' } })
    expect(JSON.parse(text(chosen))).toEqual({ text: 'hi', address: 'memory://app' })
    const neither = await connect(async () => [{ ...one, name: 'api', kind: 'rest' }], tools)
    expect(text(await neither.callTool({ name: 'echo', arguments: { text: 'hi' } }))).toBe('Sosie serves rest here, not memory or other: echo is for memory or other.')
  })

  it('serves every source: describe each by its name, and send a tool to the one named', async () => {
    const api: Running = { name: 'billing', kind: 'rest', address: 'http://localhost:7675', schema: { entities: [{ id: 'User', name: 'User', fields: [] }] }, passing: [] }
    const crm: Running = { ...one, name: 'crm', address: 'memory://crm' }
    const mcp = await connect(async () => [api, one, crm])
    const all = JSON.parse(text(await mcp.callTool({ name: 'describe', arguments: {} })))
    expect(all.sources.map((s: { source: string; kind: string; address: string }) => [s.source, s.kind, s.address])).toEqual([
      ['billing', 'rest', 'http://localhost:7675'],
      ['app', 'memory', 'memory://app'],
      ['crm', 'memory', 'memory://crm'],
    ])
    const users = JSON.parse(text(await mcp.callTool({ name: 'describe', arguments: { entity: 'users' } })))
    expect(users.sources.map((s: { source: string }) => s.source)).toEqual(['app', 'crm'])
    // Never the wrong database without knowing: with two of a kind, the agent names one.
    const unnamed = await mcp.callTool({ name: 'echo', arguments: { text: 'hi' } })
    expect(unnamed.isError).toBe(true)
    expect(text(unnamed)).toBe('Several memory sources run: app, crm. Name the one to use in source.')
    expect(JSON.parse(text(await mcp.callTool({ name: 'echo', arguments: { text: 'hi', source: 'crm' } })))).toEqual({ text: 'hi', address: 'memory://crm' })
    expect(text(await mcp.callTool({ name: 'echo', arguments: { text: 'hi', source: 'billing' } }))).toBe('billing is a rest source: echo is for memory (app, crm).')
    expect(text(await mcp.callTool({ name: 'echo', arguments: { text: 'hi', source: 'shop' } }))).toBe('No memory source is named shop: app, crm.')
  })

  it('never picks one of two sources that share a name, run by two Sosies: it says where each is', async () => {
    // Two projects' Sosies, each with a source named app, as sosie init suggests the database's name.
    const theirs: Running = { ...one, address: 'memory://other-project/app' }
    const mcp = await connect(async () => [theirs, one])
    const said = 'Two running Sosies have a source named app, at memory://other-project/app and memory://app. Stop one, or rename its source in sosie.yml.'
    for (const args of [{ text: 'hi' }, { text: 'hi', source: 'app' }]) {
      const result = await mcp.callTool({ name: 'echo', arguments: args })
      expect(result.isError).toBe(true)
      expect(text(result)).toBe(said)
    }
    // A name only one of them has is still found.
    const crm = await connect(async () => [theirs, one, { ...one, name: 'crm', address: 'memory://crm' }])
    expect(JSON.parse(text(await crm.callTool({ name: 'echo', arguments: { text: 'hi', source: 'crm' } })))).toEqual({ text: 'hi', address: 'memory://crm' })
  })

  it('lists a Sosie that has met no entity yet, as an API without a schema document', async () => {
    const learning: Running = { name: 'api', kind: 'rest', address: 'http://localhost:7675', schema: { entities: [] }, passing: [] }
    const mcp = await connect(async () => [learning, one])
    const all = JSON.parse(text(await mcp.callTool({ name: 'describe', arguments: {} })))
    expect(all.sources.map((s: { address: string; entities: unknown[] }) => [s.address, s.entities.length])).toEqual([
      ['http://localhost:7675', 0],
      ['memory://app', 3],
    ])
  })
})
