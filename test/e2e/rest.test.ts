import { mkdtempSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { createFaker, loadRules, Store, storeDir, type Running } from '@sosie/core'
import { rest } from '@sosie/rest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApi, startRecorder, TOKEN, type FakeApi } from './api.js'
import { canariesIn } from './canaries.js'
import { startSosie } from './sosie.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies. */
type Json = any

/** Everything Sosie returned in this file, searched for canaries at the end. */
const seen: unknown[] = []

async function startRest(
  api: FakeApi,
  { home = mkdtempSync(join(tmpdir(), 'sosie-rest-')), rules = '', env = {} as Record<string, string>, maxRows = 1000, query = '' } = {},
) {
  const connection = await rest.connect(new URL(`${api.url}${query}`), {
    maxRows,
    statementTimeout: 5000,
    env: { SOSIE_UPSTREAM_HEADERS: `Authorization: Bearer ${TOKEN}`, ...env },
  })
  const store = Store.open(storeDir(home))
  const loaded = loadRules(rules, connection.schema, 'sosie.yml', { learns: !!connection.learns })
  const faker = createFaker({ schema: connection.schema, rules: loaded, store })
  const endpoint = await connection.serve({ host: '127.0.0.1', port: 0 }, faker)
  const get = async (path: string, init?: RequestInit): Promise<{ status: number; body: Json; notice: string | null }> => {
    const url = path.startsWith('http') ? path : path.startsWith('/v1/') ? `${new URL(endpoint.address).origin}${path}` : `${endpoint.address}${path}`
    const response = await fetch(url, init)
    const text = await response.text()
    const body = text ? JSON.parse(text) : null
    seen.push(body)
    return { status: response.status, body, notice: response.headers.get('sosie-notice') }
  }
  return {
    address: endpoint.address,
    connection,
    rules: loaded,
    /** The store's domain names, which `sosie scan` prints: no real value may be among them. */
    domains: () =>
      (new DatabaseSync(join(storeDir(home), 'store.db'), { readOnly: true }).prepare('SELECT DISTINCT domain FROM value').all() as { domain: string }[]).map(
        (r) => r.domain,
      ),
    /** How many values a domain holds, and how many of them `sosie scan` looks for. */
    scanned: (domain: string) =>
      new DatabaseSync(join(storeDir(home), 'store.db'), { readOnly: true })
        .prepare('SELECT COUNT(*) AS held, COALESCE(SUM(scannable), 0) AS looked FROM value WHERE domain = ?')
        .get(domain) as { held: number; looked: number },
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
    expect(Object.keys(body.data[0])).toEqual(['id', 'email', 'name', 'phone', 'role', 'active', 'address', 'apiKey'])
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

  it('fakes every value a link carries: path words, query names and values; and drops its fragment', async () => {
    const { body } = await sosie.get('/links')
    expect(canariesIn(JSON.stringify(body))).toEqual([])
    expect(body.login).toMatch(new RegExp(`^${sosie.address}/users/[^/]+$`))
    expect(body.next).toMatch(new RegExp(`^${sosie.address}/users\\?after=[^&#]+&phone=[^&#]+$`))
    expect(body.relative).toMatch(/^\/v1\/users\/[^/?]+\?page=2$/)
    // Text that starts with a link is text; a link Sosie cannot read is faked like any value.
    expect(body.note).not.toMatch(/^http/)
    expect(body.broken).not.toContain('localhost')
    const [quill] = (await sosie.get('/users')).body.data
    // Each link leads back to the record it names, through Sosie.
    expect((await sosie.get(body.login)).body).toEqual(quill)
    expect((await sosie.get(body.relative)).body).toEqual(quill)
    expect((await sosie.get(body.profile)).body.email).toBe(quill.email)
    const repos = (await sosie.get(body.repos)).body
    expect(repos).toHaveLength(1)
    expect(api.requests.at(-1)!.path).toBe('/v1/users/Vantablack/repos')
    await sosie.get(body.search)
    expect(api.requests.at(-1)!.path).toBe('/v1/search?q%5BQuillon%5D=1&Vantablack=1')
    await sosie.get(body.next)
    expect(api.requests.at(-1)!.path).toBe('/v1/users?after=7739182046&phone=7739182046')
    // A long number under a paging name may be an id: it is faked; a page's number stays.
    expect(body.paging).toMatch(/[?&]page=2$/)
    await sosie.get(body.paging)
    expect(api.requests.at(-1)!.path).toBe('/v1/users?start=7739182046&count=7739182046&offset=7739182046&page=2')
    // A word of a path the client has not seen names no entity, so no domain holds it.
    await sosie.get(body.nested)
    expect(api.requests.at(-1)!.path).toBe('/v1/quillon/repos')
    expect(canariesIn(JSON.stringify(sosie.domains()))).toEqual([])
    // The API's words are faked, but they are its structure: `sosie scan` does not look for them in transcripts.
    for (const words of ['$path', '$query']) expect(sosie.scanned(words), words).toMatchObject({ held: expect.any(Number), looked: 0 })
    expect(sosie.scanned('$path').held).toBeGreaterThan(0)
  })

  it('names no entity after a word a client typed that is no name, so no domain holds it', async () => {
    for (const path of ['/Vantablack', '/quill.vantablack@canary-mail.test/settings']) expect((await sosie.get(path)).status).toBe(404)
    expect(sosie.domains().join(' ')).not.toMatch(/vantablack/i)
  })

  it('shows a word a client typed in the links of its own answer only', async () => {
    const own = (await sosie.get('/acme-industries/profile')).body
    expect(own.self.startsWith(`${sosie.address}/acme-industries/`)).toBe(true)
    const { body } = await sosie.get('/links')
    expect(body.tenant).not.toContain('acme-industries')
    expect(body.odd).toMatch(new RegExp(`^${sosie.address}/users\\?[^=]+=\\d+$`))
    expect(body.odd).not.toContain('quillon')
  })

  it('never shows a tenant’s slug that looks like a collection’s name to another request', async () => {
    const fresh = await startRest(api)
    // The app, with the real slug from its settings.
    expect((await fresh.get('/jones/profile')).status).toBe(200)
    const before = (await fresh.get('/links')).body
    expect(before.surname).not.toContain('jones')
    expect(before.member).not.toMatch(/\/orders$/)
    // A collection's name the API answered with a list is shown in any link.
    await fresh.get('/users')
    await fresh.get('/orders')
    expect((await fresh.get('/links')).body.member).toMatch(new RegExp(`^${fresh.address}/users/\\d+/orders$`))
    expect((await fresh.get('/links')).body.surname).not.toContain('jones')
    await fresh.close()
  })

  it('sends a value compared with a field that passes as written, so no other field’s real value comes back in it', async () => {
    const lenient = await startRest(api, { rules: 'pass:\n  - report.country\n  - report.note\n' })
    const [quill] = (await lenient.get('/users')).body.data
    const { body } = await lenient.get(`/reports?country=${encodeURIComponent(quill.email)}`)
    expect(api.requests.at(-1)!.path).toBe(`/v1/reports?${new URLSearchParams({ country: quill.email })}`)
    expect(body.country).toBe(quill.email)
    // Text under a name that passes nowhere is looked up anywhere; a field that passes and echoes it shows the fake sent.
    const echo = (await lenient.get(`/reports?q=${encodeURIComponent(quill.email)}`)).body
    expect(api.requests.at(-1)!.path).toBe('/v1/reports?q=quill.vantablack%40canary-mail.test')
    expect(echo.note).toBe(`Results for ${quill.email}`)
    await lenient.close()
  })

  it('reads an answer the API redirected by where it ended, so another kind’s rule does not apply', async () => {
    const lenient = await startRest(api, { rules: 'pass:\n  - product.*\n' })
    const { body } = await lenient.get('/products/featured')
    expect(api.requests.at(-1)!.path).toBe('/v1/users/1')
    expect(body.email).toMatch(/@example\.(com|net|org)$/)
    await lenient.close()
  })

  it('fakes a key that echoes a value it turned back, however it looks', async () => {
    const [{ handle }] = (await sosie.get('/handles')).body
    const { body } = await sosie.get(`/echo?handle=${handle}`)
    expect(api.requests.at(-1)!.path).toBe('/v1/echo?handle=quillon')
    expect(Object.keys(body.byHandle)).toHaveLength(1)
    expect(Object.keys(body.byHandle)[0]).not.toBe('quillon')
    expect(body.link).not.toContain('quillon')
  })

  it('fakes a key that holds a value it turned back, within other words too', async () => {
    const [{ handle }] = (await sosie.get('/handles')).body
    const { body } = await sosie.get(`/echo-within?handle=${handle}`)
    expect(api.requests.at(-1)!.path).toBe('/v1/echo-within?handle=quillon')
    expect(Object.keys(body)).toHaveLength(3)
    expect(Object.keys(body).join(' ')).not.toMatch(/quillon/i)
  })

  it('fakes again in a link the real value it turned a fake into', async () => {
    const [quill] = (await sosie.get('/users')).body.data
    const { body } = await sosie.get(`/users?phone=${quill.phone}`)
    expect(api.requests.at(-1)!.path).toBe('/v1/users?phone=7739182046')
    expect(body.data).toEqual([quill])
    expect(body.next).toBe(`${sosie.address}/users?phone=${quill.phone}&page=2`)
  })

  it('finds records by a boolean it showed, flipped back', async () => {
    // A field's booleans flip or not by the store's key: find a store where they flip.
    for (let tries = 0; tries < 12; tries++) {
      const s = await startRest(api)
      const [quill] = (await s.get('/users')).body.data
      if (quill.active === true) {
        await s.close()
        continue
      }
      const shown = (await s.get('/users?active=false')).body.data
      expect(api.requests.at(-1)!.path).toBe('/v1/users?active=true')
      expect(shown).toContainEqual(quill)
      await s.close()
      return
    }
    throw new Error('No store flipped user.active in 12 tries.')
  })

  it('reads a number in a path as the id of what it follows, never as another entity’s fake', async () => {
    const fresh = await startRest(api)
    // Nine ids of /big fake to the digits 1 to 9: 1 is the fake of one of them, and of no user's id.
    await fresh.get('/big?n=9')
    await fresh.get('/users/1')
    expect(api.requests.at(-1)!.path).toBe('/v1/users/1')
    await fresh.close()
  })

  it('cuts a list at --max-rows, and says so', async () => {
    const small = await startRest(api, { maxRows: 2 })
    const { body, notice } = await small.get('/users')
    expect(body.data).toHaveLength(2)
    expect(notice).toBe('Sosie returned the first 2 items of a list; the rest were cut. Narrow the request, or start Sosie with a higher --max-rows.')
    expect((await small.get('/users/1')).notice).toBeNull()
    await small.close()
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
    expect(post).toMatchObject({ status: 405, body: { error: 'Sosie is read-only: only GET and HEAD reach the API.' } })
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
    const refused = await without.get('/users')
    expect(refused.status).toBe(401)
    expect(Object.keys(refused.body)).toEqual(['error'])
    expect(refused.body.error).not.toBe('unauthorized')
    await without.close()
  })

  it('sends a query the upstream URL carries with every request, and never shows it', async () => {
    const keyed = await startRest(api, { query: '?api_key=k-live-8842' })
    const { body } = await keyed.get('/users')
    expect(api.requests.at(-1)!.path).toBe('/v1/users?api_key=k-live-8842')
    expect(body.next).toBe(`${keyed.address}/users?page=2`)
    expect(keyed.address).not.toContain('k-live')
    // Nor in the terminal: a redirect with a user and password in it is refused, and why is said without the query.
    const said: string[] = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((line: string) => said.push(String(line)) > 0) as typeof process.stderr.write
    try {
      expect((await keyed.get('/userinfo')).status).toBe(502)
    } finally {
      process.stderr.write = write
    }
    expect(said.join('')).toMatch(/Cannot read the API: The API redirected to an address with a user name in it/)
    expect(said.join('')).not.toMatch(/k-live|pass@/)
    await keyed.close()
  })

  it('keeps an id beyond 2^53 exact, so its fake leads back to its record', async () => {
    const text = await (await fetch(`${sosie.address}/big-ids`)).text()
    expect(text).not.toMatch(/1234567890123456789|Vantablack/)
    const id = /"id":\s*(\d+)/.exec(text)![1]!
    const one = await fetch(`${sosie.address}/big-ids/${id}`)
    expect(api.requests.at(-1)!.path).toBe('/v1/big-ids/1234567890123456789')
    expect(one.status).toBe(200)
    expect(await one.text()).toMatch(new RegExp(`"id":\\s*${id}\\b`))
    // So does the MCP tool's answer.
    const running: Running = { kind: 'rest', address: sosie.address, schema: { entities: [] }, passing: [] }
    const result = await rest.tools![0]!.run({ path: `/big-ids/${id}` }, running)
    expect(JSON.stringify(result)).toMatch(new RegExp(`"id":${id}\\b`))
  })

  it('fakes a key that holds its own credentials, even one that looks like a word', async () => {
    const s = await startRest(api, { query: '?api_key=opensesame', env: { SOSIE_UPSTREAM_HEADERS: `Authorization: Bearer ${TOKEN}\nX-Lower: sesamesecretword` } })
    const { body } = await s.get('/echo-credentials')
    expect(api.requests.at(-1)!.path).toBe('/v1/echo-credentials?api_key=opensesame')
    expect(Object.keys(body)).toHaveLength(3)
    expect(body.theme).toBeDefined()
    expect(JSON.stringify(body)).not.toMatch(/sesamesecretword|opensesame/)
    await s.close()
  })

  it('never follows a redirect to another origin: the credentials stay with the API', async () => {
    const recorder = await startRecorder()
    const redirecting = await startApi({ elsewhere: recorder.url })
    const s = await startRest(redirecting)
    expect((await s.get('/elsewhere')).status).toBe(502)
    expect((await s.get('/elsewhere-relative')).status).toBe(502)
    expect(recorder.requests).toEqual([])
    // Nor to the API's origin outside its base path, where a client's own request gets 404.
    expect((await s.get('/out-of-base')).status).toBe(502)
    expect(redirecting.requests.map((r) => r.path)).not.toContain('/admin/secret')
    // Nor by a segment that leaves it at an API that decodes %2F.
    expect((await s.get('/sneaky')).status).toBe(502)
    expect(redirecting.requests.map((r) => r.path)).not.toContain('/v1/..%2F..%2Fadmin%2Fsecret')
    // Within the API's origin, Sosie follows it.
    expect((await s.get('/moved')).body.email).toMatch(/@example\.(com|net|org)$/)
    await s.close()
    await redirecting.close()
    await recorder.close()
  })

  it('answers requests for localhost only, so a web page cannot rebind its name to Sosie', async () => {
    const { port } = new URL(sosie.address)
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        httpRequest({ host: '127.0.0.1', port, path: '/v1/users', headers: { host } }, (res) => {
          res.resume()
          resolve(res.statusCode!)
        })
          .on('error', reject)
          .end()
      })
    expect(await status('attacker.example')).toBe(403)
    expect(await status(`localhost:${port}`)).toBe(200)
    expect(await status(`127.0.0.1:${port}`)).toBe(200)
  })

  it('answers no page of another site, so a web page cannot make it send a request', async () => {
    const { port } = new URL(sosie.address)
    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        httpRequest({ host: '127.0.0.1', port, path: '/v1/users', headers: { host: `localhost:${port}`, ...headers } }, (res) => {
          res.resume()
          resolve(res.statusCode!)
        })
          .on('error', reject)
          .end()
      })
    const before = api.requests.length
    expect(await status({ origin: 'https://attacker.example' })).toBe(403)
    expect(await status({ origin: 'null' })).toBe(403)
    expect(await status({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' })).toBe(403)
    expect(api.requests.length).toBe(before)
    // A page of this machine, an app on another port, may.
    expect(await status({ origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'cross-site' })).toBe(200)
    expect(await status({ origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site' })).toBe(200)
  })

  it('refuses a path it cannot decode, instead of failing', async () => {
    expect(await sosie.get('/users/%zz')).toMatchObject({ status: 400, body: { error: 'The path has a % that does not start an escape (%20).' } })
  })

  it('refuses a segment the API could read as another path: an escaped / or \\, or . or ..', async () => {
    const before = api.requests.length
    // At an API, or a proxy before it, that decodes %2F and resolves .., these leave the base or name another kind.
    for (const path of ['/x%2F..%2F..%2Fadmin%2Fsecret', '/countries/x%2Fusers%2F1', '/users/..%5C..%5Cadmin', '/users/%2E%2E%2F']) {
      expect(await sosie.get(path), path).toMatchObject({ status: 400, body: { error: expect.stringMatching(/another path/) } })
    }
    expect(api.requests.slice(before)).toEqual([])
    // Nor does a value the API holds go in one segment when it is a path itself.
    const [note] = (await sosie.get('/notes')).body
    // The fake is one segment; only the value it stands for is not.
    expect(note.login).not.toMatch(/admin|[/\\]/)
    const asked = api.requests.length
    expect(await sosie.get(`/notes/${encodeURIComponent(note.login)}`)).toMatchObject({ status: 400, body: { error: expect.stringMatching(/another path/) } })
    expect(api.requests.slice(asked)).toEqual([])
  })

  it('applies no field’s rule to an error’s body, whatever keys it shares with the record', async () => {
    const lenient = await startRest(api, { rules: 'pass:\n  - country.*\n' })
    const { status, body } = await lenient.get('/countries/missing')
    expect(status).toBe(404)
    expect(Object.keys(body)).toEqual(['name', 'error'])
    expect(JSON.stringify(body)).not.toMatch(/Quillon|Vantablack|no such country/)
    await lenient.close()
  })

  it('fakes error bodies, and does not pass on what it cannot fake', async () => {
    const missing = await sosie.get('/missing')
    expect(missing.status).toBe(404)
    expect(missing.body.error).not.toMatch(/canary/)
    const notJson = { status: 502, body: { error: 'The API did not answer with JSON; Sosie fakes JSON only, so it does not pass it on.' } }
    expect(await sosie.get('/avatar')).toMatchObject(notJson)
    // The API's content type is its own text, and is not shown either.
    expect(await sosie.get('/odd-type')).toMatchObject(notJson)
  })
})

describe('an API with an OpenAPI document', () => {
  it('finds the document, and fakes each value by its schema', async () => {
    const documented = await startApi({ withOpenapi: true })
    const s = await startRest(documented)
    expect(s.connection.summary).toBe('OpenAPI 3.1, 3 schemas, 4 GET paths')
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

  it('fakes every key of a map the document declares, lowercase words too', async () => {
    const documented = await startApi({ withOpenapi: true })
    const s = await startRest(documented)
    const { body } = await s.get('/members')
    expect(Object.keys(body)).toHaveLength(2)
    expect(Object.keys(body)).not.toContain('quillon')
    await s.close()
    await documented.close()
  })

  it('finds records by an enum label or a boolean it showed, by the document', async () => {
    const documented = await startApi({ withOpenapi: true })
    const s = await startRest(documented)
    const users = (await s.get('/users')).body.data
    for (const user of users) {
      expect((await s.get(`/users?role=${user.role}`)).body.data).toEqual([user])
      expect((await s.get(`/users?active=${user.active}`)).body.data).toContainEqual(user)
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

  it('follows a link Sosie returned', async () => {
    const running: Running = { kind: 'rest', address: sosie.address, schema: { entities: [] }, passing: [] }
    const { href } = (await sosie.get('/self')).body
    expect(href.startsWith(`${new URL(sosie.address).origin}/v1/`)).toBe(true)
    const result = (await rest.tools![0]!.run({ path: href }, running)) as Json
    expect(result.status).toBe(200)
    expect(api.requests.at(-1)!.path).toBe('/v1/users/1')
    seen.push(result)
    await expect(rest.tools![0]!.run({ path: 'http://attacker.example/v1/users' }, running)).rejects.toThrow('The path must be a path of the API')
  })

  it('reaches Sosie only, whatever the path says', async () => {
    const root = await startApi()
    const running: Running = { kind: 'rest', address: `http://localhost:${new URL(sosie.address).port}`, schema: { entities: [] }, passing: [] }
    const before = root.requests.length
    for (const path of [`//${new URL(root.url).host}/v1/users`, `/\\${new URL(root.url).host}/v1/users`]) {
      await expect(rest.tools![0]!.run({ path }, running)).rejects.toThrow('The path must be a path of the API, such as /users?limit=10.')
    }
    expect(root.requests.length).toBe(before)
    await root.close()
  })
})
