import { mkdtempSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFaker, loadRules, Store, storeDir, type Running } from '@sosie/core'
import { graphql } from '@sosie/graphql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startRecorder, TOKEN } from './api.js'
import { canariesIn } from './canaries.js'
import { SDL, startGraphql, type FakeGraphql } from './graphql-api.js'
import { startSosie } from './sosie.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- GraphQL responses. */
type Json = any

/** Everything Sosie returned in this file, searched for canaries at the end. */
const seen: unknown[] = []

async function startGraphqlSosie(
  api: FakeGraphql,
  { home = mkdtempSync(join(tmpdir(), 'sosie-gql-')), env = {} as Record<string, string>, rules = '', maxRows = 1000 } = {},
) {
  const connection = await graphql.connect(new URL(api.url), {
    maxRows,
    statementTimeout: 5000,
    env: { SOSIE_UPSTREAM_HEADERS: `Authorization: Bearer ${TOKEN}`, ...env },
  })
  const store = Store.open(storeDir(home))
  const faker = createFaker({ schema: connection.schema, rules: loadRules(rules, connection.schema), store })
  const endpoint = await connection.serve({ host: '127.0.0.1', port: 0 }, faker)
  const ask = async (query: string | { query: string; operationName: string }, variables?: Record<string, unknown>): Promise<{ status: number; body: Json }> => {
    const response = await fetch(endpoint.address, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(typeof query === 'string' ? { query } : query), ...(variables && { variables }) }),
    })
    const body = await response.json()
    seen.push(body)
    return { status: response.status, body }
  }
  return {
    address: endpoint.address,
    connection,
    ask,
    async close() {
      await endpoint.close()
      store.close()
    },
  }
}

let api: FakeGraphql
let sosie: Awaited<ReturnType<typeof startGraphqlSosie>>

beforeAll(async () => {
  api = await startGraphql()
  sosie = await startGraphqlSosie(api)
})

afterAll(async () => {
  await sosie.close()
  await api.close()
  expect(canariesIn(JSON.stringify(seen))).toEqual([])
})

describe('a GraphQL API', () => {
  it('is read by introspection, and its types become entities', () => {
    expect(graphql.matches(new URL(api.url))).toBe(true)
    expect(graphql.matches(new URL('https://api.internal/v1/users'))).toBe(false)
    expect(sosie.connection.summary).toBe('6 types, 11 queries')
    const user = sosie.connection.schema.entities.find((e) => e.id === 'User')!
    expect(user.fields.find((f) => f.name === 'email')).toMatchObject({ format: 'email' })
    expect(sosie.connection.schema.entities.find((e) => e.id === 'Order')!.fields.find((f) => f.name === 'userId')!.references).toBe('User.id')
  })

  it('fakes every value of the data', async () => {
    const { body } = await sosie.ask('{ users { id email name role address { city } apiKey } }')
    expect(body.data.users).toHaveLength(3)
    expect(body.data.users[0].email).toMatch(/@example\.(com|net|org)$/)
    for (const u of body.data.users) expect(['admin', 'editor', 'viewer']).toContain(u.role)
    expect(body.data.users[0].id).not.toBe('1')
  })

  it('finds a record by a fake in an argument or a variable', async () => {
    const [first, second] = (await sosie.ask('{ users { id email } }')).body.data.users
    expect((await sosie.ask(`{ user(id: "${first.id}") { id email } }`)).body.data.user).toEqual(first)
    expect((await sosie.ask('query ($id: ID!) { user(id: $id) { id email } }', { id: first.id })).body.data.user).toEqual(first)
    expect((await sosie.ask(`{ users(email: "${second.email}") { id } }`)).body.data.users).toEqual([{ id: second.id }])
  })

  it('keeps ids consistent through relations, ids by name, aliases and fragments', async () => {
    const { body } = await sosie.ask(`{
      people: users { ...person orders { userId user { id } } }
    }
    fragment person on User { __typename id }`)
    const quill = body.data.people[0]
    expect(quill.__typename).toBe('User')
    expect(quill.orders).toHaveLength(2)
    for (const o of quill.orders) {
      expect(o.userId).toBe(quill.id)
      expect(o.user.id).toBe(quill.id)
    }
    const byArgument = (await sosie.ask(`{ orders(userId: "${quill.id}") { userId } }`)).body.data.orders
    expect(byArgument).toEqual([{ userId: quill.id }, { userId: quill.id }])
  })

  it('answers introspection from the schema, without the API', async () => {
    const before = api.received.length
    expect((await sosie.ask('{ __schema { queryType { name } } }')).body.data).toEqual({ __schema: { queryType: { name: 'Query' } } })
    expect((await sosie.ask('query ($n: String!) { __type(name: $n) { name } }', { n: 'User' })).body.data).toEqual({ __type: { name: 'User' } })
    expect(api.received.length).toBe(before)
  })

  it('never turns a fake back into its real value for introspection, nor for a variable of the wrong type', async () => {
    const [quill] = (await sosie.ask('{ users { email apiKey } }')).body.data.users
    const before = api.received.length
    for (const n of [[quill.email], { a: quill.apiKey }]) {
      const { status, body } = await sosie.ask('query ($n: String!) { __type(name: $n) { name } }', { n })
      expect(status).toBe(400)
      expect(body.errors[0].message).toMatch(/^Variable "\$n" has invalid value/)
    }
    const typed = await sosie.ask('query ($e: String) { users(email: $e) { id } }', { e: [quill.email] })
    expect(typed.status).toBe(400)
    const mixed = await sosie.ask(`{ __type(name: "User") { name } users(email: "${quill.email}") { id } }`)
    expect(mixed.body.errors[0].message).toBe('Ask for __schema and __type in a query of their own: Sosie answers them from the schema, without the API.')
    expect(api.received.length).toBe(before)
  })

  it('fakes a JSON key that echoes a value it turned back, and reads any scalar that holds an object', async () => {
    const [quill] = (await sosie.ask('{ users { handle settings } }')).body.data.users
    expect(Object.keys(quill.settings)).toEqual(['theme', 'home'])
    const { body } = await sosie.ask('query ($h: [String!]!) { usersByHandles(handles: $h) }', { h: [quill.handle] })
    expect(api.received.at(-1)!.variables).toEqual({ h: ['quillon'] })
    expect(Object.keys(body.data.usersByHandles)).toHaveLength(1)
    expect(Object.keys(body.data.usersByHandles)[0]).not.toBe('quillon')
  })

  it('sends the API only the operation to run, and the fragments it uses', async () => {
    const { body } = await sosie.ask(
      { query: 'query Q { users { ...F } } mutation M { deleteUser(id: "1") } fragment F on User { id }', operationName: 'Q' },
    )
    expect(body.data.users).toHaveLength(3)
    expect(api.received.at(-1)!.query).toMatch(/fragment F on User/)
    expect(api.received.at(-1)!.query).not.toMatch(/mutation|deleteUser/)
  })

  it('turns back a fake in a variable’s default, and in an operator’s object', async () => {
    const [quill] = (await sosie.ask('{ users { id email } }')).body.data.users
    const byDefault = await sosie.ask(`query ($id: ID! = "${quill.id}") { user(id: $id) { id email } }`)
    expect(byDefault.body.data.user).toEqual(quill)
    expect(api.received.at(-1)!.variables).toEqual({ id: '1' })
    const filtered = await sosie.ask(`{ filtered(where: { id: { _eq: "${quill.id}" } }) { id } }`)
    expect(filtered.body.data.filtered).toEqual([{ id: quill.id }])
  })

  it('refuses a query too large to read without keeping others waiting', async () => {
    const { status, body } = await sosie.ask(`{ ${Array.from({ length: 3000 }, (_, i) => `a${i}: users { id }`).join(' ')} }`)
    expect(status).toBe(400)
    expect(body.errors[0].message).toMatch(/more than 10000 tokens/)
  })

  it('lets sosie.yml name a scalar of the query type', async () => {
    expect((await sosie.ask('{ motd }')).body.data.motd).not.toBe('Hello')
    const lenient = await startGraphqlSosie(api, { rules: 'pass:\n  - Query.motd\n' })
    expect((await lenient.ask('{ motd }')).body.data.motd).toBe('Hello')
    await lenient.close()
  })

  it('merges a field asked for twice, by fragments or aliases', async () => {
    const whole = (await sosie.ask('{ users { id email address { city } } }')).body.data.users
    const split = await sosie.ask(`{ users { ...A ...B } }
      fragment A on User { id address { city } }
      fragment B on User { email address { __typename } }`)
    expect(split.body.data.users.map((u: Json) => ({ id: u.id, email: u.email, address: { city: u.address.city } }))).toEqual(whole)
    expect(split.body.data.users[0].address.__typename).toBe('Address')
    const twice = (await sosie.ask(`{ user(id: "${whole[0].id}") { id } user(id: "${whole[0].id}") { email } }`)).body.data.user
    expect(twice).toEqual({ id: whole[0].id, email: whole[0].email })
  })

  it('fakes a member of an interface or a union by its own type, whatever the query asks', async () => {
    const strict = await startGraphqlSosie(api, { rules: 'pass:\n  - Product.*\n' })
    const [quill] = (await strict.ask('{ users { id name email } }')).body.data.users
    for (const query of [
      '{ search { ... on User { name } ... on Product { name } } }',
      '{ search { ... on Product { name } ... on User { name } } }',
      '{ search { ... on User { x: name } ... on Product { x: sku } } }',
    ]) {
      const [user, product] = (await strict.ask(query)).body.data.search
      expect(Object.values(user)).toEqual([quill.name])
      expect(Object.values(product)).toEqual([query.includes('x: sku') ? 'W-1' : 'Plain Widget'])
    }
    // Ids under an interface are the type's own, so a fake id finds its record through node(id:).
    const node = (await strict.ask(`{ node(id: "${quill.id}") { __typename id ... on User { email } } }`)).body.data.node
    expect(node).toEqual({ __typename: 'User', id: quill.id, email: quill.email })
    await strict.close()
  })

  it('finds records by a boolean or an enum label it showed', async () => {
    // A field's booleans flip, and its labels move, by the store's key: find a store where both do for the first user.
    for (let tries = 0; tries < 30; tries++) {
      const s = await startGraphqlSosie(api)
      const [quill] = (await s.ask('{ users { id role active } }')).body.data.users
      if (quill.role === 'admin' || quill.active === true) {
        await s.close()
        continue
      }
      expect((await s.ask(`{ users(role: ${quill.role}) { id } }`)).body.data.users).toEqual([{ id: quill.id }])
      expect(api.received.at(-1)!.query).toMatch(/users\(role: admin\)/)
      expect((await s.ask('query ($a: Boolean) { users(active: $a) { id } }', { a: false })).body.data.users).toContainEqual({ id: quill.id })
      expect(api.received.at(-1)!.variables).toEqual({ a: true })
      await s.close()
      return
    }
    throw new Error('No store moved both role and active in 30 tries.')
  })

  it('answers GET and batches', async () => {
    const get = (await (await fetch(`${sosie.address}?query=${encodeURIComponent('{ users { id } }')}`)).json()) as Json
    expect(get.data.users).toHaveLength(3)
    const batch = (await (
      await fetch(sosie.address, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ query: '{ users { id } }' }, { query: '{ orders { id } }' }]) })
    ).json()) as Json
    expect(batch.map((b: Json) => Object.keys(b.data))).toEqual([['users'], ['orders']])
    seen.push(get, batch)
  })
})

describe('the guard', () => {
  it('sends no mutation to the API', async () => {
    const before = api.operations.length
    const { status, body } = await sosie.ask('mutation { deleteUser(id: "1") }')
    expect(status).toBe(400)
    expect(body.errors[0]).toEqual({
      message: 'Sosie is read-only: only queries reach the API, not mutations or subscriptions.',
      extensions: { code: 'SOSIE_READ_ONLY' },
    })
    expect(api.operations.slice(before)).toEqual([])
  })

  it('hides every message the API sends, with data or without, and keeps only a path and a code it can trust', async () => {
    const { body } = await sosie.ask('{ refused }')
    expect(body).toEqual({
      errors: [
        { message: 'The API refused the query; Sosie hides its message, which may quote a value from your data.', extensions: { code: 'FORBIDDEN' } },
        { message: 'The API refused the query; Sosie hides its message, which may quote a value from your data.' },
        { message: 'The API refused the query; Sosie hides its message, which may quote a value from your data.' },
        { message: 'The API refused the query; Sosie hides its message, which may quote a value from your data.' },
        { message: 'The API refused the query; Sosie hides its message, which may quote a value from your data.', extensions: { code: 'ACCESS_DENIED' } },
      ],
    })
  })

  it('never follows a redirect: the query and the credentials stay with the API', async () => {
    const recorder = await startRecorder()
    const redirecting = await startGraphql({ elsewhere: recorder.url })
    const s = await startGraphqlSosie(redirecting)
    expect((await s.ask('{ moved }')).status).toBe(502)
    expect(recorder.requests).toEqual([])
    await s.close()
    await redirecting.close()
    await recorder.close()
  })

  it('answers localhost only, takes a POST as JSON or GraphQL only, and refuses a request it cannot read', async () => {
    const { port } = new URL(sosie.address)
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        httpRequest({ host: '127.0.0.1', port, path: `/api/graphql?query=${encodeURIComponent('{ users { id } }')}`, headers: { host } }, (res) => {
          res.resume()
          resolve(res.statusCode!)
        })
          .on('error', reject)
          .end()
      })
    expect(await status('attacker.example')).toBe(403)
    expect(await status(`localhost:${port}`)).toBe(200)
    const post = (body: string, type: string) => fetch(sosie.address, { method: 'POST', headers: { 'content-type': type }, body })
    expect((await post(JSON.stringify({ query: '{ users { id } }' }), 'text/plain')).status).toBe(415)
    expect((await post('{ users { id } }', 'application/graphql')).status).toBe(200)
    expect((await post('null', 'application/json')).status).toBe(400)
    expect(await (await post('[null]', 'application/json')).json()).toEqual([{ errors: [{ message: 'A request is a JSON object with a query.' }] }])
    expect((await fetch(`${sosie.address}?query=${encodeURIComponent('{ users { id } }')}&variables=notjson`)).status).toBe(400)
  })

  it('cuts a list at --max-rows, and says so', async () => {
    const small = await startGraphqlSosie(api, { maxRows: 2 })
    const { body } = await small.ask('{ users { id } }')
    expect(body.data.users).toHaveLength(2)
    expect(body.extensions).toEqual({
      sosie: 'Sosie returned the first 2 items of a list; the rest were cut. Narrow the query, or start Sosie with a higher --max-rows.',
    })
    await small.close()
  })

  it('hides a resolver’s message, and keeps a check of the query against the schema', async () => {
    const broken = (await sosie.ask('{ broken }')).body
    expect(broken.errors[0]).toEqual({ message: 'A resolver failed; Sosie hides its message, which may quote a value from your data.', path: ['broken'] })
    const invalid = await sosie.ask('{ users { nope } }')
    expect(invalid.status).toBe(400)
    expect(invalid.body.errors[0].message).toMatch(/^Cannot query field "nope" on type "User"\./)
  })
})

describe('a schema that is not valid GraphQL', () => {
  it('stops Sosie at start, saying why, instead of failing every query', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sosie-sdl-')), 'schema.graphql')
    writeFileSync(file, 'type Query { a: Empty }\ntype Empty\n')
    await expect(startGraphqlSosie(api, { env: { SOSIE_GRAPHQL_SCHEMA: file } })).rejects.toThrow(/is not valid GraphQL: Type Empty must define one or more fields/)
  })
})

describe('without introspection', () => {
  it('says to name a schema file, and reads one', async () => {
    const closed = await startGraphql({ introspection: false })
    await expect(startGraphqlSosie(closed)).rejects.toThrow(/by introspection \(GraphQL introspection is not allowed\)\. Set SOSIE_GRAPHQL_SCHEMA/)
    const file = join(mkdtempSync(join(tmpdir(), 'sosie-sdl-')), 'schema.graphql')
    writeFileSync(file, SDL)
    const s = await startGraphqlSosie(closed, { env: { SOSIE_GRAPHQL_SCHEMA: file } })
    expect((await s.ask('{ users { email } }')).body.data.users).toHaveLength(3)
    // Clients introspect Sosie, which answers from the file.
    expect((await s.ask('{ __type(name: "User") { name } }')).body.data).toEqual({ __type: { name: 'User' } })
    await s.close()
    await closed.close()
  })
})

describe('one store for every source', () => {
  it('gives a person the same fake email in the database and the GraphQL API', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sosie-both-'))
    const db = await startSosie({ home })
    const c = await db.client()
    const { rows } = await c.query("SELECT email FROM users WHERE external_id = 'd3adb33f-0000-4000-8000-c0ffee000001'")
    const fromApi = await startGraphqlSosie(api, { home })
    const quill = (await fromApi.ask('{ user(id: "1") { email } }')).body.data
    // id "1" is a real id here, not one Sosie showed: it reads the real record, as the LLD says of values never shown.
    expect(quill.user.email).toBe(rows[0].email)
    seen.push(rows)
    await fromApi.close()
    await db.close()
  })
})

describe('the MCP tool', () => {
  it('runs a query through the running endpoint', async () => {
    const running: Running = { kind: 'graphql', address: sosie.address, schema: { entities: [] }, passing: [] }
    const result = (await graphql.tools![0]!.run({ query: 'query ($e: String) { users(email: $e) { id } }', variables: '{"e": null}' }, running)) as Json
    expect(result.data.users).toHaveLength(3)
    seen.push(result)
    await expect(graphql.tools![0]!.run({ query: '{ users { id } }', variables: 'notjson' }, running)).rejects.toThrow(
      'The variables are not JSON: write them as {"id": "87"}.',
    )
  })
})
