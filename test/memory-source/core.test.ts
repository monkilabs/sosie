import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFaker, loadRules, Store, storeDir, type Value } from '@sosie/core'
import { describe, expect, it } from 'vitest'
import { CANARIES, data } from './fixtures.js'
import { memorySource, type MemoryEndpoint } from './source.js'

async function serve(rules = '', home = mkdtempSync(join(tmpdir(), 'sosie-core-'))) {
  const connection = await memorySource(data).connect(new URL('memory:app'), { maxRows: 1000, statementTimeout: 30_000 })
  const store = Store.open(storeDir(home))
  const faker = createFaker({ schema: connection.schema, rules: loadRules(rules, connection.schema), store })
  const endpoint = (await connection.serve({ host: '127.0.0.1', port: 0 }, faker)) as MemoryEndpoint
  const all = () => ({ users: endpoint.rows('users'), orders: endpoint.rows('orders'), countries: endpoint.rows('countries') })
  return { home, store, faker, endpoint, all }
}

const realUsers = data.rows.users!
const realOrders = data.rows.orders!

describe('the core, through a source with no database', () => {
  it('lets no canary out', async () => {
    const { all } = await serve()
    const out = JSON.stringify(all()).toLowerCase()
    for (const canary of Object.values(CANARIES)) expect(out).not.toContain(canary.toLowerCase())
    for (const part of ['quillon', 'vantablack', 'vantaville', '9qv7xc2lm8rt', '7739182046']) expect(out).not.toContain(part)
  })

  it('keeps joins: a foreign key fakes like the key it points to', async () => {
    const { all } = await serve()
    const { users, orders } = all()
    for (const [i, order] of realOrders.entries()) {
      const owner = realUsers.findIndex((u) => u.id === order.user_id)
      expect(orders[i]!.user_id).toBe(users[owner]!.id)
    }
  })

  it('gives one person one email everywhere: other columns and json', async () => {
    const { all } = await serve()
    const { users, orders } = all()
    expect(orders[0]!.contact_email).toBe(users[0]!.email)
    expect(orders[1]!.contact_email).toBe(users[0]!.email)
    expect(JSON.parse(users[0]!.profile as string).email).toBe(users[0]!.email)
    expect(users[0]!.email).not.toBe(users[1]!.email)
  })

  it('gives the same fakes in every session, and other fakes with another key', async () => {
    const first = await serve()
    const before = first.all()
    first.store.close()
    const again = await serve('', first.home)
    expect(again.all()).toEqual(before)
    const other = await serve()
    expect(other.all().users[0]!.email).not.toBe(before.users[0]!.email)
  })

  it('finds a row by a fake the client saw', async () => {
    const { endpoint } = await serve()
    const users = endpoint.rows('users')
    expect(endpoint.where('users', 'email', users[1]!.email as string)).toEqual([users[1]])
    expect(endpoint.where('users', 'id', users[2]!.id as string)).toEqual([users[2]])
    expect(endpoint.where('users', 'role', users[0]!.role as string)).toContainEqual(users[0])
    expect(endpoint.where('users', 'active', users[0]!.active as string)).toContainEqual(users[0])
    const orders = endpoint.rows('orders')
    expect(endpoint.where('orders', 'user_id', users[0]!.id as string)).toEqual(orders.slice(0, 2))
  })

  it('passes the fields sosie.yml lists, and the fields that share their values', async () => {
    const { all } = await serve('pass:\n  - countries.*\n')
    const { countries, orders } = all()
    expect(countries).toEqual(data.rows.countries)
    expect(orders.map((o) => o.country)).toEqual(realOrders.map((o) => o.country))
  })

  it('fakes keys within their length, and keeps references to them', async () => {
    const { all } = await serve()
    const { countries, orders } = all()
    for (const c of countries) expect((c.code as string).length).toBeLessThanOrEqual(2)
    expect(orders[0]!.country).toBe(countries[0]!.code)
    expect(orders[2]!.country).toBe(countries[1]!.code)
  })
})

describe('fakes by type', async () => {
  const { all } = await serve()
  const { users, orders } = all()
  const pairs = <K extends string>(key: K) => realUsers.map((real, i) => [real[key], users[i]![key]] as [Value, Value])

  it('integers: the same sign and a similar size, never the real one', () => {
    for (const [real, fake] of pairs('id')) {
      expect(fake).toMatch(/^[1-9]\d*$/)
      expect(fake).not.toBe(real)
    }
    expect(new Set(users.map((u) => u.id)).size).toBe(users.length)
  })

  it('decimals: the same digits and scale', () => {
    for (const [real, fake] of pairs('score')) {
      expect((fake as string).replace(/\d/g, '9')).toBe((real as string).replace(/\d/g, '9'))
      expect(fake).not.toBe(real)
    }
    expect(orders[0]!.total).toMatch(/^[1-9]\d\d\.\d\d$/)
  })

  it('booleans: flipped or not, the same way for the whole field', () => {
    const flipped = pairs('active').map(([real, fake]) => real !== fake)
    expect(new Set(flipped).size).toBe(1)
    for (const u of users) expect(['t', 'f']).toContain(u.active)
  })

  it('booleans: text that is not a boolean is shaped, never passed', async () => {
    const { faker } = await serve()
    const active = data.schema.entities[0]!.fields.find((f) => f.name === 'active')!
    expect(faker.value('quill.vantablack@canary-mail.test', active)).not.toBe('quill.vantablack@canary-mail.test')
  })

  it('enums: another label of the same enum, one for one', () => {
    const map = new Map(pairs('role'))
    expect(new Set(map.values()).size).toBe(map.size)
    for (const fake of map.values()) expect(['admin', 'editor', 'viewer']).toContain(fake)
  })

  it('datetimes, dates and times: shifted by up to a year, in the same format', () => {
    for (const [real, fake] of pairs('created_at')) {
      expect(fake).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.589\+01$/)
      const days = Math.abs(Date.parse((fake as string).replace(' ', 'T') + ':00') - Date.parse((real as string).replace(' ', 'T') + ':00')) / 86_400_000
      expect(days).toBeGreaterThan(0)
      expect(days).toBeLessThanOrEqual(367)
    }
    for (const [, fake] of pairs('born_on')) expect(fake).toMatch(/^\d{4}-\d\d-\d\d$/)
    for (const [, fake] of pairs('wakes_at')) expect(fake).toMatch(/^\d\d:\d\d:\d\d$/)
  })

  it('json: the same structure, every leaf faked', () => {
    for (const [real, fake] of pairs('profile')) {
      const r = JSON.parse(real as string)
      const f = JSON.parse(fake as string)
      expect(Object.keys(f)).toEqual(Object.keys(r))
      expect(Object.keys(f.address)).toEqual(['city'])
      expect(f.address.city).not.toBe('Brno')
      expect(typeof f.visits).toBe('number')
      expect(typeof f.vip).toBe('boolean')
      expect(f.nickname).not.toBe(r.nickname)
    }
  })

  it('json keys: structure kept, values that are keys faked', async () => {
    const { faker } = await serve()
    const built = JSON.parse(
      faker.computed(JSON.stringify({ 'quill.vantablack@canary-mail.test': 1, 'Quillon Vantablack': { city: 'Vantaville' }, total: 3 }), {
        kind: 'json',
      }) as string,
    )
    const keys = Object.keys(built)
    expect(keys[2]).toBe('total')
    expect(keys[0]).toMatch(/@example\.(com|net|org)$/)
    expect(JSON.stringify(built).toLowerCase()).not.toMatch(/quill|vanta/)
    expect(Object.keys(built[keys[1]!])).toEqual(['city'])
  })

  it('json keys in a column: words stay, names and value-like keys are faked', async () => {
    const { faker } = await serve()
    const profile = data.schema.entities[0]!.fields.find((f) => f.name === 'profile')!
    const out = JSON.parse(
      faker.value(JSON.stringify({ Quillon: 1, sk_live_9Qv7Xc2Lm8Rt: 2, createdAt: 3, address_line1: 4 }), profile) as string,
    )
    const keys = Object.keys(out)
    expect(keys.slice(2)).toEqual(['createdAt', 'address_line1'])
    expect(JSON.stringify(keys).toLowerCase()).not.toMatch(/quillon|sk_live/)
  })

  it('json keys a query builds: names in the schema and keys the client wrote stay', async () => {
    const { faker } = await serve()
    const sent = "SELECT jsonb_build_object('label', city, 'email', email) FROM users"
    const out = JSON.parse(faker.computed(JSON.stringify({ label: 1, email: 2, vantaville: 3 }), { kind: 'json' }, sent) as string)
    expect(Object.keys(out).slice(0, 2)).toEqual(['label', 'email'])
    expect(Object.keys(out)[2]).not.toBe('vantaville')
  })

  it('text in a number column is faked unless it is NaN or Infinity', async () => {
    const { faker } = await serve()
    expect(faker.computed('abc', { kind: 'decimal' })).not.toBe('abc')
    expect(faker.computed('-Infinity', { kind: 'decimal' })).toBe('-Infinity')
  })

  it('values with nothing to fake stay as they are; digits of any script are faked', async () => {
    const { faker } = await serve()
    expect(faker.computed('', { kind: 'string' })).toBe('')
    expect(faker.computed('...', { kind: 'string' })).toBe('...')
    expect(faker.computed('NaN', { kind: 'decimal' })).toBe('NaN')
    expect(faker.computed('infinity', { kind: 'datetime' })).toBe('infinity')
    expect(faker.computed('{"note": ""}', { kind: 'json' })).toBe('{"note":""}')
    expect(faker.computed('٣٤٥-٦٧٨', { kind: 'string' })).toMatch(/^\d{3}-\d{3}$/)
  })

  it('arrays: each element faked, nulls kept', () => {
    for (const [real, fake] of pairs('tags')) {
      expect((fake as Value[]).length).toBe((real as Value[]).length)
      expect((fake as Value[])[2]).toBeNull()
      expect((fake as Value[])[0]).not.toBe('early')
    }
    expect((users[0]!.tags as Value[])[0]).toBe((users[1]!.tags as Value[])[0])
  })

  it('ip addresses: from the documentation ranges', () => {
    for (const [, fake] of pairs('last_ip')) expect(fake).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/)
  })

  it('bytes, uuids and unknown types', () => {
    for (const [real, fake] of pairs('avatar')) {
      expect((fake as string).length).toBe((real as string).length)
      expect(fake).toMatch(/^\\x[0-9a-f]+$/)
    }
    for (const [real, fake] of pairs('uid')) {
      expect(fake).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(fake).not.toBe(real)
    }
    for (const u of users) expect(u.shape).toBeNull()
  })

  it('strings: realistic formats by name, and the shape of codes', () => {
    expect(users[0]!.email).toMatch(/@example\.(com|net|org)$/)
    expect(users[0]!.phone).toMatch(/^\+420 \d{3} \d{3} \d{3}$/)
    expect(users[0]!.api_key).toMatch(/^[a-z]{2}_[a-z]{4}_\w{12}$/)
    expect(users[1]!.account).toMatch(/^[A-Z]{3}-\d{6}$/)
    expect(users[0]!.account).toMatch(/^[1-9]\d{9}$/)
    expect(users[3]!.email).toBeNull()
    expect(users[1]!.name).not.toBe('Jan Novák')
    expect(orders[1]!.note).not.toBe('ring twice')
  })
})

describe('requests', async () => {
  const { faker, all, store } = await serve()
  const { users } = all()
  const email = data.schema.entities[0]!.fields[1]!

  it('look up a fake in the domain of the field it is compared with', () => {
    const request = faker.request()
    expect(request.lookup(users[0]!.email as string, email)).toBe(CANARIES.email)
    expect(request.lookup(users[0]!.email as string)).toBe(CANARIES.email)
    expect(request.lookup('nobody@example.com', email)).toBeUndefined()
  })

  it('leave a fake that names several real values as written', () => {
    store.fake('x.a', 'one', { unique: false, scannable: false }, () => 'same')
    store.fake('x.b', 'two', { unique: false, scannable: false }, () => 'same')
    expect(faker.request().lookup('same')).toBeUndefined()
  })

  it('scrub errors of what they substituted, and mask what the client did not send', () => {
    const sent = `SELECT id::int FROM users WHERE email = '${users[0]!.email}'`
    const request = faker.request(sent)
    request.lookup(users[0]!.email as string, email)
    expect(request.scrub(`invalid input: "${CANARIES.email}"`)).toBe(`invalid input: "${users[0]!.email}"`)
    expect(request.scrub('invalid input syntax for type integer: "Jan Novák"')).toBe('invalid input syntax for type integer: "…"')
    expect(request.scrub('column "id" does not exist')).toBe('column "id" does not exist')
    expect(request.scrub('Perhaps you meant to reference the column "users.email".')).toBe(
      'Perhaps you meant to reference the column "users.email".',
    )
    // alias.column is kept only for an alias the client wrote: a row value of that shape is masked.
    expect(request.scrub('value "j.email" is odd')).toBe('value "…" is odd')
    // Postgres prints some values unquoted: words with digits the client did not write are masked.
    expect(request.scrub('date field value out of range: 1988-14-29')).toBe('date field value out of range: …')
    expect(request.scrub('index 7739182046 out of valid range, 0..7.')).toBe('index … out of valid range, ….')
    // Quoted text the client wrote counts only as a whole token, not as letters inside its words.
    const hex = faker.request("SELECT decode(tag, 'hex') FROM things LIMIT 42")
    expect(hex.scrub('invalid hexadecimal digit: "g"')).toBe('invalid hexadecimal digit: "…"')
    expect(hex.scrub('limit 42 is fine')).toBe('limit 42 is fine')
  })
})
