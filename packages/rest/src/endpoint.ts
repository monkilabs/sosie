import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Endpoint, Faker, Field } from '@sosie/core'
import { fakeBody, queryField, type FakeContext } from './fake.js'
import { referenceOf, type Api } from './openapi.js'
import { route, singular, VALUE_SEGMENT } from './paths.js'
import type { RestUpstream } from './upstream.js'

export interface RestContext {
  upstream: RestUpstream
  api: Api | undefined
  faker: Faker
  log: (line: string) => void
}

/**
 * The local HTTP address clients use, with the API's own paths: a GET goes
 * upstream with fakes in its path and query turned back into real values,
 * and its JSON comes back with every value faked.
 */
export async function startEndpoint(listen: { host: string; port: number }, ctx: RestContext): Promise<Endpoint> {
  const base = ctx.upstream.base
  const basePath = base.pathname.replace(/\/$/, '')
  const fields = new Map<string, Field>((ctx.api?.schema.entities ?? []).flatMap((e) => e.fields.map((f) => [f.id, f] as const)))
  const byWord = new Map((ctx.api?.schema.entities ?? []).map((e) => [singular(e.name.toLowerCase()), e.name]))
  const entityFor = (word: string) => byWord.get(singular(word.toLowerCase())) ?? singular(word.toLowerCase())
  const operations = ctx.api?.operations ?? []
  let local = ''

  /** A URL into the API, as Sosie's own, with its values faked. */
  const rewrite = (text: string): string | undefined => {
    if (!/^https?:\/\//i.test(text)) return undefined
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return undefined
    }
    if (url.origin !== base.origin || !(url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))) return undefined
    const segments = url.pathname.slice(basePath.length).split('/').filter(Boolean)
    const rt = route(segments.map(decodeURIComponent), operations, entityFor, (s) => VALUE_SEGMENT.test(s))
    const path = segments.map((s, i) => {
      const field = rt.values.get(i)
      return field ? encodeURIComponent(String(ctx.faker.value(decodeURIComponent(s), field))) : s
    })
    const query = new URLSearchParams()
    for (const [name, value] of url.searchParams) {
      // A number that names nothing (page=2) stays; anything else is faked as the field it is.
      const plain = /^\d+$/.test(value) && name !== 'id' && !referenceOf(name, entityFor)
      query.append(name, plain ? value : String(ctx.faker.value(value, queryField(name, value, rt, entityFor))))
    }
    const search = query.toString()
    return `${local}${basePath}/${path.join('/')}${search ? `?${search}` : ''}${url.hash}`
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { error: 'Sosie is read-only: only GET and HEAD reach the API.' }, { allow: 'GET, HEAD' })
    }
    const incoming = new URL(req.url ?? '/', 'http://sosie.local')
    if (!(incoming.pathname === basePath || incoming.pathname.startsWith(`${basePath}/`) || !basePath)) {
      return send(res, 404, { error: `Sosie serves the API under ${basePath}.` })
    }
    const scope = ctx.faker.request(decodeURIComponent(`${incoming.pathname}${incoming.search}`))
    const segments = incoming.pathname.slice(basePath.length).split('/').filter(Boolean).map(decodeURIComponent)
    // A segment that is a fake Sosie gave is a value, whatever its shape.
    const rt = route(segments, operations, entityFor, (s) => VALUE_SEGMENT.test(s) || scope.lookup(s) !== undefined)
    const real = segments.map((s, i) => {
      const field = rt.values.get(i)
      return encodeURIComponent((field && (scope.lookup(s, field) ?? scope.lookup(s))) ?? s)
    })
    const query = new URLSearchParams()
    for (const [name, value] of incoming.searchParams) {
      const near = scope.lookup(value, queryField(name, value, rt, entityFor))
      // A number that names no field (limit=10) stays as written; other text is looked up anywhere.
      query.append(name, near ?? (/^\d+$/.test(value) ? undefined : scope.lookup(value)) ?? value)
    }
    const target = new URL(`${base.origin}${basePath}/${real.join('/')}`)
    target.search = query.toString()

    const answer = await ctx.upstream.get(target, req.method === 'HEAD' ? 'HEAD' : 'GET')
    if (answer.status === 401 || answer.status === 403) {
      ctx.log(`The API answered ${answer.status} to ${incoming.pathname}: check SOSIE_UPSTREAM_HEADERS.`)
    }
    const json = /[/+]json\b/i.test(answer.type)
    if (req.method === 'HEAD' || !answer.body) {
      res.writeHead(answer.status, json ? { 'content-type': 'application/json; charset=utf-8' } : {})
      return res.end()
    }
    if (!json) {
      return send(res, answer.status >= 400 ? answer.status : 502, {
        error:
          answer.status >= 400
            ? `The API answered ${answer.status}.`
            : `The API answered with ${answer.type.split(';')[0] || 'no content type'}; Sosie fakes JSON only, so it does not pass it on.`,
      })
    }
    let body: unknown
    try {
      body = JSON.parse(answer.body)
    } catch {
      return send(res, 502, { error: 'The API answered with JSON that does not parse.' })
    }
    const fake: FakeContext = { faker: ctx.faker, api: ctx.api, fields, entityFor, sent: `${incoming.pathname}${incoming.search}`, url: rewrite }
    return send(res, answer.status, fakeBody(body, rt, fake))
  }

  const accept = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((error: Error) => {
      ctx.log(`Cannot read the API: ${error.message}`)
      if (!res.headersSent) send(res, 502, { error: 'Sosie cannot reach the API. The terminal running Sosie says why.' })
      else res.end()
    })
  }
  const servers = [await listenOn(listen.host, listen.port, accept)]
  const bound = servers[0]!.address()
  const port = bound && typeof bound === 'object' ? bound.port : listen.port
  // The address says localhost, which many systems resolve to ::1 first: answer there too.
  if (listen.host === '127.0.0.1') await listenOn('::1', port, accept).then((s) => servers.push(s), () => {})
  const host = listen.host === '127.0.0.1' || listen.host === '::1' ? 'localhost' : listen.host
  local = `http://${host.includes(':') ? `[${host}]` : host}:${port}`
  return {
    address: `${local}${basePath}`,
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

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(body))
}
