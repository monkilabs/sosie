import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFaker, loadRules, secretParts, Store, storeDir, type Field, type Value } from '@sosie/core'
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
    expect(faker.computed('6.02e23', { kind: 'decimal' })).toMatch(/^\d\.\d\de23$/)
  })

  it('a letter outside the basic plane is faked like any other', async () => {
    const { faker } = await serve()
    for (const name of ['𠮷野', '𠮷-12']) expect(faker.computed(name, { kind: 'string' }) as string).not.toMatch(/𠮷/u)
  })

  it('a JSON key that echoes a value the request turned back is faked, even when it looks like a word', async () => {
    const { faker } = await serve()
    const settings = { id: 'users.settings', name: 'settings', type: { kind: 'json' } } as const
    const city = faker.value('vantaville', { id: 'users.city', name: 'city', type: { kind: 'string' } }) as string
    const scope = faker.request(`SELECT settings FROM users WHERE city = '${city}'`)
    expect(scope.lookup(city)).toBe('vantaville')
    expect(scope.turnedBack('Vantaville')).toBe(true)
    expect(Object.keys(JSON.parse(faker.value('{"vantaville":1,"theme":2}', settings) as string))).toEqual(['vantaville', 'theme'])
    const echoed = Object.keys(JSON.parse(faker.value('{"vantaville":1,"theme":2}', settings, scope) as string))
    expect(echoed[0]).not.toBe('vantaville')
    expect(echoed[1]).toBe('theme')
  })

  it('a JSON key that holds a value the request turned back is faked', async () => {
    const { faker } = await serve()
    const name = faker.value('Quillon Vantablack', { id: 'users.name', name: 'name', type: { kind: 'string' } }) as string
    const city = faker.value('vantaville', { id: 'users.city', name: 'city', type: { kind: 'string' } }) as string
    const scope = faker.request(`SELECT 1 FROM users WHERE name = '${name}' AND city = '${city}'`)
    expect(scope.lookup(name)).toBe('Quillon Vantablack')
    expect(scope.lookup(city)).toBe('vantaville')
    for (const key of ['vantaville_weather', 'byVantaville', 'quillonvantablack', 'QUILLON-VANTABLACK', 'teamQuillonVantablack', 'xvantavillex']) {
      expect(scope.turnedBack(key), key).toBe(true)
    }
    // A word of a value is no echo of it: it may be any key's (by-email turned back leaves email a key).
    for (const key of ['theme', 'quill', 'vantablack', 'profile_id']) expect(scope.turnedBack(key), key).toBe(false)
  })

  it('a field that passes shows the fake the client sent, not a value the request turned back', async () => {
    const { faker } = await serve('pass:\n  - users.city\n  - users.account\n  - users.score\n')
    const email = faker.value('quill.vantablack@canary-mail.test', { id: 'users.email', name: 'email', type: { kind: 'string' } }) as string
    const city = { id: 'users.city', name: 'city', type: { kind: 'string' } } as const
    const scope = faker.request(`SELECT city FROM users WHERE email = '${email}'`)
    expect(scope.lookup(email)).toBe('quill.vantablack@canary-mail.test')
    expect(faker.value('QUILL.VANTABLACK@canary-mail.test', city, scope)).toBe(email)
    expect(faker.value('Results for quill.vantablack@canary-mail.test.', { ...city, id: 'users.account' }, scope)).toBe(`Results for ${email}.`)
    // Anything else in a field that passes stays, and so does a short number, which may be any count.
    expect(faker.value('Reykjavik', city, scope)).toBe('Reykjavik')
    const id = faker.value('7', { id: 'users.id', name: 'id', type: { kind: 'integer' } }) as string
    const byId = faker.request(`SELECT score FROM users WHERE id = ${id}`)
    byId.lookup(id, { id: 'users.id', name: 'id', type: { kind: 'integer' } })
    expect(faker.value('7', { id: 'users.score', name: 'score', type: { kind: 'decimal' } }, byId)).toBe('7')
    // Without a request, as in a session's own reads, nothing changes.
    expect(faker.value('quill.vantablack@canary-mail.test', city)).toBe('quill.vantablack@canary-mail.test')
  })

  it('a field that passes and holds a value the request turned back in another form is faked whole', async () => {
    const { faker } = await serve('pass:\n  - users.city\n  - users.tags\n')
    const name = faker.value('Quillon Vantablack', { id: 'users.name', name: 'name', type: { kind: 'string' } }) as string
    const email = faker.value('quill.vantablack@canary-mail.test', { id: 'users.email', name: 'email', type: { kind: 'string' } }) as string
    const city = { id: 'users.city', name: 'city', type: { kind: 'string' } } as const
    const scope = faker.request(`SELECT city FROM users WHERE name = '${name}' OR email = '${email}'`)
    expect(scope.lookup(name)).toBe('Quillon Vantablack')
    expect(scope.lookup(email)).toBe('quill.vantablack@canary-mail.test')
    // Escaped as a URL or a form escapes it, spaced, or cased otherwise.
    for (const echo of ['Results for quill.vantablack%40canary-mail.test', 'q=Quillon+Vantablack', 'quillon-vantablack', 'QuillonVantablack', 'by_quill_vantablack_canary_mail_test']) {
      expect(faker.value(echo, city, scope) as string, echo).not.toMatch(/vantablack/i)
    }
    // In an array, the item that holds one is faked with the rest.
    const tags = faker.value(['Reykjavik', 'quillon_vantablack'], { id: 'users.tags', name: 'tags', type: { kind: 'array', of: { kind: 'string' } } }, scope)
    expect(JSON.stringify(tags)).not.toMatch(/vantablack/i)
    // Text that holds none stays, a word of a value included.
    expect(faker.value('Quillon Street', city, scope)).toBe('Quillon Street')
  })

  it('a field that passes shows the fake the client sent for a label or a boolean the request turned back, as a word of text', async () => {
    const { faker } = await serve('pass:\n  - users.city\n  - users.active\n')
    const city = { id: 'users.city', name: 'city', type: { kind: 'string' } } as const
    // Whether a boolean flips, and where a label goes, is decided once per domain: find a field where they change.
    const flags = Array.from({ length: 20 }, (_, i): Field => ({ id: `users.flag${i}`, name: `flag${i}`, type: { kind: 'boolean' } }))
    const flag = flags.find((f) => faker.value('true', f) === 'false')!
    const levels = Array.from({ length: 20 }, (_, i): Field => ({ id: `users.level${i}`, name: `level${i}`, type: { kind: 'enum', labels: ['admin', 'editor', 'viewer'] } }))
    const level = levels.find((f) => faker.value('admin', f) !== 'admin')!
    const shown = faker.value('admin', level) as string
    const scope = faker.request(`flag=false&level=${shown}`)
    expect(scope.lookup('false', flag)).toBe('true')
    expect(scope.lookup(shown, level)).toBe('admin')
    // An API that echoes the filters it applied, in text that passes, echoes what the client sent.
    expect(faker.value('applied: flag=true, level=admin', city, scope)).toBe(`applied: flag=false, level=${shown}`)
    expect(faker.value('{"level":"Admin"}', { ...city, type: { kind: 'json' } }, scope)).toBe(`{"level":"${shown}"}`)
    // A field of their own kind holds its own value, not an echo: it keeps it.
    expect(faker.value('true', { id: 'users.active', name: 'active', type: { kind: 'boolean' } }, scope)).toBe('true')
    // A key that is one is an echo too.
    expect(scope.turnedBack('admin')).toBe(true)
  })

  it('fakes a key or a value that passes when it holds Sosie’s own credentials', async () => {
    const { faker } = await serve('pass:\n  - users.city\n')
    const city = { id: 'users.city', name: 'city', type: { kind: 'string' } } as const
    const scope = faker.request('', undefined, secretParts({ authorization: 'Bearer sesamesecretword' }, ['sunshine99']))
    expect(scope.turnedBack('sesamesecretword')).toBe(true)
    expect(scope.turnedBack('Bearer')).toBe(false)
    for (const echo of ['token sesamesecretword', 'pw=sunshine%39%39', 'SUNSHINE99']) expect(faker.value(echo, city, scope) as string, echo).not.toMatch(/sesame|sunshine/i)
    expect(faker.value('Reykjavik', city, scope)).toBe('Reykjavik')
    // A scope that carries another's over keeps its credentials.
    expect(faker.request('', scope).turnedBack('sesamesecretword')).toBe(true)
  })

  it('takes the parts of credentials as headers write them', () => {
    const basic = `Basic ${Buffer.from('robot:sunshine99').toString('base64')}`
    expect(secretParts({ authorization: 'Token token="sesamesecretword"' })).toEqual(['sesamesecretword'])
    expect(secretParts({ authorization: basic })).toEqual(expect.arrayContaining(['sunshine99']))
    expect(secretParts({ authorization: 'Bearer abc123def456==' })).toEqual(['abc123def456=='])
    // A cookie's names, and a header that carries no credential, are no secrets.
    expect(secretParts({ cookie: 'session=k9q2x8w7; theme=darkmode', 'x-tenant': 'production' })).toEqual(['k9q2x8w7', 'darkmode'])
  })

  it('turns a boolean written as 1 or 0 back as 1 or 0', async () => {
    const { faker } = await serve()
    // Whether a boolean flips is decided once per domain: find a field where it does.
    const flags = Array.from({ length: 20 }, (_, i): Field => ({ id: `users.flag${i}`, name: `flag${i}`, type: { kind: 'boolean' } }))
    const flag = flags.find((f) => faker.value('true', f) === 'false')!
    expect(faker.request().lookup('1', flag)).toBe('0')
    expect(faker.request().lookup('0', flag)).toBe('1')
  })

  it('checks a field that passes for every value the request turned back at once, not one by one', async () => {
    const { faker } = await serve('pass:\n  - users.city\n')
    const email = { id: 'users.email', name: 'email', type: { kind: 'string' } } as const
    const fakes = Array.from({ length: 2000 }, (_, i) => faker.value(`person${i}@canary-mail.test`, email) as string)
    const scope = faker.request('SELECT city FROM users WHERE email = ANY($1)')
    for (const fakeEmail of fakes) scope.lookup(fakeEmail, email)
    const city = { id: 'users.city', name: 'city', type: { kind: 'string' } } as const
    // A query by two thousand fakes that returns two thousand rows: one by one, millions of checks and seconds.
    const started = performance.now()
    for (let i = 0; i < 2000; i++) expect(faker.value(`Reykjavik, street ${i}`, city, scope)).toBe(`Reykjavik, street ${i}`)
    expect(faker.value('Results for person1999@canary-mail.test', city, scope)).toBe(`Results for ${fakes[1999]}`)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('a value of another form than its type, as an API may send, is faked whole', async () => {
    const { faker } = await serve()
    // An "e" in text is no exponent, and a "/" no prefix length: nothing of either value stays.
    const number = faker.computed('Zephyrine Orrowmoor, flat 2', { kind: 'decimal' }) as string
    expect(number).toMatch(/^[A-Z][a-z]{8} [A-Z][a-z]{8}, [a-z]{4} \d$/)
    expect(number).not.toMatch(/phyrine|Orrowmoor/)
    const address = faker.computed('x/Vantaville', { kind: 'ip' }) as string
    expect(address).not.toMatch(/Vantaville/)
    expect(faker.computed('10.1.2.3/24', { kind: 'ip' })).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+\/24$/)
    expect(faker.computed('Quillon', { kind: 'integer' })).not.toBe('Quillon')
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
