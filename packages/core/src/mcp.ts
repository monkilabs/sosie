import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import { exactInteger } from './json.js'
import type { McpTool, Running, Schema } from './source.js'

export interface McpOptions {
  version: string
  /** Tools of every source this CLI knows, by source kind. */
  tools: { kind: string; tool: McpTool }[]
  /** Every running Sosie, the newest first; it throws a message for the agent when none runs. */
  running: () => Promise<Running[]>
  transport: Transport
}

const NOTE = 'Every value is a consistent fake: the same real value is always the same fake, so joins and lookups by a value you saw work.'

/** The MCP server: `describe` from the core, plus each source's tools. It never touches the upstream. */
export async function serveMcp({ version, tools, running, transport }: McpOptions): Promise<McpServer> {
  const server = new McpServer({ name: 'sosie', version })

  server.registerTool(
    'describe',
    {
      description:
        'The tables (or other entities) Sosie serves, with each field, its type, keys and references; with several upstreams, each one. ' +
        NOTE,
      inputSchema: { entity: z.string().optional().describe('One entity, such as users; all when left out.') },
      annotations: { readOnlyHint: true },
    },
    async ({ entity }) =>
      respond(async () => {
        const all = await running()
        if (all.length === 1) return describe(all[0]!.schema, all[0]!.passing, entity)
        const sources = all
          .map((r) => ({ kind: r.kind, address: r.address, ...describe(r.schema, r.passing, entity, false) }))
          // A Sosie whose schema is learned as values come has no entities yet: still listed, unless one is asked for.
          .filter((s) => !entity || s.entities.length)
        if (entity && !sources.length) throw new Error(`${entity} is not an entity of any upstream Sosie serves.`)
        return { note: NOTE, sources: sources.map(({ note: _, ...s }) => s) }
      }),
  )

  for (const { kind, tool } of tools) {
    const shape = Object.fromEntries(
      Object.entries(tool.input).map(([name, input]) => {
        const field = z.string().describe(input.description)
        return [name, input.optional ? field.optional() : field]
      }),
    )
    shape.address = z
      .string()
      .optional()
      .describe(`With several ${kind} Sosies running, the address of the one to use, as describe lists it; the newest when left out.`)
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: shape, annotations: { readOnlyHint: true } },
      async ({ address, ...input }: Record<string, string | undefined>) =>
        respond(async () => {
          const all = await running()
          const ofKind = all.filter((r) => r.kind === kind)
          if (!ofKind.length) {
            const kinds = [...new Set(all.map((r) => r.kind))].join(' and ')
            throw new Error(`Sosie serves ${kinds} here, not ${kind}: ${tool.name} is for ${kind}.`)
          }
          const target = address ? ofKind.find((r) => r.address === address) : ofKind[0]
          if (!target) throw new Error(`No ${kind} Sosie runs at ${address}. Running: ${ofKind.map((r) => r.address).join(', ')}.`)
          return tool.run(input, target)
        }),
    )
  }

  await server.connect(transport)
  return server
}

async function respond(work: () => Promise<unknown>) {
  try {
    const result = await work()
    return { content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] }
  } catch (error) {
    return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true }
  }
}

/** JSON with each of its lists cut to the first `max` items, for an agent's context; `cut` says whether one was. */
export function capLists(value: unknown, max: number): { value: unknown; cut: boolean } {
  let cut = false
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      if (node.length > max) cut = true
      return node.slice(0, max).map(walk)
    }
    if (node && typeof node === 'object' && exactInteger(node) === undefined) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]))
    return node
  }
  return { value: walk(value), cut }
}

/** The neutral schema as an agent reads it. */
export function describe(schema: Schema, passing: string[], only?: string, strict = true) {
  const pass = new Set(passing)
  const entities = schema.entities.filter((e) => !only || e.id === only || e.name === only)
  if (strict && only && !entities.length) {
    throw new Error(`${only} is not an entity. Entities: ${schema.entities.map((e) => e.id).join(', ')}.`)
  }
  return {
    note: NOTE,
    entities: entities.map((entity) => ({
      entity: entity.id,
      fields: entity.fields.map((field) => ({
        field: field.name,
        type: typeName(field.type),
        ...(field.key && { key: field.key }),
        ...(field.references && { references: field.references }),
        ...(pass.has(field.id) && { passes: 'real values, listed in sosie.yml' }),
      })),
    })),
  }
}

function typeName(type: Schema['entities'][number]['fields'][number]['type']): string {
  if (type.kind === 'array') return `${typeName(type.of)}[]`
  if (type.kind === 'enum') return `enum(${type.labels.join(', ')})`
  return type.kind
}
