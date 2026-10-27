import { createServer, type Server } from 'node:http'
import { buildSchema, graphql } from 'graphql'
import { TOKEN } from './api.js'

export const SDL = `
scalar EmailAddress
enum Role { admin editor viewer }
enum Status { new paid shipped }
type Address { city: String }
type User {
  id: ID!
  email: EmailAddress
  name: String
  role: Role
  address: Address
  apiKey: String
  orders: [Order!]!
}
type Order {
  id: ID!
  userId: ID!
  total: Float
  status: Status
  note: String
  user: User
}
type Query {
  users(email: String): [User!]!
  user(id: ID!): User
  orders(userId: ID): [Order!]!
  broken: String
}
type Mutation {
  deleteUser(id: ID!): Boolean
}
`

/** The same people as the database seed and the REST fake. */
const people = [
  { id: '1', email: 'quill.vantablack@canary-mail.test', name: 'Quillon Vantablack', role: 'admin', address: { city: 'Vantaville' }, apiKey: 'sk_live_9Qv7Xc2Lm8Rt' },
  { id: '2', email: 'zephyrine@orrowmoor.test', name: 'Zephyrine Orrowmoor', role: 'editor', address: { city: 'Orrowmoor' }, apiKey: 'sk_live_Zz8yYx7wWv6u' },
  { id: '3', email: 'person3@example.org', name: 'Person 3', role: 'viewer', address: { city: 'Springfield' }, apiKey: 'key_3' },
]
const purchases = [
  { id: '10', userId: '1', total: 120.5, status: 'paid', note: 'leave the parcel with Quillon' },
  { id: '11', userId: '1', total: 9.99, status: 'new', note: 'ring twice' },
  { id: '12', userId: '2', total: 1500, status: 'shipped', note: null },
]
const user = (p: (typeof people)[number]): object => ({ ...p, orders: () => purchases.filter((o) => o.userId === p.id).map(order) })
const order = (o: (typeof purchases)[number]): object => ({ ...o, user: () => user(people.find((p) => p.id === o.userId)!) })

export interface FakeGraphql {
  url: string
  /** Operations the API ran, by kind. */
  operations: string[]
  close(): Promise<void>
}

/** A team's GraphQL API at /api/graphql. With `introspection: false`, it refuses introspection, as production APIs often do. */
export async function startGraphql({ introspection = true } = {}): Promise<FakeGraphql> {
  const schema = buildSchema(SDL)
  const operations: string[] = []
  const root = {
    users: ({ email }: { email?: string }) => people.filter((p) => !email || p.email === email).map(user),
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
