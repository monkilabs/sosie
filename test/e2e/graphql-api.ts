import { createServer, type Server } from 'node:http'
import { buildSchema, graphql } from 'graphql'
import { TOKEN } from './api.js'

export const SDL = `
scalar EmailAddress
enum Role { admin editor viewer }
enum Status { new paid shipped }
interface Node { id: ID! }
type Address { city: String }
type User implements Node {
  id: ID!
  email: EmailAddress
  name: String
  role: Role
  active: Boolean
  address: Address
  apiKey: String
  orders: [Order!]!
}
type Order implements Node {
  id: ID!
  userId: ID!
  total: Float
  status: Status
  note: String
  user: User
}
type Product { id: ID! name: String sku: String }
union SearchResult = Product | User
type Query {
  users(email: String, role: Role, active: Boolean): [User!]!
  user(id: ID!): User
  node(id: ID!): Node
  orders(userId: ID): [Order!]!
  search: [SearchResult!]!
  broken: String
  refused: String
  moved: String
}
type Mutation {
  deleteUser(id: ID!): Boolean
}
`

/** The same people as the database seed and the REST fake. */
const people = [
  { id: '1', email: 'quill.vantablack@canary-mail.test', name: 'Quillon Vantablack', role: 'admin', active: true, address: { city: 'Vantaville' }, apiKey: 'sk_live_9Qv7Xc2Lm8Rt' },
  { id: '2', email: 'zephyrine@orrowmoor.test', name: 'Zephyrine Orrowmoor', role: 'editor', active: false, address: { city: 'Orrowmoor' }, apiKey: 'sk_live_Zz8yYx7wWv6u' },
  { id: '3', email: 'person3@example.org', name: 'Person 3', role: 'viewer', active: true, address: { city: 'Springfield' }, apiKey: 'key_3' },
]
const purchases = [
  { id: '10', userId: '1', total: 120.5, status: 'paid', note: 'leave the parcel with Quillon' },
  { id: '11', userId: '1', total: 9.99, status: 'new', note: 'ring twice' },
  { id: '12', userId: '2', total: 1500, status: 'shipped', note: null },
]
const user = (p: (typeof people)[number]): object => ({ __typename: 'User', ...p, orders: () => purchases.filter((o) => o.userId === p.id).map(order) })
const order = (o: (typeof purchases)[number]): object => ({ __typename: 'Order', ...o, user: () => user(people.find((p) => p.id === o.userId)!) })

export interface FakeGraphql {
  url: string
  /** Operations the API ran, by kind. */
  operations: string[]
  /** Every request the API received, as Sosie sent it. */
  received: { query: string; variables?: Record<string, unknown> }[]
  close(): Promise<void>
}

/**
 * A team's GraphQL API at /api/graphql. With `introspection: false`, it
 * refuses introspection, as production APIs often do; `elsewhere` is where it
 * redirects a query for `moved`.
 */
export async function startGraphql({ introspection = true, elsewhere = 'http://203.0.113.9' } = {}): Promise<FakeGraphql> {
  const schema = buildSchema(SDL)
  const operations: string[] = []
  const received: FakeGraphql['received'] = []
  const root = {
    users: ({ email, role, active }: { email?: string; role?: string; active?: boolean }) =>
      people.filter((p) => (!email || p.email === email) && (!role || p.role === role) && (active === undefined || p.active === active)).map(user),
    node: ({ id }: { id: string }) => {
      const p = people.find((x) => x.id === id)
      return p ? user(p) : null
    },
    search: () => [user(people[0]!), { __typename: 'Product', id: 'p1', name: 'Plain Widget', sku: 'W-1' }],
    user: ({ id }: { id: string }) => {
      const p = people.find((x) => x.id === id)
      return p ? user(p) : null
    },
    orders: ({ userId }: { userId?: string }) => purchases.filter((o) => !userId || o.userId === userId).map(order),
    broken: () => {
      throw new Error('No user quill.vantablack@canary-mail.test')
    },
    deleteUser: () => {
      operations.push('mutation ran')
      return true
    },
  }
  const server: Server = createServer((req, res) => {
    let text = ''
    req.on('data', (c) => (text += c))
    req.on('end', async () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { errors: [{ message: 'unauthorized' }] })
      const request = JSON.parse(text || '{}')
      received.push({ query: request.query, ...(request.variables && { variables: request.variables }) })
      if (/\bmoved\b/.test(request.query)) {
        res.writeHead(307, { location: `${elsewhere}/steal` })
        return res.end()
      }
      // Not every server follows the spec: this one refuses with no data, and quotes the data while it does.
      if (/\brefused\b/.test(request.query)) {
        return json(200, {
          errors: [
            { message: 'user quill.vantablack@canary-mail.test may not see Quillon Vantablack of Vantaville', path: ['Quillon', 0], extensions: { code: 'FORBIDDEN', detail: 'Vantaville' } },
            { message: 'Zephyrine', extensions: { code: 'Zephyrine Orrowmoor' } },
          ],
        })
      }
      if (!introspection && /__schema/.test(request.query)) return json(200, { errors: [{ message: 'GraphQL introspection is not allowed' }] })
      operations.push(/^\s*mutation/.test(request.query) ? 'mutation' : 'query')
      json(200, await graphql({ schema, source: request.query, variableValues: request.variables, operationName: request.operationName, rootValue: root }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/api/graphql`,
    operations,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
