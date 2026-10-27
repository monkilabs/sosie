import { readFileSync } from 'node:fs'
import { upstreamHeaders, type Connection, type Field, type Source } from '@sosie/core'
import { buildClientSchema, buildSchema, getIntrospectionQuery, type GraphQLSchema, type IntrospectionQuery } from 'graphql'
import { startEndpoint } from './endpoint.js'
import { graphqlTool } from './mcp.js'
import { readSchema } from './schema.js'
import { GraphqlUpstream } from './upstream.js'

/** The GraphQL source: a local GraphQL endpoint in front of the team's own API, queries only, every value faked. */
export const graphql: Source = {
  kind: 'graphql',
  // An http(s) URL whose path ends in graphql: /graphql, /api/graphql. Any other is REST's.
  matches: (url) => (url.protocol === 'http:' || url.protocol === 'https:') && /graphql\/?$/i.test(url.pathname),
  async connect(upstream, options): Promise<Connection> {
    const env = options.env ?? {}
    const headers = upstreamHeaders(env.SOSIE_UPSTREAM_HEADERS)
    if (upstream.username) {
      headers.authorization ??= `Basic ${Buffer.from(`${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`).toString('base64')}`
    }
    const url = new URL(upstream.href)
    url.username = url.password = url.search = url.hash = ''
    const api = new GraphqlUpstream(url, headers, options.statementTimeout)
    const label = `${url.host}${url.pathname}`

    let schema: GraphQLSchema
    if (env.SOSIE_GRAPHQL_SCHEMA) {
      try {
        schema = fromFile(readFileSync(env.SOSIE_GRAPHQL_SCHEMA, 'utf8'))
      } catch (error) {
        throw new Error(`SOSIE_GRAPHQL_SCHEMA: ${(error as Error).message}`)
      }
    } else {
      let answer
      try {
        answer = await api.post({ query: getIntrospectionQuery() })
      } catch (error) {
        throw new Error(`Cannot reach ${label}: ${(error as Error).message}`)
      }
      let result: { data?: IntrospectionQuery; errors?: { message: string }[] } = {}
      try {
        result = JSON.parse(answer.body)
      } catch {
        // Handled below.
      }
      if (!result.data?.__schema) {
        const why = result.errors?.[0]?.message ?? `it answered ${answer.status}`
        throw new Error(`Cannot read the schema of ${label} by introspection (${why}). Set SOSIE_GRAPHQL_SCHEMA to its SDL file.`)
      }
      schema = buildClientSchema(result.data)
    }

    const neutral = readSchema(schema)
    const fields = new Map<string, Field>(neutral.entities.flatMap((e) => e.fields.map((f) => [f.id, f] as const)))
    const queries = Object.keys(schema.getQueryType()?.getFields() ?? {}).length
    return {
      schema: neutral,
      label,
      summary: `${neutral.entities.length} types, ${queries} ${queries === 1 ? 'query' : 'queries'}`,
      warnings: [],
      client: 'curl',
      serve: (listen, faker) => startEndpoint(listen, { upstream: api, schema, fields, faker, log: (line) => process.stderr.write(`  ! ${line}\n`) }),
      async close() {},
    }
  },
  tools: [graphqlTool],
}

/** A schema file: SDL, or an introspection result as JSON. */
function fromFile(text: string): GraphQLSchema {
  if (!text.trimStart().startsWith('{')) return buildSchema(text)
  const json = JSON.parse(text)
  return buildClientSchema(json.data ?? json)
}

export { readSchema } from './schema.js'
