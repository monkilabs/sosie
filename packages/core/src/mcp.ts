import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import { exactInteger } from './json.js'
import type { McpTool, Running, Schema } from './source.js'

export interface McpOptions {
  version: string
  /** Tools of every source this CLI knows, by source kind. */
  tools: { kind: string; tool: McpTool }[]
  /** Every source of every running Sosie, the newest Sosie's first; it throws a message for the agent when none runs. */
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
        'Each source Sosie serves, by its name, with its tables (or other entities), each field, its type, keys and references. ' + NOTE,
      inputSchema: { entity: z.string().optional().describe('One entity, such as users; all when left out.') },
      annotations: { readOnlyHint: true },
    },
    async ({ entity }) =>
      respond(async () => {
        const all = await running()
        const sources = all
          .map((r) => ({ source: r.name, kind: r.kind, address: r.address, ...describe(r.schema, r.passing, entity, false) }))
          // A Sosie whose schema is learned as values come has no entities yet: still listed, unless one is asked for.
          .filter((s) => !entity || s.entities.length)
        if (entity && !sources.length) throw new Error(`${entity} is not an entity of any upstream Sosie serves.`)
        return { note: NOTE, sources: sources.map(({ note: _, ...s }) => s) }
      }),
  )

  // Sources may share a tool's name (query, for SQL): one tool, run by the source of the Sosie it goes to.
  const byName = new Map<string, { kind: string; tool: McpTool }[]>()
  for (const entry of tools) byName.set(entry.tool.name, [...(byName.get(entry.tool.name) ?? []), entry])
  for (const [name, group] of byName) {
    const kinds = group.map((g) => g.kind)
    const kind = kinds.join(' or ')
    const inputs = Object.assign({}, ...group.map((g) => g.tool.input)) as McpTool['input']
    const shape = Object.fromEntries(
      Object.entries(inputs).map(([key, input]) => {
        const field = z.string().describe(input.description)
        return [key, input.optional ? field.optional() : field]
      }),
    )
    shape.source = z
      .string()
      .optional()
      .describe(`The ${kind} source to use, by its name as describe lists it: needed only when several run.`)
    server.registerTool(
      name,
      { description: group[0]!.tool.description, inputSchema: shape, annotations: { readOnlyHint: true } },
      async ({ source, ...input }: Record<string, string | undefined>) =>
        respond(async () => {
          const all = await running()
          const ofKind = all.filter((r) => kinds.includes(r.kind))
          if (!ofKind.length) {
            const serving = [...new Set(all.map((r) => r.kind))].join(' and ')
            throw new Error(`Sosie serves ${serving} here, not ${kind}: ${name} is for ${kind}.`)
          }
          const names = [...new Set(ofKind.map((r) => r.name))].join(', ')
          const target = pick(all, ofKind, source, name, kind)
          return group.find((g) => g.kind === target.kind)!.tool.run(input, target)
        }),
    )
  }

  await server.connect(transport)
  return server
}

/** The source a tool goes to: the one named, or the only one of its kind. Never the wrong database without knowing. */
function pick(all: Running[], ofKind: Running[], source: string | undefined, tool: string, kind: string): Running {
  const names = [...new Set(ofKind.map((r) => r.name))].join(', ')
  // Sosies of two projects may each have a source of one name: neither is the one meant, without knowing which.
  const only = (found: Running[]) => {
    if (found.length === 1) return found[0]!
    const count = found.length === 2 ? 'Two' : String(found.length)
    const at = `${found.slice(0, -1).map((r) => r.address).join(', ')} and ${found.at(-1)!.address}`
    throw new Error(`${count} running Sosies have a source named ${found[0]!.name}, at ${at}. Stop one, or rename its source in sosie.yml.`)
  }
  if (source) {
    const named = ofKind.filter((r) => r.name === source)
    if (named.length) return only(named)
    const other = all.find((r) => r.name === source)
    throw new Error(other ? `${source} is a ${other.kind} source: ${tool} is for ${kind} (${names}).` : `No ${kind} source is named ${source}: ${names}.`)
  }
  if (new Set(ofKind.map((r) => r.name)).size === 1) return only(ofKind)
  throw new Error(`Several ${kind} sources run: ${names}. Name the one to use in source.`)
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
  if (type.kind === 'range') return `range(${typeName(type.of)})`
  if (type.kind === 'enum') return `enum(${type.labels.join(', ')})`
  return type.kind
}
