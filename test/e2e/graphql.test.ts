import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createFaker, loadRules, Store, storeDir, type Running } from '@sosie/core'
import { graphql } from '@sosie/graphql'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Checker } from '../../packages/graphql/src/check.js'
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

/** What `work` gives, and the longest Sosie's event loop, in this process, stood still meanwhile: every other client waits that long. */
async function stillest<T>(work: Promise<T>): Promise<{ result: T; ms: number }> {
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()
  try {
    const result = await work
    return { result, ms: loop.max / 1e6 }
  } finally {
    loop.disable()
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
    expect(sosie.connection.summary).toBe('8 types, 16 queries')
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
    expect(mixed.body.errors[0].message).toBe('Ask for __schema and __type at the root of a query of their own: Sosie answers them from the schema, without the API.')
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

  it('refuses a query too costly to check or to answer, and answers other clients meanwhile', async () => {
    // The same field a thousand times: graphql-js compares each pair. Introspection that multiplies its answer by aliases.
    const costly = `{ ${Array(1100).fill('user(id: 1) { id }').join(' ')} }`
    const w = Array.from({ length: 20 }, (_, i) => i)
    const fan =
      `{ __schema { ${w.map((i) => `t${i}: types { ...A }`).join(' ')} } } fragment A on __Type { ${w.map((i) => `a${i}: fields { ...B }`).join(' ')} } ` +
      `fragment B on __Field { ${w.map((i) => `b${i}: type { ...C }`).join(' ')} } fragment C on __Type { ${w.map((i) => `c${i}: name`).join(' ')} }`
    for (const query of [costly, fan]) {
      const meanwhile: number[] = []
      const heavy = sosie.ask(query)
      const others = (async () => {
        for (let i = 0; i < 5; i++) meanwhile.push((await sosie.ask('{ motd }')).status)
      })()
      const { result, ms } = await stillest(heavy)
      await others
      expect(result).toMatchObject({ status: 400, body: { errors: [{ extensions: { code: 'SOSIE_TOO_COSTLY' } }] } })
      expect(meanwhile).toEqual([200, 200, 200, 200, 200])
      expect(ms).toBeLessThan(1000)
    }
    // A thread that was stopped is replaced: introspection is answered again.
    expect((await sosie.ask('{ __schema { queryType { name } } }')).body).toEqual({ data: { __schema: { queryType: { name: 'Query' } } } })
  })

  it('answers a batch’s introspection no larger, together, than one answer may be', async () => {
    const t = Array.from({ length: 60 }, (_, i) => `t${i}: types { ...A }`).join(' ')
    const f = Array.from({ length: 40 }, (_, i) => `f${i}: fields { name type { name } }`).join(' ')
    // About 9 MB each: two fit in the 20 MB one answer may take, the third does not.
    const fan = { query: `{ __schema { ${t} } } fragment A on __Type { name ${f} }` }
    const response = await fetch(sosie.address, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([fan, fan, fan]) })
    expect(response.status).toBe(200)
    const body = (await response.json()) as Json[]
    expect(body[0].data.__schema.t0.length).toBeGreaterThan(0)
    expect(body[1].data.__schema.t0.length).toBeGreaterThan(0)
    expect(body[2]).toMatchObject({ errors: [{ extensions: { code: 'SOSIE_TOO_COSTLY' } }] })
  })

  it('answers a query it is checking when it stops, instead of leaving it waiting', async () => {
    const s = await startGraphqlSosie(api)
    const asked = s.ask(`{ ${Array(1100).fill('user(id: 1) { id }').join(' ')} }`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await s.close()
    expect(await asked).toMatchObject({ status: 400, body: { errors: [{ message: 'Sosie is stopping.' }] } })
  })

  it('fakes a large JSON value a slice at a time, and answers other clients meanwhile', async () => {
    const { result, ms } = await stillest(sosie.ask('{ big(n: 20000) }'))
    expect(Object.keys(result.body.data.big)).toHaveLength(20000)
    expect(ms).toBeLessThan(1000)
  })

  it('sends a value compared with a field that passes as written, so no other field’s real value comes back in it', async () => {
    const lenient = await startGraphqlSosie(api, { rules: 'pass:\n  - Report.country\n  - Report.note\n' })
    const [quill] = (await lenient.ask('{ users { name email } }')).body.data.users
    const { body } = await lenient.ask(`{ report(country: ${JSON.stringify(quill.name)}) { country } }`)
    expect(api.received.at(-1)!.query).toContain(JSON.stringify(quill.name))
    expect(body.data.report.country).toBe(quill.name)
    // Text that names no field is looked up anywhere; a field that passes and echoes it shows the fake the client sent.
    const echo = (await lenient.ask(`{ report(q: ${JSON.stringify(quill.email)}) { note } }`)).body
    expect(api.received.at(-1)!.query).toContain('"quill.vantablack@canary-mail.test"')
    expect(echo.data.report.note).toBe(`Results for ${quill.email}`)
    await lenient.close()
  })

  it('sends a variable as written for every use when one compares it with a field that passes', async () => {
    const lenient = await startGraphqlSosie(api, { rules: 'pass:\n  - Report.country\n' })
    const [quill] = (await lenient.ask('{ users { email } }')).body.data.users
    // One value goes for every use: compared first with a field that passes, it stays the fake, whatever comes after.
    await lenient.ask('query ($v: String) { report(country: $v) { country } users(email: $v) { id } }', { v: quill.email })
    expect(api.received.at(-1)!.variables).toEqual({ v: quill.email })
    await lenient.ask('query ($v: String) { users(email: $v) { id } report(country: $v) { country } }', { v: quill.email })
    expect(api.received.at(-1)!.variables).toEqual({ v: quill.email })
    // Used only where no field passes, it is the real value.
    await lenient.ask('query ($v: String) { a: users(email: $v) { id } b: users(email: $v) { id } }', { v: quill.email })
    expect(api.received.at(-1)!.variables).toEqual({ v: 'quill.vantablack@canary-mail.test' })
    await lenient.close()
  })

  it('stops its checking threads when its port is taken', async () => {
    const taken = createServer()
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve))
    const { port } = taken.address() as { port: number }
    const connection = await graphql.connect(new URL(api.url), { maxRows: 10, statementTimeout: 5000, env: { SOSIE_UPSTREAM_HEADERS: `Authorization: Bearer ${TOKEN}` } })
    const store = Store.open(storeDir(mkdtempSync(join(tmpdir(), 'sosie-gql-'))))
    const close = vi.spyOn(Checker.prototype, 'close')
    try {
      const faker = createFaker({ schema: connection.schema, rules: loadRules('', connection.schema), store })
      await expect(connection.serve({ host: '127.0.0.1', port }, faker)).rejects.toThrow(/EADDRINUSE|in use/)
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      close.mockRestore()
      store.close()
      await connection.close()
      await new Promise((resolve) => taken.close(resolve))
    }
  })

  it('shows the fake the client sent where a field that passes echoes a label or a boolean Sosie turned back', async () => {
    const lenient = await startGraphqlSosie(api, { rules: 'pass:\n  - User.matchedBy\n' })
    // Every label and boolean the client saw turns back into a real one; the API echoes that one as it filtered by it.
    for (const role of ['admin', 'editor', 'viewer']) {
      const { users } = (await lenient.ask(`{ users(role: ${role}) { matchedBy } }`)).body.data
      expect(users.length, role).toBeGreaterThan(0)
      for (const u of users) expect(u.matchedBy, role).toEqual({ role })
    }
    for (const active of [true, false]) {
      const { users } = (await lenient.ask(`{ users(active: ${active}) { matchedBy } }`)).body.data
      for (const u of users) expect(u.matchedBy).toEqual({ active })
    }
    await lenient.close()
  })

  it('fakes a JSON key that holds its own credentials, even one that looks like a word', async () => {
    // A Rails-style header writes its token in quotes.
    const s = await startGraphqlSosie(api, { env: { SOSIE_UPSTREAM_HEADERS: `Authorization: Bearer ${TOKEN}\nX-Api-Key: Token token="sesamesecretword"` } })
    const { body } = await s.ask('{ debug }')
    expect(Object.keys(body.data.debug)).toHaveLength(2)
    expect(body.data.debug.theme).toBeDefined()
    expect(JSON.stringify(body)).not.toMatch(/sesamesecretword/)
    await s.close()
  })

  it('keeps an id beyond 2^53 exact, so its fake leads back to its record', async () => {
    const text = async (query: string) =>
      (await fetch(sosie.address, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) })).text()
    const first = await text('{ account { id } }')
    const id = /"id":(\d+)/.exec(first)![1]!
    expect(id).not.toBe('1234567890123456789')
    const again = await text(`{ account(id: "${id}") { id } }`)
    expect(api.received.at(-1)!.query).toContain('"1234567890123456789"')
    expect(again).toContain(`"id":${id}`)
    // So does the MCP tool's answer.
    const running: Running = { kind: 'graphql', address: sosie.address, schema: { entities: [] }, passing: [] }
    expect(JSON.stringify(await graphql.tools![0]!.run({ query: '{ account { id } }' }, running))).toContain(`"id":${id}`)
  })

  it('answers no introspection the API would see, at any depth', async () => {
    const before = api.received.length
    for (const query of ['{ query { __schema { queryType { name } } } }', '{ query { ...F } } fragment F on Query { __type(name: "User") { name } }']) {
      const { status, body } = await sosie.ask(query)
      expect(status, query).toBe(400)
      expect(body.errors[0].message).toMatch(/at the root of a query of their own/)
    }
    expect(api.received.length).toBe(before)
  })

  it('looks up and sends the variables of the operation it runs only', async () => {
    const lenient = await startGraphqlSosie(api, { rules: 'pass:\n  - Report.country\n' })
    const [quill] = (await lenient.ask('{ users { email } }')).body.data.users
    // Another operation uses $v with a field that passes: it is not sent, so it says nothing of $v.
    const query = 'query A($v: String) { users(email: $v) { id } } query B($v: String) { report(country: $v) { country } }'
    await lenient.ask({ query, operationName: 'A' }, { v: quill.email, extra: 'quill.vantablack@canary-mail.test' })
    expect(api.received.at(-1)!.variables).toEqual({ v: 'quill.vantablack@canary-mail.test' })
    await lenient.close()
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
    // A batch may hold introspection, answered by another thread, as JSON written there.
    const mixed = (await (
      await fetch(sosie.address, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ query: '{ __typename }' }, { query: '{ motd }' }]) })
    ).json()) as Json
    expect(mixed[0]).toEqual({ data: { __typename: 'Query' } })
    expect(Object.keys(mixed[1].data)).toEqual(['motd'])
    seen.push(get, batch, mixed)
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
        { message: 'The API refused the query; Sosie hides its message, which may quote a value from your data.', extensions: { code: 'ORDER_NOT_FOUND' } },
        { message: 'The API refused the query; Sosie hides its message, which may quote a value from your data.', extensions: { code: 'QUERY_TOO_COMPLEX' } },
        ...Array(4).fill({ message: 'The API refused the query; Sosie hides its message, which may quote a value from your data.' }),
      ],
    })
    // Nor what the API says its answer is.
    expect(await sosie.ask('{ weird: motd }')).toEqual({ status: 502, body: { errors: [{ message: 'The API did not answer with JSON; Sosie fakes JSON only.' }] } })
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
    // Too large to read, or a batch of too many: refused, saying so.
    const large = await post(JSON.stringify({ query: '{ motd }', variables: { pad: 'x'.repeat(1024 * 1024) } }), 'application/json')
    expect(large.status).toBe(413)
    expect(await large.json()).toEqual({ errors: [{ message: 'Sosie takes a request of up to 1 MB.' }] })
    const many = await post(JSON.stringify(Array(51).fill({ query: '{ motd }' })), 'application/json')
    expect(many.status).toBe(400)
    expect(await many.json()).toEqual({ errors: [{ message: 'A batch has at most 50 operations.' }] })
  })

  it('answers no page of another site, so a web page cannot make it send a query', async () => {
    const { port } = new URL(sosie.address)
    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const path = `/api/graphql?query=${encodeURIComponent('{ users { id } }')}`
        httpRequest({ host: '127.0.0.1', port, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
          res.resume()
          resolve(res.statusCode!)
        })
          .on('error', reject)
          .end()
      })
    const before = api.received.length
    expect(await status({ origin: 'https://attacker.example' })).toBe(403)
    expect(await status({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' })).toBe(403)
    expect(api.received.length).toBe(before)
    expect(await status({ origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'cross-site' })).toBe(200)
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
