import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { localRequest, pacer, why, type Endpoint, type Faker, type Field, type RequestScope } from '@sosie/core'
import { fakeBody, queryField, type FakeContext } from './fake.js'
import { referenceOf, type Api } from './openapi.js'
import { PAGING, PATH_WORD, QUERY_NAME, route, singular, valueByHabit, wordName, type Route } from './paths.js'
import type { RestUpstream } from './upstream.js'

export interface RestContext {
  upstream: RestUpstream
  api: Api | undefined
  faker: Faker
  /** Items of a list at most, as --max-rows. */
  maxItems: number
  log: (line: string) => void
}

/** Words Sosie remembers as names of the API's, at most: those a client sent are added as the API answers them. */
const MAX_KNOWN = 10_000
/** A word that looks like a collection's name: lowercase, plural. */
const COLLECTION = /^[a-z]+(?:_[a-z]+)*s$/
/** Query names common enough to be the API's own, whatever its data. */
const QUERY_WORDS = [
  'page', 'limit', 'offset', 'per_page', 'perPage', 'page_size', 'pageSize', 'size', 'skip', 'take', 'cursor', 'after', 'before',
  'since', 'until', 'from', 'to', 'start', 'end', 'count', 'first', 'last', 'sort', 'sort_by', 'sortBy', 'order', 'order_by',
  'orderBy', 'direction', 'q', 'query', 'search', 'filter', 'fields', 'include', 'expand', 'embed', 'format', 'lang', 'locale',
  'id', 'ids', 'type', 'status', 'state', 'active', 'tag', 'tags', 'category', 'email', 'name',
]

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
  // A word that is no name (an email in a path) names no entity, so it never becomes part of a domain.
  const entityFor = (word: string) => byWord.get(singular(word.toLowerCase())) ?? (/^[A-Za-z][\w-]*$/.test(word) ? singular(word.toLowerCase()) : '*')
  const documented = (word: string) => byWord.has(singular(word.toLowerCase()))
  const operations = ctx.api?.operations ?? []
  /**
   * Words of paths that are the API's own: the OpenAPI document's fixed
   * segments, and collection names (lowercase, plural) a client sent that the
   * API answered. A link shows these, and the words of the request it answers;
   * anything else in it is faked. Another word a client sent (a tenant's slug
   * from an app's settings) is never shown to another request.
   */
  const known = new Set(operations.flatMap((op) => op.segments.filter((s) => !s.startsWith('{'))))
  /** Query names a link shows as they are: common ones, the document's fields, and keys bodies have shown as structure. */
  const queryNames = new Set([...QUERY_WORDS, ...[...fields.values()].map((f) => f.name)])
  const showKey = (key: string) => void (queryNames.size < MAX_KNOWN && queryNames.add(key))
  /** The route of a path as the API wrote it, in a link or a redirect: a word the client has not seen names no entity. */
  const readPath = (real: string[], shown: (word: string) => boolean) =>
    route(real, operations, (word) => (shown(word) || documented(word) ? entityFor(word) : '*'), (segment, _, afterName) =>
      valueByHabit(segment, afterName, known),
    )
  const under = (path: string) => path === basePath || path.startsWith(`${basePath}/`)
  /** The route of the path a redirect ended on: its words are the API's, as a link's are. */
  const readFinal = (url: URL, mine: Set<string>, scope: RequestScope): Route => {
    const real = under(url.pathname) ? segmentsOf(url.pathname.slice(basePath.length)) : undefined
    return real ? readPath(real, (word) => (known.has(word) || mine.has(word)) && !scope.turnedBack(word)) : { entity: '*', values: new Map() }
  }
  let local = ''

  /**
   * A URL into the API, as Sosie's own, with every value in it faked; undefined for any other text.
   * A word the request turned back is an echo of a value, never a name, however it looks.
   */
  const link = (text: string, scope: RequestScope, mine: Set<string>): string | undefined => {
    // A link is one token: text that starts with a URL and goes on is text.
    const absolute = /^https?:\/\/\S+$/i.test(text)
    if (!absolute && !/^\/(?!\/)\S*$/.test(text)) return undefined
    let url: URL
    try {
      url = new URL(text, base.origin)
    } catch {
      return undefined
    }
    if (url.origin !== base.origin || !under(url.pathname)) return undefined
    const real = segmentsOf(url.pathname.slice(basePath.length))
    if (!real) return undefined
    const shown = (word: string) => (known.has(word) || mine.has(word)) && !scope.turnedBack(word)
    // A word the client has not seen, and the document does not name, names no entity: it never becomes part of a domain.
    const rt = readPath(real, shown)
    const path = real.map((segment, i) => {
      const field = rt.values.get(i) ?? (shown(segment) ? undefined : PATH_WORD)
      return encodeURIComponent(field ? String(ctx.faker.value(segment, field)) : segment)
    })
    const query = new URLSearchParams()
    for (const [name, value] of url.searchParams) {
      // Sosie's own credentials in the query (SOSIE_UPSTREAM's ?api_key=) are never shown.
      if (ctx.upstream.params.has(name)) continue
      const plain = queryNames.has(name) || mine.has(name) || referenceOf(name, (word) => word) !== undefined
      const hidden = !(plain && wordName(name) && !scope.turnedBack(name))
      const named = hidden ? String(ctx.faker.value(name, QUERY_NAME)) : name
      // A page's number stays; a long number under such a name may be an id, and is faked.
      const keep = PAGING.has(name) && /^\d{1,5}$/.test(value)
      query.append(named, keep ? value : String(ctx.faker.value(value, queryField(name, value, rt, { fields, entityFor }, hidden))))
    }
    const search = query.toString()
    // The fragment is the client's own business, and may hold anything: it is left out.
    return `${absolute ? local : ''}${basePath}/${path.join('/')}${search ? `?${search}` : ''}`
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!localRequest(req.headers.host, listen.host)) {
      return send(res, 403, { error: 'Sosie answers requests for localhost only.' })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { error: 'Sosie is read-only: only GET and HEAD reach the API.' }, { allow: 'GET, HEAD' })
    }
    const incoming = new URL(req.url ?? '/', 'http://sosie.local')
    if (basePath && !under(incoming.pathname)) return send(res, 404, { error: `Sosie serves the API under ${basePath}.` })
    const sent = segmentsOf(incoming.pathname.slice(basePath.length))
    if (!sent) return send(res, 400, { error: 'The path has a % that does not start an escape (%20).' })
    const scope = ctx.faker.request(`${sent.join('/')}?${[...incoming.searchParams].flat().join('&')}`)

    // A word Sosie made up for a link turns back into the API's word; a known word stays.
    const words = sent.map((segment) => (known.has(segment) ? segment : scope.lookup(segment, PATH_WORD)))
    const routed = sent.map((segment, i) => words[i] ?? segment)
    // A word the client has not seen names no entity, as in the link it came from.
    const unseen = new Set(routed.filter((word, i) => words[i] !== undefined && word !== sent[i]))
    // Any other segment that is a fake Sosie gave is a value, whatever its shape.
    const rt = route(routed, operations, (word) => (unseen.has(word) && !documented(word) ? '*' : entityFor(word)), (segment, i, afterName) =>
      words[i] === undefined && (valueByHabit(segment, afterName, known) || scope.lookup(segment) !== undefined),
    )
    const real = routed.map((segment, i) => {
      const field = rt.values.get(i)
      // A value is looked up in its field; text, not a bare number, anywhere too: /users/7 never reads another entity's 7.
      return encodeURIComponent((field && (scope.lookup(segment, field) ?? (/^\d+$/.test(segment) ? undefined : scope.lookup(segment)))) ?? segment)
    })
    const query = new URLSearchParams()
    const names: string[] = []
    for (const [sentName, value] of incoming.searchParams) {
      const name = wordName(sentName) || known.has(sentName) ? sentName : (scope.lookup(sentName, QUERY_NAME) ?? sentName)
      if (name === sentName) names.push(name)
      const near = scope.lookup(value, queryField(name, value, rt, { fields, entityFor }, name !== sentName))
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
    // Words the client wrote itself: links in this answer may show them, and collection names the API answered, any link.
    const mine = new Set([...sent.filter((segment, i) => !rt.values.has(i) && words[i] === undefined), ...names])
    if (json && answer.status >= 200 && answer.status < 300 && known.size < MAX_KNOWN) {
      for (const word of mine) if (COLLECTION.test(word) && !names.includes(word)) known.add(word)
    }
    // An answer the API redirected to another path is about what that path names.
    const read = answer.url.pathname === target.pathname ? rt : readFinal(answer.url, mine, scope)
    if (req.method === 'HEAD' || !answer.body) {
      res.writeHead(answer.status, json ? { 'content-type': 'application/json; charset=utf-8' } : {})
      return res.end()
    }
    if (!json) {
      // The status passes, so a missing record stays a 404; the body, which Sosie cannot fake, does not.
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
    const fake: FakeContext = {
      faker: ctx.faker,
      scope,
      api: ctx.api,
      fields,
      entityFor,
      url: (text) => link(text, scope, mine),
      maxItems: ctx.maxItems,
      pace: pacer(),
      shown: showKey,
    }
    const faked = await fakeBody(body, read, fake)
    const notice = `Sosie returned the first ${ctx.maxItems} items of a list; the rest were cut. Narrow the request, or start Sosie with a higher --max-rows.`
    return send(res, answer.status, faked.body, faked.cut ? { 'sosie-notice': notice } : {})
  }

  const accept = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((error: Error) => {
      ctx.log(`Cannot read the API: ${why(error)}`)
      if (!res.headersSent) send(res, 502, { error: 'Sosie cannot reach the API. The terminal running Sosie says why.' })
      else res.end()
    })
  }
  const servers = await listenLocal(listen, accept)
  const bound = servers[0]!.address()
  const port = bound && typeof bound === 'object' ? bound.port : listen.port
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

/** The segments of a path, decoded; undefined when a % starts no escape. */
function segmentsOf(path: string): string[] | undefined {
  try {
    return path.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return undefined
  }
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

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(body))
}
