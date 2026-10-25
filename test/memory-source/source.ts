import type { Connection, Endpoint, Faker, Field, Schema, Source, Value } from '@sosie/core'

/**
 * A source that serves rows from memory. The core is tested through it, with
 * no database at all: proof that the core depends on no particular source.
 */
export interface MemoryData {
  schema: Schema
  rows: Record<string, Record<string, Value>[]>
}

export interface MemoryEndpoint extends Endpoint {
  /** Every row of an entity, faked. */
  rows(entity: string): Record<string, Value>[]
  /** Rows whose field equals a value the client saw, faked: a query by a fake. */
  where(entity: string, field: string, seen: string): Record<string, Value>[]
}

const endpoints = new Map<string, MemoryEndpoint>()

export function memorySource(data: MemoryData): Source {
  return {
    kind: 'memory',
    matches: (url) => url.protocol === 'memory:',
    async connect(upstream) {
      return memoryConnection(data, upstream.pathname || 'memory')
    },
    tools: [
      {
        name: 'rows',
        description: 'Every row of an entity.',
        input: { entity: { description: 'The entity.' } },
        async run(input, running) {
          const endpoint = endpoints.get(running.address)
          if (!endpoint) throw new Error(`Nothing serves ${running.address}`)
          return endpoint.rows(input.entity!)
        },
      },
    ],
  }
}

function memoryConnection(data: MemoryData, name: string): Connection {
  const fieldOf = (entity: string, name: string): Field => {
    const field = data.schema.entities.find((e) => e.id === entity)?.fields.find((f) => f.name === name)
    if (!field) throw new Error(`${entity}.${name} is not a field`)
    return field
  }
  const fakeRow = (entity: string, row: Record<string, Value>, faker: Faker) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, faker.value(v, fieldOf(entity, k))]))

  return {
    schema: data.schema,
    label: `memory/${name}`,
    summary: `${data.schema.entities.length} entities`,
    warnings: [],
    async serve(_listen, faker) {
      const address = `memory://${name}/${endpoints.size}`
      const endpoint: MemoryEndpoint = {
        address,
        rows: (entity) => (data.rows[entity] ?? []).map((row) => fakeRow(entity, row, faker)),
        where(entity, field, seen) {
          const real = faker.request().lookup(seen, fieldOf(entity, field)) ?? seen
          return (data.rows[entity] ?? []).filter((row) => row[field] === real).map((row) => fakeRow(entity, row, faker))
        },
        async close() {
          endpoints.delete(address)
        },
      }
      endpoints.set(address, endpoint)
      return endpoint
    },
    async close() {},
  }
}
