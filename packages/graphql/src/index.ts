import { readFileSync } from 'node:fs'
import { readCapped, secretParts, upstreamHeaders, why, type Connection, type Field, type Source } from '@sosie/core'
import { buildClientSchema, buildSchema, getIntrospectionQuery, validateSchema, type GraphQLSchema, type IntrospectionQuery } from 'graphql'
import { startEndpoint } from './endpoint.js'
import { graphqlTool } from './mcp.js'
import { readSchema } from './schema.js'
import { GraphqlUpstream } from './upstream.js'

/** The GraphQL source: a local GraphQL endpoint in front of the team's own API, queries only, every value faked. */
export const graphql: Source = {
  kind: 'graphql',
  // An http(s) URL with graphql in its path: /graphql, /v1/graphql, /graphql/v1 (Supabase), /graphql.json
  // (Shopify). At another path (gqlgen's /query), kind: graphql in sosie.yml says it is GraphQL. Any other is REST's.
  title: 'GraphQL API',
  schemes: ['http:', 'https:'],
  matches: (url) => (url.protocol === 'http:' || url.protocol === 'https:') && /\/graphql(\.json)?(\/|$)/i.test(url.pathname),
  settings: ['headers', 'schema'],
  async connect(upstream, options): Promise<Connection> {
    const headers = upstreamHeaders(options.headers)
    const user = decodeURIComponent(upstream.username)
    const password = decodeURIComponent(upstream.password)
    if (user) headers.authorization ??= `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
    const secrets = secretParts(headers, [...new URL(upstream.href).searchParams.values(), user, password])
    const url = new URL(upstream.href)
    // A query on the URL (?api_key=) is a credential too: sent with every request, never shown.
    url.username = url.password = url.hash = ''
    const api = new GraphqlUpstream(url, headers, options.statementTimeout)
    const label = `${url.host}${url.pathname}`

    let schema: GraphQLSchema
    if (options.schema) {
      try {
        schema = fromFile(await readSchemaText(options.schema, api))
      } catch (error) {
        throw new Error(`Cannot read its schema: ${(error as Error).message}`)
      }
    } else {
      let answer
      try {
        answer = await api.post({ query: getIntrospectionQuery() })
      } catch (error) {
        throw new Error(`Cannot reach ${label}: ${why(error)}`)
      }
      let result: { data?: IntrospectionQuery; errors?: { message: string }[] } = {}
      try {
        result = JSON.parse(answer.body)
      } catch {
        // Handled below.
      }
      if (!result.data?.__schema) {
        const why = result.errors?.[0]?.message ?? `it answered ${answer.status}`
        throw new Error(`Cannot read the schema of ${label} by introspection (${why}). Give the source a schema: its SDL file.`)
      }
      schema = buildClientSchema(result.data)
    }

    // Every query is checked against the schema: one that is not valid GraphQL would fail them all.
    const problem = validateSchema(schema)[0]
    if (problem) throw new Error(`The schema of ${label} is not valid GraphQL: ${problem.message}`)
    const neutral = readSchema(schema)
    const fields = new Map<string, Field>(neutral.entities.flatMap((e) => e.fields.map((f) => [f.id, f] as const)))
    const queries = Object.keys(schema.getQueryType()?.getFields() ?? {}).length
    return {
      schema: neutral,
      label,
      summary: `${neutral.entities.length} types, ${queries} ${queries === 1 ? 'query' : 'queries'}`,
      warnings: [],
      client: 'curl',
      serve: (listen, faker) => startEndpoint(listen, { upstream: api, schema, fields, faker, maxItems: options.maxRows, secrets, log: (line) => process.stderr.write(`  ! ${line}\n`) }),
      async close() {},
    }
  },
  tools: [graphqlTool],
}

/**
 * A schema from a file, or a URL: at the API's own origin with its credentials, and no redirect followed, as they would
 * go along; elsewhere with none.
 */
async function readSchemaText(location: string, api: GraphqlUpstream): Promise<string> {
  if (!/^https?:\/\//i.test(location)) return readFileSync(location, 'utf8')
  const url = new URL(location)
  const own = url.origin === api.url.origin
  const response = await fetch(url, {
    headers: { 'user-agent': 'sosie', ...(own && api.headers) },
    redirect: own ? 'manual' : 'follow',
    signal: AbortSignal.timeout(api.timeout),
  })
  if (response.status !== 200) {
    await response.body?.cancel()
    throw new Error(`${url.host}${url.pathname} answered ${response.status}.`)
  }
  return readCapped(response, MAX_SCHEMA)
}

/** A schema's size at most: the largest public ones are a few MB. */
const MAX_SCHEMA = 20 * 1024 * 1024

/** A schema file: SDL, or an introspection result as JSON. */
function fromFile(text: string): GraphQLSchema {
  if (!text.trimStart().startsWith('{')) return buildSchema(text)
  const json = JSON.parse(text)
  return buildClientSchema(json.data ?? json)
}

export { readSchema } from './schema.js'
