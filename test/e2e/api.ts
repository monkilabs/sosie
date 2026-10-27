import { createServer, type Server } from 'node:http'

/** The token the fake API wants: what a developer puts in SOSIE_UPSTREAM_HEADERS. */
export const TOKEN = 'test-token-7c1f'

/** The same people as the database seed, so a person's fakes can be compared across sources. */
const users = [
  { id: 1, email: 'quill.vantablack@canary-mail.test', name: 'Quillon Vantablack', role: 'admin', address: { city: 'Vantaville' }, apiKey: 'sk_live_9Qv7Xc2Lm8Rt' },
  { id: 2, email: 'zephyrine@orrowmoor.test', name: 'Zephyrine Orrowmoor', role: 'editor', address: { city: 'Orrowmoor' }, apiKey: 'sk_live_Zz8yYx7wWv6u' },
  { id: 3, email: 'person3@example.org', name: 'Person 3', role: 'viewer', address: { city: 'Springfield' }, apiKey: 'key_3' },
]
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
          role: { type: 'string', enum: ['admin', 'editor', 'viewer'] },
          address: { type: 'object', properties: { city: { type: 'string' } } },
          apiKey: { type: 'string' },
        },
      },
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

/** A team's API under /v1, as Sosie would front it. With `withOpenapi`, it serves its OpenAPI document. */
export async function startApi({ withOpenapi = false } = {}): Promise<FakeApi> {
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
      const email = url.searchParams.get('email')
      const list = email ? users.filter((u) => u.email === email) : users
      const page = Number(url.searchParams.get('page') ?? 1)
      return json(200, { data: list, next: page === 1 ? `${origin}/v1/users?page=2` : null })
    }
    let m = /^\/users\/(\d+)$/.exec(path)
    if (m) {
      const user = users.find((u) => u.id === Number(m![1]))
      return user ? json(200, user) : json(404, { error: `no user ${m[1]}` })
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
      res.writeHead(302, { location: 'http://203.0.113.9/steal' })
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
