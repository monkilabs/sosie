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

async function connect(running: () => Promise<Running[]>) {
  const [server, client] = InMemoryTransport.createLinkedPair()
  await serveMcp({ version: '0.0.0', tools: [{ kind: 'memory', tool: echo }], running, transport: server })
  const mcp = new Client({ name: 'test', version: '0.0.0' })
  await mcp.connect(client)
  return mcp
}

const text = (result: unknown) => ((result as { content: { text: string }[] }).content[0]!.text)

describe('sosie mcp', () => {
  const one: Running = { kind: 'memory', address: 'memory://app', schema, passing: ['orders.status'] }
  const running = async (): Promise<Running[]> => [one]

  it('lists describe and the source tools', async () => {
    const mcp = await connect(running)
    const { tools } = await mcp.listTools()
    expect(tools.map((t) => t.name)).toEqual(['describe', 'echo'])
    expect(tools[1]!.inputSchema.required).toEqual(['text'])
  })

  it('describes entities, fields, keys, references and what passes', async () => {
    const mcp = await connect(running)
    const all = JSON.parse(text(await mcp.callTool({ name: 'describe', arguments: {} })))
    expect(all.entities.map((e: { entity: string }) => e.entity)).toEqual(['users', 'orders', 'countries'])
    const orders = JSON.parse(text(await mcp.callTool({ name: 'describe', arguments: { entity: 'orders' } })))
    expect(orders.note).toMatch(/consistent fake/)
    expect(orders.entities[0].fields).toContainEqual({ field: 'user_id', type: 'integer', references: 'users.id' })
    expect(orders.entities[0].fields).toContainEqual({
      field: 'status',
      type: 'enum(new, paid, shipped)',
      passes: 'real values, listed in sosie.yml',
    })
    const missing = await mcp.callTool({ name: 'describe', arguments: { entity: 'order' } })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toMatch(/order is not an entity/)
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
    const other = await connect(async () => [{ ...one, kind: 'postgres' }])
    expect(text(await other.callTool({ name: 'echo', arguments: { text: 'hi' } }))).toBe('Sosie serves postgres here, not memory: echo is for memory.')
  })

  it('serves every running Sosie: describe each, and send a tool to the newest of its kind', async () => {
    const api: Running = { kind: 'rest', address: 'http://localhost:7675', schema: { entities: [{ id: 'User', name: 'User', fields: [] }] }, passing: [] }
    const older: Running = { ...one, address: 'memory://older' }
    const mcp = await connect(async () => [api, one, older])
    const all = JSON.parse(text(await mcp.callTool({ name: 'describe', arguments: {} })))
    expect(all.sources.map((s: { kind: string; address: string }) => [s.kind, s.address])).toEqual([
      ['rest', 'http://localhost:7675'],
      ['memory', 'memory://app'],
      ['memory', 'memory://older'],
    ])
    const users = JSON.parse(text(await mcp.callTool({ name: 'describe', arguments: { entity: 'users' } })))
    expect(users.sources.map((s: { address: string }) => s.address)).toEqual(['memory://app', 'memory://older'])
    expect(JSON.parse(text(await mcp.callTool({ name: 'echo', arguments: { text: 'hi' } }))).address).toBe('memory://app')
  })
})
