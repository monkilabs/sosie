import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { createFaker, loadRules, normalize, Store, storeDir, type Running, type Schema } from '@sosie/core'
import { rest } from '@sosie/rest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openapi, startApi, startRecorder, TOKEN, type FakeApi } from './api.js'
import { canariesIn } from './canaries.js'
import { startSosie } from './sosie.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies. */
type Json = any

/** Everything Sosie returned in this file, searched for canaries at the end. */
const seen: unknown[] = []

async function startRest(
  api: FakeApi,
  {
    home = mkdtempSync(join(tmpdir(), 'sosie-rest-')),
    rules = '',
    headers = { Authorization: `Bearer ${TOKEN}` } as Record<string, string>,
    maxRows = 1000,
    query = '',
    userinfo = '',
    learned = undefined as ((schema: Schema) => void) | undefined,
    schema = undefined as string | undefined,
    refuse = undefined as string[] | undefined,
    unauthorized = undefined as (() => void) | undefined,
  } = {},
) {
  const connection = await rest.connect(new URL(`${api.url.replace('//', `//${userinfo}`)}${query}`), {
    maxRows,
    statementTimeout: 5000,
    headers,
    ...(schema && { schema }),
    ...(refuse && { refuse }),
    ...(unauthorized && { unauthorized }),
  })
  // The same key on every run, so the same fakes. With a key of its own each run, a value's fake could by chance be
  // one of the API's own words: a single word is faked as a word, and a value Sosie gave, typed where a path starts
  // (/deep), is read as that value, as a client that saw it would mean. A store that has a key keeps it.
  const dir = storeDir(home)
  if (!existsSync(join(dir, 'key'))) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'key'), createHash('sha256').update('sosie: the REST end-to-end tests').digest(), { mode: 0o600 })
  }
  const store = Store.open(dir)
  const loaded = loadRules(rules, connection.schema, 'sosie.yml', { learns: !!connection.learns })
  const faker = createFaker({ schema: connection.schema, rules: loaded, store })
  const endpoint = await connection.serve({ host: '127.0.0.1', port: 0 }, faker, learned)
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
    /** The domain whose real value `sosie scan` would report for this text; undefined when it looks for none. */
    finds: (text: string) => store.scanIndex().find(normalize(text)),
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
    // Nor for one that follows a word that names no entity (/quillon/repos): it is a word, not that word's id.
    for (const word of ['repos', 'profile']) expect(sosie.finds(word), word).toBeUndefined()
  })

  it('tells describe the fields it has met, under the collections the API answered with a list only', async () => {
    const schemas: Schema[] = []
    const fresh = await startRest(api, { learned: (schema) => schemas.push(structuredClone(schema)) })
    await fresh.get('/users')
    const [first] = schemas
    expect(first!.entities.map((e) => e.id)).toEqual(['user'])
    expect(first!.entities[0]!.fields.map((f) => f.id)).toEqual(
      expect.arrayContaining(['user.id', 'user.email', 'user.name', 'user.active', 'user.address.city']),
    )
    expect(first!.entities[0]!.fields.find((f) => f.id === 'user.id')).toMatchObject({ key: 'primary', type: { kind: 'integer' } })
    // Nothing new met, nothing told.
    await fresh.get('/users')
    expect(schemas).toHaveLength(1)
    // A tenant's slug (/jones/profile) names an entity, and a map is keyed by people's names (/members): neither is a
    // collection the API answered with a list, so describe is told of neither.
    await fresh.get('/jones/profile')
    // Fetched past `seen`: without a document, a map's lowercase keys stay in the body, a limit of their own.
    await (await fetch(`${fresh.address}/members`)).text()
    expect(JSON.stringify(schemas)).not.toMatch(/jone|member|quillon|zephyrine/i)
    expect(canariesIn(JSON.stringify(schemas))).toEqual([])
    await fresh.close()
    // With a document, the document is the schema: nothing is learned.
    const documented = await startApi({ withOpenapi: true })
    const told: Schema[] = []
    const withDoc = await startRest(documented, { learned: (schema) => told.push(schema) })
    await withDoc.get('/users')
    expect(told).toEqual([])
    await withDoc.close()
    await documented.close()
  })

  it('follows a link back to the query names the API wrote, a word Sosie faked into another word included', async () => {
    // A Sosie of its own: one that has seen jdoe as a key shows it as it is.
    const fresh = await startRest(api)
    const { body } = await fresh.get('/country-links')
    expect(new URL(body.next).searchParams.has('jdoe')).toBe(false)
    await fresh.get(body.next)
    expect(api.requests.at(-1)!.path).toBe('/v1/countries?Quillon=Vantablack&jdoe=quill.vantablack%40canary-mail.test&q%5BZephyrine%5D=Orrowmoor')
    // A name the client wrote that Sosie never gave stays as written.
    await fresh.get('/countries?color=red')
    expect(api.requests.at(-1)!.path).toBe('/v1/countries?color=red')
    await fresh.close()
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

  it('learns a collection named in kebab case, as one in snake case, and shows it in links', async () => {
    const fresh = await startRest(api)
    expect((await fresh.get('/item-links')).body.items).not.toMatch(/\/line-items$/)
    await fresh.get('/users')
    await fresh.get('/line-items')
    expect((await fresh.get('/item-links')).body.items).toMatch(new RegExp(`^${fresh.address}/users/\\d+/line-items$`))
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

  it('cuts a list at max-rows, and says so', async () => {
    const small = await startRest(api, { maxRows: 2 })
    const { body, notice } = await small.get('/users')
    expect(body.data).toHaveLength(2)
    expect(notice).toBe('Sosie returned the first 2 items of a list; the rest were cut. Narrow the request, or raise max-rows in sosie.yml.')
    expect((await small.get('/users/1')).notice).toBeNull()
    await small.close()
  })

  it('applies sosie.yml to fields not met yet, and warns that they are', async () => {
    const lenient = await startRest(api, { rules: 'pass:\n  - order.status\n' })
    expect(lenient.rules.warnings).toEqual(['sosie.yml: order is not known yet: it applies once Sosie meets it.'])
    const orders = (await lenient.get('/orders')).body
    expect(orders.map((o: Json) => o.status)).toEqual(['paid', 'new', 'shipped'])
    await lenient.close()
  })
})

describe('the guard and the credentials', () => {
  it('never sends a path sosie.yml refuses, however it is written, nor follows a redirect to one', async () => {
    const strict = await startRest(api, { refuse: ['/users/*', '/countries', '/v1/members'] })
    expect(strict.connection.summary).toBe('no OpenAPI document; refuses 3 paths')
    const [user] = (await strict.get('/users')).body.data
    const sent = api.requests.length
    const refused = 'The source refuses this path: Sosie does not send it to the API.'
    // A fake id turns back into the real path, which is refused; so is a path written another way, and one under it.
    for (const path of [`/users/${user.id}`, '/users/1', '/COUNTRIES', '/countries;v=2', '/%2563ountries', '/countries/', '/countries/1', '/v1/members']) {
      expect(await strict.get(path), path).toMatchObject({ status: 403, body: { error: refused } })
    }
    expect((await strict.get('/countries', { method: 'HEAD' })).status).toBe(403)
    // A redirect to a refused path is not followed: the path asked for was sent, the one it led to was not.
    expect(await strict.get('/products/featured')).toMatchObject({
      status: 403,
      body: { error: 'The API redirected to a path the source refuses; Sosie does not follow it.' },
    })
    expect(api.requests.slice(sent).map((r) => r.path)).toEqual(['/v1/products/featured'])
    // A path that only starts like one refused is sent.
    expect((await strict.get('/country-links')).status).toBe(200)
    await strict.close()
  })

  it('tells of a 401 once, until the API answers 2xx or the headers are renewed, and sends renewed headers from then on', async () => {
    let told = 0
    const s = await startRest(api, { unauthorized: () => told++ })
    expect((await s.get('/users')).status).toBe(200)
    // The token expires: the first 401 is told, the next not, as the developer is asked once.
    s.connection.renew!({ Authorization: 'Bearer expired-token-1' })
    for (let i = 0; i < 2; i++) expect((await s.get('/users')).status).toBe(401)
    expect(told).toBe(1)
    expect(api.requests.at(-1)!.authorization).toBe('Bearer expired-token-1')
    s.connection.renew!({ Authorization: `Bearer ${TOKEN}` })
    expect((await s.get('/users')).status).toBe(200)
    expect(api.requests.at(-1)!.authorization).toBe(`Bearer ${TOKEN}`)
    // Renewed with a value that is wrong too: its 401 is told again.
    s.connection.renew!({ Authorization: 'Bearer expired-token-2' })
    expect((await s.get('/users')).status).toBe(401)
    expect(told).toBe(2)
    expect(() => s.connection.renew!({ Authorization: 'Bearer a\nb' })).toThrow('The header Authorization is not a valid one')
    expect(api.requests.at(-1)!.authorization).toBe('Bearer expired-token-2')
    await s.close()
  })

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
    const without = await startRest(api, { headers: {} })
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
    const running: Running = { name: 'api', kind: 'rest', address: sosie.address, schema: { entities: [] }, passing: [] }
    const result = await rest.tools![0]!.run({ path: `/big-ids/${id}` }, running)
    expect(JSON.stringify(result)).toMatch(new RegExp(`"id":${id}\\b`))
  })

  it('fakes a key, or a value that passes, that holds its own credentials, even one that looks like a word', async () => {
    const s = await startRest(api, {
      query: '?api_key=opensesame',
      userinfo: 'robot:sunshine99@',
      rules: 'pass:\n  - echo-credential.note\n',
      // A Rails-style header writes its token in quotes; a header that is no credential (X-Tenant) holds none.
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Api-Key': 'Token token="sesamesecretword"', 'X-Tenant': 'production' },
    })
    const { body } = await s.get('/echo-credentials')
    expect(api.requests.at(-1)!.path).toBe('/v1/echo-credentials?api_key=opensesame')
    expect(Object.keys(body)).toHaveLength(6)
    expect(body.theme).toBeDefined()
    expect(body.production).toBeDefined()
    expect(JSON.stringify(body)).not.toMatch(/sesamesecretword|opensesame|sunshine99/)
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

  it('sends a page’s number as written, even where a body showed a page of its own', async () => {
    const own = await startRest(api)
    // A page number the body showed is a fake of the body's page: sent back, it is still the page asked for.
    const first = (await (await fetch(`${own.address}/pages`)).json()) as { page: number }
    await fetch(`${own.address}/pages?page=${first.page}`)
    expect(api.requests.at(-1)!.path).toBe(`/v1/pages?page=${first.page}`)
    await own.close()
  })

  it('never shows in a link a paging value the request turned back', async () => {
    const own = await startRest(api)
    // A fake under a paging name turns back, so the API gets the real 48213; the link it answers with shows a fake.
    const { data: [member] } = (await (await fetch(`${own.address}/logins`)).json()) as { data: { username: string }[] }
    expect(member!.username).not.toBe('48213')
    const body = (await (await fetch(`${own.address}/users?limit=${encodeURIComponent(member!.username)}`)).json()) as { next: string }
    expect(api.requests.at(-1)!.path).toContain('limit=48213')
    expect(body.next).not.toContain('48213')
    await own.close()
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
    for (const path of [
      '/x%2F..%2F..%2Fadmin%2Fsecret',
      '/countries/x%2Fusers%2F1',
      '/users/..%5C..%5Cadmin',
      '/users/%2E%2E%2F',
      // A NUL; Tomcat's ..; for ..; and a .. or a / that a second decoding makes.
      '/users/1%00',
      '/users/..;/admin',
      '/users/%252e%252e',
      '/users/x%252Fadmin',
    ]) {
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

  it('shows the fake the client sent in a link’s field that passes, never the value it turned back', async () => {
    const lenient = await startRest(api, { rules: 'pass:\n  - user.id\n  - country.*\n' })
    const [quill] = (await lenient.get('/users')).body.data
    const { body } = await lenient.get(`/lookup?email=${encodeURIComponent(quill.email)}`)
    expect(api.requests.at(-1)!.path).toBe('/v1/lookup?email=quill.vantablack%40canary-mail.test')
    expect(body.self).toBe(`${lenient.address}/users/${encodeURIComponent(quill.email)}`)
    expect(body.list).toBe(`${lenient.address}/users?id=${encodeURIComponent(quill.email)}`)
    // A reference guessed from a name (countryId) never passes because what it names does, in a link as in a body.
    expect(body.near).not.toMatch(/Vantablack/)
    await lenient.close()
  })

  it('passes no hidden query name’s value under a wildcard rule', async () => {
    const lenient = await startRest(api, { rules: 'pass:\n  - country.*\n' })
    expect((await lenient.get('/countries')).body).toEqual([{ id: 1, name: 'Iceland' }])
    const { body } = await lenient.get('/country-links')
    expect(body.next).toMatch(new RegExp(`^${lenient.address}/countries\\?`))
    expect(decodeURIComponent(body.next)).not.toMatch(/quillon|vantablack|zephyrine|orrowmoor/i)
    await lenient.close()
  })

  it('keeps a key __proto__ as the API’s data, not the object’s prototype', async () => {
    expect(Object.keys((await sosie.get('/proto')).body)).toEqual(['__proto__', 'constructor', 'x'])
  })

  it('applies no entity’s rule to an answer a word in a value’s place may have made another kind’s', async () => {
    // Without a document: /products/reviews reads as a product by REST's habit, but holds reviews.
    const lenient = await startRest(api, { rules: 'pass:\n  - product.*\n' })
    expect((await lenient.get('/products')).body).toEqual([{ id: 1, name: 'Plain Widget' }])
    const reviews = await lenient.get('/products/reviews')
    expect(reviews.status).toBe(200)
    expect(canariesIn(JSON.stringify(reviews.body))).toEqual([])
    await lenient.close()
    // With one: /users/reviews matches /users/{id}, but holds reviews, and not a User's shape either.
    const documented = await startApi({ withOpenapi: true })
    const s = await startRest(documented, { rules: 'pass:\n  - User.name\n  - User.email\n' })
    const listed = await s.get('/users/reviews')
    expect(listed.status).toBe(200)
    expect(canariesIn(JSON.stringify(listed.body))).toEqual([])
    await s.close()
    await documented.close()
  })

  it('applies no rule of the kind a name under a record names, unless the API answers it with a list of that kind', async () => {
    const lenient = await startRest(api, { rules: 'pass:\n  - country.*\n  - order.status\n' })
    expect((await lenient.get('/countries')).status).toBe(200)
    const [quill] = (await lenient.get('/users')).body.data
    // An API that routes by prefix answers these with the user: the user is no country.
    for (const name of ['countries', 'country']) {
      const { status, body } = await lenient.get(`/users/${quill.id}/${name}`)
      expect(status, name).toBe(200)
      expect(canariesIn(JSON.stringify(body)), name).toEqual([])
    }
    // A list under a record is that kind's, so its rules apply.
    expect((await lenient.get(`/users/${quill.id}/orders`)).body.map((o: Json) => o.status)).toEqual(['paid', 'new'])
    await lenient.close()
    // With a document, a path it declares no operation for is no entity's.
    const documented = await startApi({ withOpenapi: true })
    const s = await startRest(documented, { rules: 'pass:\n  - Country.*\n' })
    const [user] = (await s.get('/users')).body.data
    const { body } = await s.get(`/users/${user.id}/countries`)
    expect(canariesIn(JSON.stringify(body))).toEqual([])
    expect((await s.get('/countries')).body).toEqual([{ id: 1, name: 'Iceland' }])
    await s.close()
    await documented.close()
  })

  it('sends no method override, which asks a framework to write', async () => {
    const before = api.requests.length
    for (const name of ['_method', '__method', 'method', '_HttpMethod', 'X-HTTP-Method-Override']) {
      expect((await sosie.get(`/users/1?${name}=DELETE`)).status, name).toBe(400)
    }
    // Names and values as frameworks rewrite them: PHP reads .method and " method" as _method, _method[] as _method.
    for (const query of ['.method=DELETE', '%20method=PUT', '_method%5B%5D=DELETE', 'x-http-method-override=%20DELETE']) {
      expect((await sosie.get(`/users/1?${query}`)).status, query).toBe(400)
    }
    expect(api.requests.length).toBe(before)
    // A method that is a value of the API's own (?method=card) goes on.
    expect((await sosie.get('/users/1?method=card')).status).toBe(200)
    // Nor one whose name Sosie faked in a link and the client sent back.
    const { next } = (await sosie.get('/override-link')).body
    const name = new URL(next).searchParams.keys().next().value!
    expect(name).not.toBe('X-HTTP-Method-Override')
    const asked = api.requests.length
    expect((await sosie.get(`/things?${encodeURIComponent(name)}=DELETE`)).status).toBe(400)
    // Nor the link as Sosie gave it: its method, PATCH, is a fake too, and turns back into PATCH.
    expect((await sosie.get(`/things${new URL(next).search}`)).status).toBe(400)
    expect(api.requests.length).toBe(asked)
  })

  it('says so when the API’s JSON is nested too deep to read', async () => {
    expect(await sosie.get('/deep')).toMatchObject({ status: 502, body: { error: 'The API answered with JSON nested too deep for Sosie to read.' } })
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

/**
 * A Spring Boot API as Springdoc documents it, in the file `schema`: its schemas are named for what they answer
 * (UserResp), and each answer's schema is under the content type given.
 */
async function startSpring(type = 'application/json') {
  const user = { id: 42, email: 'quill.vantablack@canary-mail.test', status: 'STATUS_ACTIVE', plan: 'PLAN_TEAM' }
  const orders = [{ id: 7, userId: 42 }]
  const requests: FakeApi['requests'] = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', path: req.url ?? '', authorization: req.headers.authorization })
    const body = req.url === '/api/users/42' ? user : req.url === '/api/users/42/orders' ? orders : undefined
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body ?? { error: 'not found' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const answer = (schema: object) => ({ get: { responses: { '200': { description: 'OK', content: { [type]: { schema } } } } } })
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
  const id = { type: 'integer', format: 'int64' }
  const doc = {
    openapi: '3.0.1',
    paths: { '/api/users/{userId}': answer(ref('UserResp')), '/api/users/{userId}/orders': answer({ type: 'array', items: ref('OrderResp') }) },
    components: {
      schemas: {
        UserResp: {
          type: 'object',
          properties: {
            id,
            email: { type: 'string' },
            status: { type: 'string', enum: ['STATUS_ACTIVE', 'STATUS_BLOCKED', 'STATUS_DELETED'] },
            plan: { type: 'string', enum: ['PLAN_FREE', 'PLAN_TEAM', 'PLAN_ENTERPRISE'] },
          },
        },
        OrderResp: { type: 'object', properties: { id, userId: id } },
      },
    },
  }
  const schema = join(mkdtempSync(join(tmpdir(), 'sosie-spring-')), 'openapi.json')
  writeFileSync(schema, JSON.stringify(doc))
  const api: FakeApi = {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
  return { api, schema }
}

describe('an API with an OpenAPI document', () => {
  it('reads a path’s id as the id its answers show, under a schema named for what it answers (UserResp)', async () => {
    const { api: spring, schema } = await startSpring()
    const s = await startRest(spring, { schema })
    const user = (await s.get('/api/users/42')).body
    expect(user.id).not.toBe(42)
    spring.requests.length = 0
    // The fake id leads back to its record, and to what is under it; a reference by name (userId) is the same fake.
    expect((await s.get(`/api/users/${user.id}`)).body).toEqual(user)
    const orders = (await s.get(`/api/users/${user.id}/orders`)).body
    expect(spring.requests.map((r) => r.path)).toEqual(['/api/users/42', '/api/users/42/orders'])
    expect(orders[0].userId).toBe(user.id)
    await s.close()
    await spring.close()
  })

  it('reads an answer’s schema under */*, as Springdoc writes it: its rules apply, its enums fake as labels', async () => {
    const { api: spring, schema } = await startSpring('*/*')
    const s = await startRest(spring, { schema, rules: 'pass:\n  - UserResp.status\n' })
    const user = (await s.get('/api/users/42')).body
    expect(user.status).toBe('STATUS_ACTIVE')
    expect(['PLAN_FREE', 'PLAN_TEAM', 'PLAN_ENTERPRISE']).toContain(user.plan)
    expect(user.email).not.toBe('quill.vantablack@canary-mail.test')
    // And a fake id still leads back to its record.
    spring.requests.length = 0
    expect((await s.get(`/api/users/${user.id}`)).body).toEqual(user)
    expect(spring.requests.map((r) => r.path)).toEqual(['/api/users/42'])
    await s.close()
    await spring.close()
  })

  it('finds the document, and fakes each value by its schema', async () => {
    const documented = await startApi({ withOpenapi: true })
    const s = await startRest(documented)
    expect(s.connection.summary).toBe('OpenAPI 3.1, 4 schemas, 5 GET paths')
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

  it('reads the document from the schema given: a file, and asks the API for none', async () => {
    const bare = await startApi()
    const file = join(mkdtempSync(join(tmpdir(), 'sosie-openapi-')), 'openapi.json')
    writeFileSync(file, JSON.stringify(openapi))
    const s = await startRest(bare, { schema: file })
    expect(s.connection.summary).toBe('OpenAPI 3.1, 4 schemas, 5 GET paths')
    expect(s.connection.learns).toBe(false)
    expect(bare.requests).toEqual([])
    await s.close()
    await expect(startRest(bare, { schema: join(file, '..', 'none.json') })).rejects.toThrow(/^Cannot read its schema: ENOENT/)
    await bare.close()
  })

  it('reads a schema URL at the API’s own origin with its credentials, and one elsewhere with none', async () => {
    const documented = await startApi({ withOpenapi: true })
    const origin = new URL(documented.url).origin
    const own = await startRest(documented, { schema: `${origin}/v1/openapi.json` })
    expect(own.connection.summary).toBe('OpenAPI 3.1, 4 schemas, 5 GET paths')
    expect(documented.requests).toEqual([{ method: 'GET', path: '/v1/openapi.json', authorization: `Bearer ${TOKEN}` }])
    await own.close()
    await expect(startRest(documented, { schema: `${origin}/v1/nothing.json` })).rejects.toThrow(`Cannot read its schema: ${new URL(origin).host}/v1/nothing.json answered 404.`)

    const asked: (string | undefined)[] = []
    const cdn = createServer((req, res) => {
      asked.push(req.headers.authorization)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(openapi))
    })
    await new Promise<void>((resolve) => cdn.listen(0, '127.0.0.1', resolve))
    const elsewhere = await startRest(documented, { schema: `http://localhost:${(cdn.address() as { port: number }).port}/openapi.json` })
    expect(elsewhere.connection.summary).toBe('OpenAPI 3.1, 4 schemas, 5 GET paths')
    expect(asked).toEqual([undefined])
    await elsewhere.close()
    await new Promise<void>((resolve) => cdn.close(() => resolve()))
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
    const running: Running = { name: 'api', kind: 'rest', address: sosie.address, schema: { entities: [] }, passing: [] }
    const result = (await rest.tools![0]!.run({ path: '/users' }, running)) as Json
    expect(result.status).toBe(200)
    expect(result.body.data).toHaveLength(3)
    seen.push(result)
  })

  it('follows a link Sosie returned', async () => {
    const running: Running = { name: 'api', kind: 'rest', address: sosie.address, schema: { entities: [] }, passing: [] }
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
    const running: Running = { name: 'api', kind: 'rest', address: `http://localhost:${new URL(sosie.address).port}`, schema: { entities: [] }, passing: [] }
    const before = root.requests.length
    for (const path of [`//${new URL(root.url).host}/v1/users`, `/\\${new URL(root.url).host}/v1/users`]) {
      await expect(rest.tools![0]!.run({ path }, running)).rejects.toThrow('The path must be a path of the API, such as /users?limit=10.')
    }
    expect(root.requests.length).toBe(before)
    await root.close()
  })
})
