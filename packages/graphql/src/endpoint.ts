import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { localRequest, pacer, singular, why, type Endpoint, type Faker, type Field } from '@sosie/core'
import {
  execute,
  getOperationAST,
  getVariableValues,
  Kind,
  parse,
  print,
  validate,
  valueFromASTUntyped,
  visit,
  type DocumentNode,
  type DefinitionNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type GraphQLSchema,
  type SelectionNode,
} from 'graphql'
import { fakeData, TYPENAME } from './fake.js'
import { rewrite } from './rewrite.js'
import type { GraphqlUpstream } from './upstream.js'

export interface GraphqlContext {
  upstream: GraphqlUpstream
  schema: GraphQLSchema
  /** Fields of the neutral schema, by id. */
  fields: Map<string, Field>
  faker: Faker
  /** Items of a list at most, as --max-rows. */
  maxItems: number
  log: (line: string) => void
}

interface Request {
  query?: unknown
  variables?: unknown
  operationName?: unknown
  extensions?: { persistedQuery?: unknown }
}

const MAX_REQUEST = 1024 * 1024
const RESOLVER_FAILED = 'A resolver failed; Sosie hides its message, which may quote a value from your data.'
const REFUSED = 'The API refused the query; Sosie hides its message, which may quote a value from your data.'
/** Error codes as servers write them; a code of another shape could be anything, and is dropped. */
const CODES = new Set([
  'GRAPHQL_PARSE_FAILED', 'GRAPHQL_VALIDATION_FAILED', 'BAD_USER_INPUT', 'BAD_REQUEST', 'UNAUTHENTICATED', 'UNAUTHORIZED', 'FORBIDDEN',
  'NOT_FOUND', 'CONFLICT', 'TIMEOUT', 'RATE_LIMITED', 'INTERNAL_SERVER_ERROR', 'PERSISTED_QUERY_NOT_FOUND', 'PERSISTED_QUERY_NOT_SUPPORTED',
  'validation-failed', 'access-denied', 'permission-error', 'constraint-violation', 'data-exception', 'not-exists', 'already-exists',
  'not-supported', 'parse-failed', 'invalid-jwt', 'invalid-headers', 'postgres-error', 'unexpected',
])
/** A code of words joined by _, one of which says what went wrong: ACCESS_DENIED, QUERY_TOO_COMPLEX. */
const CODE_WORDS = /(^|_)(ERROR|FAILED|FAILURE|INVALID|DENIED|FORBIDDEN|NOT|BAD|UNAUTHENTICATED|UNAUTHORIZED|LIMIT|EXCEEDED|TIMEOUT|MISSING|REQUIRED|CONFLICT|UNAVAILABLE|UNSUPPORTED|VIOLATION|EXPIRED|TOO)(_|$)/
const errorCode = (code: unknown): code is string =>
  typeof code === 'string' && (CODES.has(code) || (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(code) && CODE_WORDS.test(code)))
/** Tokens a query may have: parsing and checking a larger one would keep other clients waiting. */
const MAX_TOKENS = 10_000

/**
 * The local GraphQL address, at the API's own path. Each operation is parsed
 * and checked against the schema, its variables too; only queries reach the
 * API, with their fakes turned back into real values, and every value of
 * `data` comes back faked. Introspection is answered from the schema.
 */
export async function startEndpoint(listen: { host: string; port: number }, ctx: GraphqlContext): Promise<Endpoint> {
  const path = ctx.upstream.url.pathname
  const byWord = new Map([...new Set([...ctx.fields.keys()].map((id) => id.slice(0, id.indexOf('.'))))].map((name) => [singular(name.toLowerCase()), name]))
  const names = { fields: ctx.fields, entityFor: (word: string) => byWord.get(singular(word.toLowerCase())) }

  const one = async (request: unknown): Promise<{ status: number; body: unknown }> => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return failed(400, 'A request is a JSON object with a query.')
    const { query, variables = {}, operationName, extensions } = request as Request
    if (typeof query !== 'string') {
      const message = extensions?.persistedQuery
        ? 'Sosie needs the query text: it does not support persisted queries.'
        : 'The request has no query.'
      return failed(400, message)
    }
    if (variables !== null && (typeof variables !== 'object' || Array.isArray(variables))) return failed(400, 'The variables are a JSON object.')
    if (operationName !== undefined && operationName !== null && typeof operationName !== 'string') return failed(400, 'The operationName is a string.')
    let document: DocumentNode
    try {
      document = parse(query, { maxTokens: MAX_TOKENS })
    } catch (error) {
      return failed(400, (error as Error).message)
    }
    // Errors of the request against the schema hold only what the client wrote, and the schema.
    const invalid = validate(ctx.schema, document)
    if (invalid.length) return { status: 400, body: { errors: invalid.map(clientError) } }
    const operation = getOperationAST(document, operationName ?? undefined)
    if (!operation) return failed(400, 'Name the operation to run: the document has several.')
    if (operation.operation !== 'query') {
      return failed(400, 'Sosie is read-only: only queries reach the API, not mutations or subscriptions.', 'SOSIE_READ_ONLY')
    }
    if (usesName(document, TYPENAME)) return failed(400, `Sosie uses the name ${TYPENAME} itself: choose another alias.`)
    // Variables are checked here as well, so an API never answers about one with the real value Sosie put in it.
    const given = (variables ?? {}) as Record<string, unknown>
    const checked = getVariableValues(ctx.schema, operation.variableDefinitions ?? [], given)
    if (checked.errors) return { status: 400, body: { errors: checked.errors.map(clientError) } }

    const fragments: Record<string, FragmentDefinitionNode> = Object.fromEntries(
      document.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION).map((d) => [d.name.value, d]),
    )
    // Introspection is answered from the schema Sosie holds, with what the client sent: the API never sees it.
    const roots = rootFields(operation.selectionSet.selections, fragments)
    if (roots.every((f) => f.name.value.startsWith('__'))) {
      return { status: 200, body: await execute({ schema: ctx.schema, document, operationName: operationName ?? undefined, variableValues: given }) }
    }
    if (roots.some((f) => f.name.value === '__schema' || f.name.value === '__type')) {
      return failed(400, 'Ask for __schema and __type in a query of their own: Sosie answers them from the schema, without the API.')
    }

    // A variable's default is a value the client wrote too: it goes as a variable, so it is turned back like one.
    const values = { ...given }
    for (const definition of operation.variableDefinitions ?? []) {
      const name = definition.variable.name.value
      if (!(name in values) && definition.defaultValue) values[name] = valueFromASTUntyped(definition.defaultValue)
    }
    const sent = `${query}\n${JSON.stringify(values)}`
    const scope = ctx.faker.request(sent)
    const real = rewrite(ctx.schema, document, values, scope, names)
    const answer = await ctx.upstream.post({
      // Only the operation to run, and the fragments it uses: no other operation's text, a mutation's least of all, leaves Sosie.
      query: print({ ...real.document, definitions: only(real.document.definitions, document.definitions.indexOf(operation)) }),
      variables: real.variables,
      ...(operationName && { operationName }),
    })
    if (answer.status === 401 || answer.status === 403) ctx.log(`The API answered ${answer.status}: check SOSIE_UPSTREAM_HEADERS.`)
    if (!/json/i.test(answer.type)) return failed(502, `The API answered with ${answer.type.split(';')[0] || 'no content type'}; Sosie fakes JSON only.`)
    let body: { data?: unknown; errors?: unknown }
    try {
      body = JSON.parse(answer.body)
    } catch {
      return failed(502, 'The API answered with JSON that does not parse.')
    }
    if (!body || typeof body !== 'object') return failed(502, 'The API answered with JSON that is not a GraphQL response.')

    const keys = responseKeys(document)
    const executed = 'data' in body
    const faked = await fakeData(body.data, operation.selectionSet.selections, ctx.schema.getQueryType()!, {
      schema: ctx.schema,
      faker: ctx.faker,
      fields: ctx.fields,
      fragments,
      maxItems: ctx.maxItems,
      pace: pacer(),
      scope,
      sent,
    })
    const errors = Array.isArray(body.errors) ? (body.errors as { path?: unknown; extensions?: { code?: unknown } }[]) : []
    return {
      status: answer.status,
      body: {
        ...(executed && { data: faked.data }),
        ...(errors.length && {
          // Sosie checked the query and its variables itself: what the API says beyond that may quote data, so
          // only where it happened and its code come back.
          errors: errors.map((e) => ({
            message: executed ? RESOLVER_FAILED : REFUSED,
            ...(validPath(e?.path, keys, ctx.maxItems) && { path: e.path }),
            ...(errorCode(e?.extensions?.code) && { extensions: { code: e.extensions.code } }),
          })),
        }),
        ...(faked.cut && {
          extensions: {
            sosie: `Sosie returned the first ${ctx.maxItems} items of a list; the rest were cut. Narrow the query, or start Sosie with a higher --max-rows.`,
          },
        }),
      },
    }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!localRequest(req.headers.host, listen.host)) return send(res, 403, { errors: [{ message: 'Sosie answers requests for localhost only.' }] })
    const url = new URL(req.url ?? '/', 'http://sosie.local')
    if (url.pathname.replace(/\/$/, '') !== path.replace(/\/$/, '')) return send(res, 404, { errors: [{ message: `Sosie serves the GraphQL API at ${path}.` }] })
    let request: unknown
    if (req.method === 'GET') {
      let variables: unknown
      try {
        variables = url.searchParams.has('variables') ? JSON.parse(url.searchParams.get('variables')!) : undefined
      } catch {
        return send(res, 400, { errors: [{ message: 'The variables are not JSON.' }] })
      }
      request = {
        ...(url.searchParams.has('query') && { query: url.searchParams.get('query')! }),
        ...(variables !== undefined && { variables }),
        ...(url.searchParams.has('operationName') && { operationName: url.searchParams.get('operationName')! }),
      }
    } else if (req.method === 'POST') {
      // JSON or GraphQL only: a form or text/plain, which any web page may send, is refused.
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
      if (type !== 'application/json' && type !== 'application/graphql') {
        return send(res, 415, { errors: [{ message: 'Sosie takes a POST as application/json, or application/graphql.' }] })
      }
      const text = await read(req)
      try {
        request = type === 'application/graphql' ? { query: text } : JSON.parse(text)
      } catch {
        return send(res, 400, { errors: [{ message: 'The request body is not JSON.' }] })
      }
    } else {
      return send(res, 405, { errors: [{ message: 'Sosie takes GraphQL requests by GET and POST.' }] }, { allow: 'GET, POST' })
    }
    if (Array.isArray(request)) {
      const answers = []
      for (const r of request) answers.push((await one(r)).body)
      return send(res, 200, answers)
    }
    const answer = await one(request)
    return send(res, answer.status, answer.body)
  }

  const accept = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((error: Error) => {
      ctx.log(`Cannot read the API: ${why(error)}`)
      if (!res.headersSent) send(res, 502, { errors: [{ message: 'Sosie cannot reach the API. The terminal running Sosie says why.' }] })
      else res.end()
    })
  }
  const servers = await listenLocal(listen, accept)
  const bound = servers[0]!.address()
  const port = bound && typeof bound === 'object' ? bound.port : listen.port
  const host = listen.host === '127.0.0.1' || listen.host === '::1' ? 'localhost' : listen.host
  return {
    address: `http://${host.includes(':') ? `[${host}]` : host}:${port}${path}`,
    close: async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections()
              server.close(() => resolve())
            }),
        ),
      )
    },
  }
}

function failed(status: number, message: string, code?: string) {
  return { status, body: { errors: [{ message, ...(code && { extensions: { code } }) }] } }
}

/** An error about what the client sent, which holds only that and the schema. */
function clientError(error: { message: string; locations?: readonly unknown[] | undefined }) {
  return { message: error.message, ...(error.locations && { locations: error.locations }) }
}

/** The fields asked of the root, its fragments' included. */
function rootFields(selections: readonly SelectionNode[], fragments: Record<string, FragmentDefinitionNode>, seen = new Set<string>()): FieldNode[] {
  return selections.flatMap((s) => {
    if (s.kind === Kind.FIELD) return [s]
    if (s.kind === Kind.INLINE_FRAGMENT) return rootFields(s.selectionSet.selections, fragments, seen)
    if (seen.has(s.name.value) || !fragments[s.name.value]) return []
    seen.add(s.name.value)
    return rootFields(fragments[s.name.value]!.selectionSet.selections, fragments, seen)
  })
}

/** Every response key a document asks for: its fields' names and aliases. */
function responseKeys(document: DocumentNode): Set<string> {
  const keys = new Set<string>()
  visit(document, { Field: (node) => void keys.add(node.alias?.value ?? node.name.value) })
  return keys
}

/** An error's path, when it is made of the query's own keys and positions in a list Sosie would show. */
function validPath(path: unknown, keys: Set<string>, maxItems: number): path is (string | number)[] {
  return (
    Array.isArray(path) &&
    path.every((p) => (typeof p === 'number' && Number.isInteger(p) && p >= 0 && p < maxItems) || (typeof p === 'string' && keys.has(p)))
  )
}

/** The definitions to send for the operation at `at`: it, and the fragments it uses, in their order. */
function only(definitions: readonly DefinitionNode[], at: number): DefinitionNode[] {
  const fragments = new Map(
    definitions.flatMap((d) => (d.kind === Kind.FRAGMENT_DEFINITION ? [[d.name.value, d] as const] : [])),
  )
  const used = new Set<string>()
  const walk = (node: DefinitionNode) =>
    visit(node, {
      FragmentSpread(spread) {
        if (used.has(spread.name.value)) return
        used.add(spread.name.value)
        const fragment = fragments.get(spread.name.value)
        if (fragment) walk(fragment)
      },
    })
  const operation = definitions[at] as OperationDefinitionNode
  walk(operation)
  return definitions.filter((d) => d === operation || (d.kind === Kind.FRAGMENT_DEFINITION && used.has(d.name.value)))
}

/** Whether a document uses a name as a field or an alias. */
function usesName(document: DocumentNode, name: string): boolean {
  let found = false
  visit(document, { Field: (node) => void (found ||= node.name.value === name || node.alias?.value === name) })
  return found
}

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_REQUEST) req.destroy(new Error('The request is too large.'))
      else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(body))
}

/**
 * Listen where the address will say. It says localhost, which many systems resolve to ::1 first, so on
 * 127.0.0.1 Sosie answers on ::1 too; another program on that port's ::1 would get localhost's clients,
 * so the port counts as busy, and a port Sosie picks itself (0) is picked again.
 */
async function listenLocal(
  listen: { host: string; port: number },
  accept: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Server[]> {
  for (let tries = 0; ; tries++) {
    const first = await listenOn(listen.host, listen.port, accept)
    const bound = first.address()
    if (listen.host !== '127.0.0.1' || !bound || typeof bound !== 'object') return [first]
    try {
      return [first, await listenOn('::1', bound.port, accept)]
    } catch (error) {
      // No IPv6 here: localhost is 127.0.0.1.
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') return [first]
      await new Promise<void>((resolve) => first.close(() => resolve()))
      if (listen.port !== 0 || tries >= 10) throw error
    }
  }
}

function listenOn(host: string, port: number, accept: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  const server = createServer(accept)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}
