import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { crossSite, localRequest, pacer, parseJson, why, type Endpoint, type Faker, type Field, type RequestScope } from '@sosie/core'
import { ENVELOPES, fakeBody, queryField, type FakeContext } from './fake.js'
import { referenceOf, type Api } from './openapi.js'
import { oneSegment, PAGING, PATH_WORD, QUERY_NAME, QUERY_VALUE, route, segmentsOf, singular, VALUE_SEGMENT, valueByHabit, wordName, type Route } from './paths.js'
import type { RestUpstream } from './upstream.js'

export interface RestContext {
  upstream: RestUpstream
  api: Api | undefined
  faker: Faker
  /** Items of a list at most, as --max-rows. */
  maxItems: number
  /** Sosie's own credentials for the API, as `secretParts` gives them. */
  secrets: readonly string[]
  log: (line: string) => void
}

/** A segment, as sent or as Sosie turns it back, that the API could read as more than one, or as a step up. */
const OTHER_PATH = 'A segment of the path holds a / or \\, or is . or ..: the API could read it as another path, so Sosie does not send it.'
/** Words Sosie remembers as names of the API's, at most: those a client sent are added as the API answers them. */
const MAX_KNOWN = 10_000
/** Query names frameworks read as the method to run instead of GET. */
const OVERRIDE = /^(_+method|_?httpmethod|method|x-http-method(-override)?|x-method-override)$/i
/** Methods that write, as an override names them. */
const WRITE = /^(post|put|patch|delete|merge)$/i
/** How an error's body is read: as no entity's, each value faked by where it sits. */
const NO_ENTITY: Route = { entity: '*', values: new Map() }
/** A word that looks like a name of the API's: lowercase first, then letters and digits, in kebab, snake or camel case. */
const NAME = /^[a-z][a-zA-Z0-9]*(?:[-_][a-zA-Z0-9]+)*$/
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
   * segments, and collection names (lowercase, plural) a client asked for, as
   * the last word of a path, that the API answered with a list. A link shows
   * these, and the words of the request it answers; anything else in it is
   * faked. Another word a client sent (a tenant's slug from an app's settings,
   * /jones/profile) is never shown to another request.
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
    const rt = real ? readPath(real, (word) => (known.has(word) || mine.has(word)) && !scope.turnedBack(word)) : NO_ENTITY
    // A word where a value goes (/products/reviews) may name another kind of record: then the answer is no entity's.
    return [...rt.values.keys()].some((i) => !VALUE_SEGMENT.test(real![i]!)) ? NO_ENTITY : rt
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
      // What follows a word that names no entity is the id of nothing: a number or a UUID is a value, a word is the API's.
      const value = rt.values.get(i)
      const field = value && !(value.id === '*.id' && !VALUE_SEGMENT.test(segment)) ? value : shown(segment) ? undefined : PATH_WORD
      // In the request's scope: a field that passes shows the fake the client sent, never the value it turned back.
      return encodeURIComponent(field ? String(ctx.faker.value(segment, field, scope)) : segment)
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
      query.append(named, keep ? value : String(ctx.faker.value(value, queryField(name, value, rt, { fields, entityFor }, hidden), scope)))
    }
    const search = query.toString()
    // The fragment is the client's own business, and may hold anything: it is left out.
    return `${absolute ? local : ''}${basePath}/${path.join('/')}${search ? `?${search}` : ''}`
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!localRequest(req.headers.host, listen.host)) {
      return send(res, 403, { error: 'Sosie answers requests for localhost only.' })
    }
    if (crossSite(req.headers, listen.host)) {
      return send(res, 403, { error: 'Sosie answers pages of this machine only, not a page of another site.' })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { error: 'Sosie is read-only: only GET and HEAD reach the API.' }, { allow: 'GET, HEAD' })
    }
    const incoming = new URL(req.url ?? '/', 'http://sosie.local')
    if (basePath && !under(incoming.pathname)) return send(res, 404, { error: `Sosie serves the API under ${basePath}.` })
    const sent = segmentsOf(incoming.pathname.slice(basePath.length))
    if (!sent) return send(res, 400, { error: 'The path has a % that does not start an escape (%20).' })
    if (!sent.every(oneSegment)) return send(res, 400, { error: OTHER_PATH })
    // Sosie's own credentials: a key, or a value that passes, that holds one is faked.
    const scope = ctx.faker.request(`${sent.join('/')}?${[...incoming.searchParams].flat().join('&')}`, undefined, ctx.secrets)
    /**
     * The real value behind a fake: in its field, and text, not a bare number, anywhere too. A value
     * compared with a field that passes is real already, and stays as written: looked up anywhere, it
     * could turn into another field's real value, which that field would show as it is.
     */
    const lookup = (text: string, field: Field) =>
      ctx.faker.passes(field) ? undefined : (scope.lookup(text, field) ?? (/^\d+$/.test(text) ? undefined : scope.lookup(text)))

    // A word Sosie made up for a link turns back into the API's word; a known word stays.
    const words = sent.map((segment) => (known.has(segment) ? segment : scope.lookup(segment, PATH_WORD)))
    const routed = sent.map((segment, i) => words[i] ?? segment)
    // A word the client has not seen names no entity, as in the link it came from.
    const unseen = new Set(routed.filter((word, i) => words[i] !== undefined && word !== sent[i]))
    // Any other segment that is a fake Sosie gave is a value, whatever its shape.
    // A word the client typed that is no name (Vantablack, an email) names no entity either: no domain is named after it.
    const named = (word: string) => documented(word) || (!unseen.has(word) && NAME.test(word))
    const rt = route(routed, operations, (word) => (named(word) ? entityFor(word) : '*'), (segment, i, afterName) =>
      words[i] === undefined && (valueByHabit(segment, afterName, known) || scope.lookup(segment) !== undefined),
    )
    const turned = routed.map((segment, i) => {
      const field = rt.values.get(i)
      // A value is looked up in its field; text, not a bare number, anywhere too: /users/7 never reads another entity's 7.
      return (field && lookup(segment, field)) ?? segment
    })
    // A value the API holds may be a path too; sent in one segment, it could name another.
    if (!turned.every(oneSegment)) return send(res, 400, { error: OTHER_PATH })
    // A word the client typed where a value goes, neither a number, a UUID nor a fake Sosie gave (/products/reviews, a
    // login an app knows), may name another kind of record: the answer is then no entity's, and no rule applies to it.
    const unsure = [...rt.values.keys()].some((i) => turned[i] === routed[i] && !VALUE_SEGMENT.test(routed[i]!))
    const real = turned.map(encodeURIComponent)
    const query = new URLSearchParams()
    const names: string[] = []
    for (const [sentName, value] of incoming.searchParams) {
      const name = wordName(sentName) || known.has(sentName) ? sentName : (scope.lookup(sentName, QUERY_NAME) ?? sentName)
      // A method override (?_method=DELETE), as sent or as Sosie turns its name back, asks a framework to write: it never leaves Sosie.
      if (OVERRIDE.test(name) && WRITE.test(value)) {
        return send(res, 400, { error: 'Sosie is read-only: a method override in the query (_method=DELETE) is not sent.' })
      }
      if (name === sentName) names.push(name)
      // A number that names no field (limit=10) stays as written; other text is looked up anywhere.
      query.append(name, lookup(value, queryField(name, value, rt, { fields, entityFor }, name !== sentName)) ?? value)
    }
    const target = new URL(`${base.origin}${basePath}/${real.join('/')}`)
    target.search = query.toString()

    const answer = await ctx.upstream.get(target, req.method === 'HEAD' ? 'HEAD' : 'GET')
    if (answer.status === 401 || answer.status === 403) {
      ctx.log(`The API answered ${answer.status} to ${incoming.pathname}: check SOSIE_UPSTREAM_HEADERS.`)
    }
    const json = /[/+]json\b/i.test(answer.type)
    // Words the client wrote itself: links in this answer may show them.
    const mine = new Set([...sent.filter((segment, i) => !rt.values.has(i) && words[i] === undefined), ...names])
    // An answer the API redirected to another path is about what that path names; an error is about no
    // entity, so no field's rule in sosie.yml applies to its body, whatever keys it shares with the record.
    // With a document, a path it declares no operation for is no entity's: the API may answer it with anything.
    const undocumented = !!ctx.api && !rt.operation
    let read = answer.status >= 300 || unsure || undocumented ? NO_ENTITY : answer.url.pathname === target.pathname ? rt : readFinal(answer.url, mine, scope)
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
            : 'The API did not answer with JSON; Sosie fakes JSON only, so it does not pass it on.',
      })
    }
    let body: unknown
    try {
      body = parseJson(answer.body)
    } catch (error) {
      const deep = error instanceof RangeError
      return send(res, 502, { error: deep ? 'The API answered with JSON nested too deep for Sosie to read.' : 'The API answered with JSON that does not parse.' })
    }
    // Under a record (/users/4/countries), the last name says what the answer is only when it is a collection the API answers
    // with a list: an API that routes by prefix answers /users/4/<anything> with the user, and another kind's rule must not pass it.
    const lastName = routed.findLastIndex((_, i) => !rt.values.has(i))
    const nested = [...rt.values.keys()].some((i) => i < lastName)
    if (read === rt && !ctx.api && nested && !(COLLECTION.test(routed[lastName]!) && listOf(body, routed[lastName]!))) read = NO_ENTITY
    // A collection's name, which any link may show: the path's last word, a name as the client wrote it, answered with a list.
    const last = sent.length - 1
    const word = sent[last]
    const ok = answer.status >= 200 && answer.status < 300
    if (ok && word !== undefined && !rt.values.has(last) && words[last] === undefined && COLLECTION.test(word) && listOf(body, word)) {
      if (known.size < MAX_KNOWN) known.add(word)
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
      // Sosie's own credentials in the API's query (?api_key=) stay out of the terminal too.
      const said = [...ctx.upstream.params.values()].filter(Boolean).reduce((text, value) => text.split(value).join('…').split(encodeURIComponent(value)).join('…'), why(error))
      ctx.log(`Cannot read the API: ${said}`)
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

/** Whether a body is a list: an array, or an object holding one under an envelope's key or the collection's own name. */
function listOf(body: unknown, collection: string): boolean {
  if (Array.isArray(body)) return true
  return !!body && typeof body === 'object' && Object.entries(body).some(([k, v]) => Array.isArray(v) && (ENVELOPES.has(k) || k === collection))
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
