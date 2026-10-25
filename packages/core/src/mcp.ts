import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import type { McpTool, Running, Schema } from './source.js'

export interface McpOptions {
  version: string
  /** Tools of every source this CLI knows, by source kind. */
  tools: { kind: string; tool: McpTool }[]
  /** The running Sosie; it throws a message for the agent when none runs. */
  running: () => Promise<Running>
  transport: Transport
}

const NOTE = 'Every value is a consistent fake: the same real value is always the same fake, so joins and lookups by a value you saw work.'

/** The MCP server: `describe` from the core, plus each source's tools. It never touches the upstream. */
export async function serveMcp({ version, tools, running, transport }: McpOptions): Promise<McpServer> {
  const server = new McpServer({ name: 'sosie', version })

  server.registerTool(
    'describe',
    {
      description: 'The tables (or other entities) Sosie serves, with each field, its type, keys and references. ' + NOTE,
      inputSchema: { entity: z.string().optional().describe('One entity, such as users; all when left out.') },
      annotations: { readOnlyHint: true },
    },
    async ({ entity }) =>
      respond(async () => {
        const now = await running()
        return describe(now.schema, now.passing, entity)
      }),
  )

  for (const { kind, tool } of tools) {
    const shape = Object.fromEntries(
      Object.entries(tool.input).map(([name, input]) => {
        const field = z.string().describe(input.description)
        return [name, input.optional ? field.optional() : field]
      }),
    )
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: shape, annotations: { readOnlyHint: true } },
      async (input: Record<string, string | undefined>) =>
        respond(async () => {
          const now = await running()
          if (now.kind !== kind) throw new Error(`The running Sosie serves a ${now.kind} upstream; ${tool.name} is for ${kind}.`)
          return tool.run(input, now)
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

/** The neutral schema as an agent reads it. */
export function describe(schema: Schema, passing: string[], only?: string) {
  const pass = new Set(passing)
  const entities = schema.entities.filter((e) => !only || e.id === only || e.name === only)
  if (only && !entities.length) throw new Error(`${only} is not an entity. Entities: ${schema.entities.map((e) => e.id).join(', ')}.`)
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
