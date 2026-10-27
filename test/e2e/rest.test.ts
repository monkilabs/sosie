import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFaker, loadRules, Store, storeDir, type Running } from '@sosie/core'
import { rest } from '@sosie/rest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApi, TOKEN, type FakeApi } from './api.js'
import { canariesIn } from './canaries.js'
import { startSosie } from './sosie.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies. */
type Json = any

/** Everything Sosie returned in this file, searched for canaries at the end. */
const seen: unknown[] = []

async function startRest(api: FakeApi, { home = mkdtempSync(join(tmpdir(), 'sosie-rest-')), rules = '', env = {} as Record<string, string> } = {}) {
  const connection = await rest.connect(new URL(api.url), {
    maxRows: 1000,
    statementTimeout: 5000,
    env: { SOSIE_UPSTREAM_HEADERS: `Authorization: Bearer ${TOKEN}`, ...env },
  })
  const store = Store.open(storeDir(home))
  const loaded = loadRules(rules, connection.schema, 'sosie.yml', { learns: !!connection.learns })
  const faker = createFaker({ schema: connection.schema, rules: loaded, store })
  const endpoint = await connection.serve({ host: '127.0.0.1', port: 0 }, faker)
  const get = async (path: string, init?: RequestInit): Promise<{ status: number; body: Json }> => {
    const response = await fetch(path.startsWith('http') ? path : `${endpoint.address}${path}`, init)
    const text = await response.text()
    const body = text ? JSON.parse(text) : null
    seen.push(body)
    return { status: response.status, body }
  }
  return {
    address: endpoint.address,
    connection,
    rules: loaded,
    get,
    async close() {
      await endpoint.close()
      store.close()
    },
  }
}

let api: FakeApi
let sosie: Awaited<ReturnType<typeof startRest>>

beforeAll(async () => {
  api = await startApi()
  sosie = await startRest(api)
})

afterAll(async () => {
  await sosie.close()
  await api.close()
  expect(canariesIn(JSON.stringify(seen))).toEqual([])
})

describe('an API without an OpenAPI document', () => {
  it('says so, and names fields by where values sit', () => {
    expect(sosie.connection.summary).toBe('no OpenAPI document')
    expect(sosie.connection.warnings[0]).toMatch(/^No OpenAPI document found/)
    expect(sosie.address).toMatch(/^http:\/\/localhost:\d+\/v1$/)
  })

  it('fakes every value of a response, envelope and all', async () => {
    const { status, body } = await sosie.get('/users')
    expect(status).toBe(200)
    expect(body.data).toHaveLength(3)
    expect(body.data[0].email).toMatch(/@example\.(com|net|org)$/)
    expect(body.data[0].id).not.toBe(1)
    expect(Object.keys(body.data[0])).toEqual(['id', 'email', 'name', 'role', 'address', 'apiKey'])
  })

  it('finds a record by a fake id in the path, or a fake value in the query', async () => {
    const { body } = await sosie.get('/users')
    const [first, second] = body.data
    expect((await sosie.get(`/users/${first.id}`)).body).toEqual(first)
    expect((await sosie.get(`/users?email=${encodeURIComponent(second.email)}`)).body.data).toEqual([second])
  })

  it('keeps ids consistent across resources, so they join', async () => {
    const { body } = await sosie.get('/users')
    const quill = body.data[0]
    const nested = (await sosie.get(`/users/${quill.id}/orders`)).body
    expect(nested).toHaveLength(2)
    for (const order of nested) expect(order.userId).toBe(quill.id)
    expect((await sosie.get(`/orders?userId=${quill.id}`)).body).toEqual(nested)
  })

  it('fakes keys that are values', async () => {
    const { body } = await sosie.get('/contacts')
    for (const key of Object.keys(body)) expect(key).toMatch(/@example\.(com|net|org)$/)
  })

  it('points links into the API at Sosie, with fakes that lead back to the same records', async () => {
    const { body } = await sosie.get('/self')
    expect(body.href.startsWith(`${sosie.address}/users/`)).toBe(true)
    const linked = (await sosie.get(body.href)).body
    expect(linked).toEqual((await sosie.get('/users')).body.data[0])
    expect(body.owner).toMatch(new RegExp(`^${sosie.address}/users/\\d+/orders\\?userId=\\d+&page=2$`))
    const next = (await sosie.get('/users')).body.next
    expect(next).toBe(`${sosie.address}/users?page=2`)
  })

  it('applies sosie.yml to fields not met yet, and warns that they are', async () => {
    const lenient = await startRest(api, { rules: 'pass:\n  - order.status\n' })
    expect(lenient.rules.warnings).toEqual(['sosie.yml: order is not known yet; It applies once Sosie meets it.'])
    const orders = (await lenient.get('/orders')).body
    expect(orders.map((o: Json) => o.status)).toEqual(['paid', 'new', 'shipped'])
    await lenient.close()
  })
})

describe('the guard and the credentials', () => {
  it('sends only GET and HEAD to the API', async () => {
    const before = api.requests.length
    const post = await sosie.get('/users', { method: 'POST', body: '{}' })
    expect(post).toEqual({ status: 405, body: { error: 'Sosie is read-only: only GET and HEAD reach the API.' } })
    expect(api.requests.length).toBe(before)
    const head = await fetch(`${sosie.address}/users`, { method: 'HEAD' })
    expect(head.status).toBe(200)
  })

  it('sends its own credentials, never the client’s', async () => {
    await sosie.get('/users', { headers: { authorization: 'Bearer from-the-agent' } })
    expect(api.requests.at(-1)!.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('passes a refusal on, with its body faked', async () => {
    const without = await startRest(api, { env: { SOSIE_UPSTREAM_HEADERS: '' } })
    expect((await without.get('/users')).status).toBe(401)
    await without.close()
  })

  it('fakes error bodies, and does not pass on what it cannot fake', async () => {
    const missing = await sosie.get('/missing')
    expect(missing.status).toBe(404)
    expect(missing.body.error).not.toMatch(/canary/)
    expect(await sosie.get('/avatar')).toEqual({
      status: 502,
      body: { error: 'The API answered with image/png; Sosie fakes JSON only, so it does not pass it on.' },
    })
    expect((await sosie.get('/elsewhere')).status).toBe(502)
  })
})

describe('an API with an OpenAPI document', () => {
  it('finds the document, and fakes each value by its schema', async () => {
    const documented = await startApi({ withOpenapi: true })
    const s = await startRest(documented)
    expect(s.connection.summary).toBe('OpenAPI 3.1, 2 schemas, 3 GET paths')
    expect(s.connection.schema.entities.find((e) => e.id === 'Order')!.fields.find((f) => f.name === 'userId')!.references).toBe('User.id')
    const users = (await s.get('/users')).body.data
    for (const u of users) expect(['admin', 'editor', 'viewer']).toContain(u.role)
    const orders = (await s.get(`/users/${users[0].id}/orders`)).body
    for (const o of orders) {
      expect(o.userId).toBe(users[0].id)
      expect(['new', 'paid', 'shipped']).toContain(o.status)
    }
    await s.close()
    await documented.close()
  })
})

describe('one store for every source', () => {
  it('gives a person the same fake email in the database and the API', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sosie-both-'))
    const db = await startSosie({ home })
    const c = await db.client()
    const { rows } = await c.query("SELECT email FROM users WHERE external_id = 'd3adb33f-0000-4000-8000-c0ffee000001'")
    const fromApi = await startRest(api, { home })
    const quill = (await fromApi.get('/users')).body.data[0]
    expect(quill.email).toBe(rows[0].email)
    seen.push(rows)
    await fromApi.close()
    await db.close()
  })
})

describe('the MCP tool', () => {
  it('sends a GET through the running endpoint', async () => {
    const running: Running = { kind: 'rest', address: sosie.address, schema: { entities: [] }, passing: [] }
    const result = (await rest.tools![0]!.run({ path: '/users' }, running)) as Json
    expect(result.status).toBe(200)
    expect(result.body.data).toHaveLength(3)
    seen.push(result)
  })
})
