import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { singular, type Endpoint, type Faker, type Field } from '@sosie/core'
import { getOperationAST, Kind, parse, print, validate, type DocumentNode, type FragmentDefinitionNode, type GraphQLSchema } from 'graphql'
import { fakeData } from './fake.js'
import { rewrite } from './rewrite.js'
import type { GraphqlUpstream } from './upstream.js'

export interface GraphqlContext {
  upstream: GraphqlUpstream
  schema: GraphQLSchema
  /** Fields of the neutral schema, by id. */
  fields: Map<string, Field>
  faker: Faker
  log: (line: string) => void
}

interface Request {
  query?: string
  variables?: Record<string, unknown>
  operationName?: string
  extensions?: { persistedQuery?: unknown }
}

const MAX_REQUEST = 1024 * 1024
const HIDDEN = 'A resolver failed; Sosie hides its message, which may quote a value from your data.'

/**
 * The local GraphQL address, at the API's own path. Each operation is parsed
 * and checked against the schema; only queries reach the API, with their
 * fakes turned back into real values, and every value of `data` comes back
 * faked.
 */
export async function startEndpoint(listen: { host: string; port: number }, ctx: GraphqlContext): Promise<Endpoint> {
  const path = ctx.upstream.url.pathname
  const byWord = new Map([...new Set([...ctx.fields.keys()].map((id) => id.slice(0, id.indexOf('.'))))].map((name) => [singular(name.toLowerCase()), name]))
  const names = { fields: ctx.fields, entityFor: (word: string) => byWord.get(singular(word.toLowerCase())) }

  const one = async (request: Request): Promise<{ status: number; body: unknown }> => {
    if (typeof request.query !== 'string') {
      const message = request.extensions?.persistedQuery
        ? 'Sosie needs the query text: it does not support persisted queries.'
        : 'The request has no query.'
      return failed(400, message)
    }
    let document: DocumentNode
    try {
      document = parse(request.query)
    } catch (error) {
      return failed(400, (error as Error).message)
    }
    // Errors of the request against the schema hold only what the client wrote, and the schema.
    const invalid = validate(ctx.schema, document)
    if (invalid.length) return { status: 400, body: { errors: invalid.map((e) => ({ message: e.message, ...(e.locations && { locations: e.locations }) })) } }
    const operation = getOperationAST(document, request.operationName)
    if (!operation) return failed(400, 'Name the operation to run: the document has several.')
    if (operation.operation !== 'query') {
      return failed(400, 'Sosie is read-only: only queries reach the API, not mutations or subscriptions.', 'SOSIE_READ_ONLY')
    }

    const scope = ctx.faker.request(`${request.query}\n${JSON.stringify(request.variables ?? {})}`)
    const real = rewrite(ctx.schema, document, request.variables ?? {}, scope, names)
    const answer = await ctx.upstream.post({
      query: real.changed ? print(real.document) : request.query,
      variables: real.variables,
      ...(request.operationName && { operationName: request.operationName }),
    })
    if (!/json/i.test(answer.type)) return failed(502, `The API answered with ${answer.type.split(';')[0] || 'no content type'}; Sosie fakes JSON only.`)
    let body: { data?: unknown; errors?: { message?: string; path?: unknown; locations?: unknown; extensions?: { code?: unknown } }[] }
    try {
      body = JSON.parse(answer.body)
    } catch {
      return failed(502, 'The API answered with JSON that does not parse.')
    }
    const introspection = operation.selectionSet.selections.every((s) => s.kind === Kind.FIELD && s.name.value.startsWith('__'))
    if (introspection) return { status: answer.status, body }

    const fragments: Record<string, FragmentDefinitionNode> = Object.fromEntries(
      document.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION).map((d) => [d.name.value, d]),
    )
    const executed = 'data' in body
    return {
      status: answer.status,
      body: {
        ...(executed && { data: fakeData(body.data, operation.selectionSet, ctx.schema.getQueryType()!, { schema: ctx.schema, faker: ctx.faker, fields: ctx.fields, fragments }) }),
        ...(body.errors && {
          // A resolver's message may quote data; one from before execution quotes only the query.
          errors: body.errors.map((e) => ({
            message: executed ? HIDDEN : scope.scrub(String(e.message ?? '')),
            ...(e.path !== undefined && { path: e.path }),
            ...(!executed && e.locations !== undefined && { locations: e.locations }),
            ...(typeof e.extensions?.code === 'string' && { extensions: { code: e.extensions.code } }),
          })),
        }),
      },
    }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://sosie.local')
    if (url.pathname.replace(/\/$/, '') !== path.replace(/\/$/, '')) return send(res, 404, { errors: [{ message: `Sosie serves the GraphQL API at ${path}.` }] })
    let request: Request | Request[]
    if (req.method === 'GET') {
      const variables = url.searchParams.get('variables')
      request = {
        ...(url.searchParams.has('query') && { query: url.searchParams.get('query')! }),
        ...(variables && { variables: JSON.parse(variables) }),
        ...(url.searchParams.has('operationName') && { operationName: url.searchParams.get('operationName')! }),
      }
    } else if (req.method === 'POST') {
      const text = await read(req)
      try {
        request = /application\/graphql\b/.test(req.headers['content-type'] ?? '') ? { query: text } : JSON.parse(text)
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
      ctx.log(`Cannot read the API: ${error.message}`)
      if (!res.headersSent) send(res, 502, { errors: [{ message: 'Sosie cannot reach the API. The terminal running Sosie says why.' }] })
      else res.end()
    })
  }
  const servers = [await listenOn(listen.host, listen.port, accept)]
  const bound = servers[0]!.address()
  const port = bound && typeof bound === 'object' ? bound.port : listen.port
  // The address says localhost, which many systems resolve to ::1 first: answer there too.
  if (listen.host === '127.0.0.1') await listenOn('::1', port, accept).then((s) => servers.push(s), () => {})
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
