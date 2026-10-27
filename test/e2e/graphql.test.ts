import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFaker, loadRules, Store, storeDir, type Running } from '@sosie/core'
import { graphql } from '@sosie/graphql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TOKEN } from './api.js'
import { canariesIn } from './canaries.js'
import { SDL, startGraphql, type FakeGraphql } from './graphql-api.js'
import { startSosie } from './sosie.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- GraphQL responses. */
type Json = any

/** Everything Sosie returned in this file, searched for canaries at the end. */
const seen: unknown[] = []

async function startGraphqlSosie(api: FakeGraphql, { home = mkdtempSync(join(tmpdir(), 'sosie-gql-')), env = {} as Record<string, string> } = {}) {
  const connection = await graphql.connect(new URL(api.url), {
    maxRows: 1000,
    statementTimeout: 5000,
    env: { SOSIE_UPSTREAM_HEADERS: `Authorization: Bearer ${TOKEN}`, ...env },
  })
  const store = Store.open(storeDir(home))
  const faker = createFaker({ schema: connection.schema, rules: loadRules('', connection.schema), store })
  const endpoint = await connection.serve({ host: '127.0.0.1', port: 0 }, faker)
  const ask = async (query: string, variables?: Record<string, unknown>): Promise<{ status: number; body: Json }> => {
    const response = await fetch(endpoint.address, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, ...(variables && { variables }) }),
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
    expect(sosie.connection.summary).toBe('3 types, 4 queries')
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

  it('passes introspection as it is', async () => {
    expect((await sosie.ask('{ __schema { queryType { name } } }')).body.data).toEqual({ __schema: { queryType: { name: 'Query' } } })
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

  it('hides a resolver’s message, and keeps a check of the query against the schema', async () => {
    const broken = (await sosie.ask('{ broken }')).body
    expect(broken.errors[0]).toEqual({ message: 'A resolver failed; Sosie hides its message, which may quote a value from your data.', path: ['broken'] })
    const invalid = await sosie.ask('{ users { nope } }')
    expect(invalid.status).toBe(400)
    expect(invalid.body.errors[0].message).toMatch(/^Cannot query field "nope" on type "User"\./)
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
  })
})
