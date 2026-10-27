import { createServer, type Server } from 'node:http'

/** The token the fake API wants: what a developer puts in SOSIE_UPSTREAM_HEADERS. */
export const TOKEN = 'test-token-7c1f'

/** The same people as the database seed, so a person's fakes can be compared across sources. */
const users = [
  { id: 1, email: 'quill.vantablack@canary-mail.test', name: 'Quillon Vantablack', phone: '7739182046', role: 'admin', active: true, address: { city: 'Vantaville' }, apiKey: 'sk_live_9Qv7Xc2Lm8Rt' },
  { id: 2, email: 'zephyrine@orrowmoor.test', name: 'Zephyrine Orrowmoor', phone: '6045550199', role: 'editor', active: false, address: { city: 'Orrowmoor' }, apiKey: 'sk_live_Zz8yYx7wWv6u' },
  { id: 3, email: 'person3@example.org', name: 'Person 3', phone: '5550100', role: 'viewer', active: true, address: { city: 'Springfield' }, apiKey: 'key_3' },
]
/** Logins in paths, as GitHub-style APIs have them: never in a body, only in links. */
const handles: Record<string, number> = { quillon: 1, Vantablack: 1, zephyrine: 2 }
const orders = [
  { id: 10, userId: 1, total: 120.5, status: 'paid', note: 'leave the parcel with Quillon' },
  { id: 11, userId: 1, total: 9.99, status: 'new', note: 'ring twice' },
  { id: 12, userId: 2, total: 1500, status: 'shipped', note: null },
]

const openapi = {
  openapi: '3.1.0',
  info: { title: 'Shop', version: '1' },
  paths: {
    '/users': {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { type: 'array', items: { $ref: '#/components/schemas/User' } }, next: { type: ['string', 'null'], format: 'uri' } },
                },
              },
            },
          },
        },
      },
    },
    '/users/{id}': {
      get: {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } } },
      },
    },
    '/members': {
      get: {
        responses: {
          '200': { content: { 'application/json': { schema: { type: 'object', additionalProperties: { $ref: '#/components/schemas/Member' } } } } },
        },
      },
    },
    '/users/{userId}/orders': {
      get: { responses: { '200': { content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } } } } } } },
    },
  },
  components: {
    schemas: {
      User: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          email: { type: 'string', format: 'email' },
          name: { type: 'string' },
          phone: { type: 'string' },
          role: { type: 'string', enum: ['admin', 'editor', 'viewer'] },
          active: { type: 'boolean' },
          address: { type: 'object', properties: { city: { type: 'string' } } },
          apiKey: { type: 'string' },
        },
      },
      Member: { type: 'object', properties: { role: { type: 'string' } } },
      Order: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          userId: { type: 'integer' },
          total: { type: 'number' },
          status: { type: 'string', enum: ['new', 'paid', 'shipped'] },
          note: { type: ['string', 'null'] },
        },
      },
    },
  },
}

export interface FakeApi {
  url: string
  /** Requests the API received, as Sosie sent them. */
  requests: { method: string; path: string; authorization: string | undefined }[]
  close(): Promise<void>
}

/** A server that records every request it gets: where a redirect away would take Sosie's credentials. */
export async function startRecorder(): Promise<{ url: string; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"stolen":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/**
 * A team's API under /v1, as Sosie would front it. With `withOpenapi`, it
 * serves its OpenAPI document; `elsewhere` is where its redirects away go.
 */
export async function startApi({ withOpenapi = false, elsewhere = 'http://203.0.113.9' } = {}): Promise<FakeApi> {
  const requests: FakeApi['requests'] = []
  let origin = ''
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://api.local')
    requests.push({ method: req.method ?? '', path: `${url.pathname}${url.search}`, authorization: req.headers.authorization })
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorized' })
    if (req.method === 'POST') return json(201, { ok: true })
    const path = url.pathname.replace(/^\/v1/, '')
    if (path === '/openapi.json') return withOpenapi ? json(200, openapi) : json(404, { error: 'not found' })
    if (path === '/users') {
      const { email, phone, role, active } = Object.fromEntries(url.searchParams)
      const list = users.filter(
        (u) => (!email || u.email === email) && (!phone || u.phone === phone) && (!role || u.role === role) && (!active || String(u.active) === active),
      )
      const page = Number(url.searchParams.get('page') ?? 1)
      // The next page's link repeats the request's query, as APIs do: the real values Sosie sent among it.
      const next = new URLSearchParams(url.searchParams)
      next.set('page', String(page + 1))
      return json(200, { data: list, next: page === 1 ? `${origin}/v1/users?${next}` : null })
    }
    let m = /^\/users\/(\d+)$/.exec(path)
    if (m) {
      const user = users.find((u) => u.id === Number(m![1]))
      return user ? json(200, user) : json(404, { error: `no user ${m[1]}` })
    }
    m = /^\/users\/([A-Za-z]+)(\/repos)?$/.exec(path)
    if (m && handles[m[1]!]) {
      const user = users.find((u) => u.id === handles[m![1]!])!
      return json(200, m[2] ? [{ name: `${m[1]}-tools`, ownerId: user.id }] : user)
    }
    m = /^\/people\/by-email\/(.+)$/.exec(path)
    if (m) {
      const user = users.find((u) => u.email === decodeURIComponent(m![1]!))
      return user ? json(200, user) : json(404, { error: 'not found' })
    }
    if (path === '/links') {
      return json(200, {
        login: `${origin}/v1/users/quillon`,
        profile: `${origin}/v1/people/by-email/quill.vantablack@canary-mail.test`,
        repos: `${origin}/v1/users/Vantablack/repos`,
        next: `${origin}/v1/users?after=7739182046&phone=7739182046#Vantaville`,
        search: `${origin}/v1/search?q%5BQuillon%5D=1&Vantablack=1`,
        root: `${origin}/v1/7739182046`,
        relative: '/v1/users/quillon?page=2',
        note: `${origin}/v1/notes leave the parcel with Quillon`,
        broken: `${origin}/v1/users/%zzVantablack`,
        outside: `${origin}/static/Vantablack.png`,
      })
    }
    if (path === '/members') return json(200, { quillon: { role: 'owner' }, zephyrine: { role: 'guest' } })
    if (path === '/big') {
      const n = Number(url.searchParams.get('n') ?? 10)
      return json(200, Array.from({ length: n }, (_, i) => ({ id: i + 1, email: `person${i + 1}@example.org` })))
    }
    m = /^\/users\/(\d+)\/orders$/.exec(path)
    if (m) return json(200, orders.filter((o) => o.userId === Number(m![1])))
    if (path === '/orders') {
      const userId = url.searchParams.get('userId')
      return json(200, userId ? orders.filter((o) => o.userId === Number(userId)) : orders)
    }
    if (path === '/contacts') return json(200, Object.fromEntries(users.map((u) => [u.email, { name: u.name }])))
    if (path === '/self') return json(200, { href: `${origin}/v1/users/1`, owner: `${origin}/v1/users/1/orders?userId=1&page=2` })
    if (path === '/missing') return json(404, { error: 'No user with email quill.vantablack@canary-mail.test' })
    if (path === '/avatar') {
      res.writeHead(200, { 'content-type': 'image/png' })
      return res.end(Buffer.from('Quillon Vantablack'))
    }
    if (path === '/elsewhere') {
      res.writeHead(302, { location: `${elsewhere}/steal` })
      return res.end()
    }
    if (path === '/elsewhere-relative') {
      res.writeHead(307, { location: `//${new URL(elsewhere).host}/steal` })
      return res.end()
    }
    if (path === '/moved') {
      res.writeHead(301, { location: '/v1/users/1' })
      return res.end()
    }
    return json(404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  return {
    url: `${origin}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
