import { describe, expect, it } from 'vitest'
import { ConfigError, interpolate, readConfig, settingsProblems, variableFor, variablesOf } from '../src/config.js'
import { rulesFor, RulesError, unheldRules, unmetRules } from '../src/rules.js'
import type { Schema } from '../src/source.js'

const KINDS = [{ kind: 'postgres' }, { kind: 'mysql' }, { kind: 'rest', settings: ['headers', 'schema'] }, { kind: 'graphql', settings: ['headers', 'schema'] }]
const read = (text: string) => readConfig(text, '/work/app/sosie.yml', KINDS)
const problems = (text: string) => {
  try {
    read(text)
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  throw new Error('expected problems')
}

describe('sosie.yml', () => {
  it('reads each source, with the top’s settings for those it does not set', () => {
    const config = read(`
max-rows: 50
timeout: 10
pass: [orders.status]
sources:
  shop:
    upstream: \${SHOP_DATABASE_URL}
  billing:
    upstream: \${BILLING_API_URL}
    headers:
      Authorization: Bearer \${BILLING_TOKEN}
      X-Tenant: production
    schema: ./openapi/billing.yaml
    port: 7700
    max-rows: 5
    pass: [invoice.total]
  storefront:
    upstream: \${STOREFRONT_URL}
    kind: graphql
    schema: https://cdn.example.com/storefront.graphql
`)
    expect(config.rules).toEqual({ pass: ['orders.status'] })
    expect(config.sources.map((s) => s.name)).toEqual(['shop', 'billing', 'storefront'])
    const [shop, billing, storefront] = config.sources
    expect(shop).toEqual({ name: 'shop', upstream: 'SHOP_DATABASE_URL', headers: {}, host: '127.0.0.1', maxRows: 50, timeout: 10, rules: {} })
    expect(billing).toMatchObject({
      upstream: 'BILLING_API_URL',
      headers: { Authorization: 'Bearer ${BILLING_TOKEN}', 'X-Tenant': 'production' },
      schema: '/work/app/openapi/billing.yaml',
      port: 7700,
      maxRows: 5,
      timeout: 10,
      rules: { pass: ['invoice.total'] },
    })
    expect(storefront).toMatchObject({ kind: 'graphql', schema: 'https://cdn.example.com/storefront.graphql' })
    expect(variablesOf(config)).toEqual(['SHOP_DATABASE_URL', 'BILLING_API_URL', 'BILLING_TOKEN', 'STOREFRONT_URL'])
  })

  it('reads a header’s variables among its text, and $$ as a $', () => {
    expect(interpolate('Bearer ${TOKEN}; v=$$1', { TOKEN: 'abc' })).toBe('Bearer abc; v=$1')
    expect(interpolate('${A}-${B}', { A: 'x', B: 'y' })).toBe('x-y')
  })

  it('asks for no variable a $$ writes out as text', () => {
    const config = read('sources:\n  billing:\n    upstream: ${API_URL}\n    headers:\n      X-Note: "price $${AMOUNT}, $$${TOKEN}"\n')
    expect(variablesOf(config)).toEqual(['API_URL', 'TOKEN'])
    expect(interpolate(config.sources[0]!.headers['X-Note']!, { TOKEN: 'abc' })).toBe('price ${AMOUNT}, $abc')
  })

  it('names the variable a source would be kept in', () => {
    expect(variableFor('shop')).toBe('SHOP_URL')
    expect(variableFor('billing-api')).toBe('BILLING_API_URL')
  })

  it('never takes an upstream written out, nor quotes one', () => {
    for (const written of ['postgres://kim:s3cret@db.internal/app', 'postgres://kim:${PASSWORD}@db.internal/app', '${A}${B}', 'SHOP_URL']) {
      const found = problems(`sources:\n  shop:\n    upstream: "${written}"\n`)
      expect(found).toEqual([
        'sosie.yml: sources.shop.upstream is one variable, such as ${SHOP_URL}, set in the terminal Sosie starts in: an upstream is never written in sosie.yml, not even in part.',
      ])
      expect(found.join()).not.toContain('s3cret')
    }
    expect(problems('sources:\n  shop:\n    kind: postgres\n')).toEqual([
      'sosie.yml: sources.shop has no upstream: upstream: ${SHOP_URL}, the variable that holds its connection string.',
    ])
  })

  it('reads variables only in upstream and headers', () => {
    expect(problems('host: ${HOST}\nsources:\n  shop:\n    upstream: ${SHOP_URL}\n    schema: ./${FILE}\n')).toEqual([
      'sosie.yml: host reads no variable: only upstream and headers do.',
      'sosie.yml: sources.shop.schema reads no variable: only upstream and headers do.',
    ])
  })

  it('names every problem at once, each where it is, with the key meant', () => {
    expect(
      problems(`
max_rows: 5
timeout: 0
sources:
  Shop:
    upstream: \${SHOP_URL}
  crm:
    upstrem: \${CRM_URL}
    upstream: \${CRM_URL}
    kind: postgress
    port: 70000
  web:
    upstream: \${WEB_URL}
    port: 7700
  api:
    upstream: \${API_URL}
    port: 7700
`),
    ).toEqual([
      'sosie.yml: max_rows is not a key. Did you mean max-rows? Keys: sources, pass, format, host, max-rows, timeout.',
      'sosie.yml: timeout is a whole number from 1 to 3600, not 0.',
      'sosie.yml: sources.Shop: a source is named in lowercase letters, digits, - and _, a letter first.',
      'sosie.yml: sources.crm.upstrem is not a key of a source. Did you mean upstream? Keys: upstream, kind, schema, headers, port, host, max-rows, timeout, pass, format.',
      'sosie.yml: sources.crm.kind is one of postgres, mysql, rest, graphql. Did you mean postgres?',
      'sosie.yml: sources.crm.port is a whole number from 0 to 65535, not 70000.',
      "sosie.yml: sources.api.port: 7700 is web's port too.",
    ])
  })

  it('says a file without sources names none, and how to add one', () => {
    for (const text of ['', 'pass: [orders.status]\n']) {
      expect(problems(text)).toEqual(['sosie.yml names no sources. Add one under sources:, or run sosie init.'])
    }
    // sosie init writes no second sources key: a source goes under the one there.
    for (const text of ['sources:\n', 'sources: {}\n']) {
      expect(problems(text)).toEqual(['sosie.yml has a sources: key with none under it. Add one there, such as shop: { upstream: ${SHOP_URL} }.'])
    }
  })

  it('refuses a key a source’s kind does not take, saying why', () => {
    expect(problems('sources:\n  shop:\n    upstream: ${SHOP_URL}\n    kind: postgres\n    headers:\n      X-Team: core\n')).toEqual([
      'sosie.yml: sources.shop.headers: shop is a postgres source, which takes no headers.',
    ])
    // A source whose kind its URL says is checked once the URL is read.
    expect(settingsProblems({ name: 'db', headers: {}, schema: '/x.sql' }, { kind: 'mysql' })).toEqual([
      'sosie.yml: sources.db.schema: db is a mysql source, which takes no schema.',
    ])
  })
})

/** The problems rulesFor told, by the RulesError it threw. */
const refused = (work: () => unknown): string[] => {
  try {
    work()
  } catch (error) {
    if (error instanceof RulesError) return error.problems
    throw error
  }
  throw new Error('expected problems')
}

describe('rules for each source', () => {
  const shop: Schema = {
    entities: [
      { id: 'users', name: 'users', fields: [{ id: 'users.email', name: 'email', type: { kind: 'string' } }, { id: 'users.handle', name: 'handle', type: { kind: 'string' } }] },
      { id: 'orders', name: 'orders', fields: [{ id: 'orders.status', name: 'status', type: { kind: 'string' } }] },
    ],
  }
  const crm: Schema = { entities: [{ id: 'contacts', name: 'contacts', fields: [{ id: 'contacts.region', name: 'region', type: { kind: 'string' } }] }] }

  it('holds the top’s rules where their table exists, and a source’s own where it says', () => {
    const shared = { pass: ['orders.status', 'contacts.region'], format: { 'users.handle': 'username' } }
    const forShop = rulesFor(shop, { shared, own: { format: { 'users.handle': 'text' } }, source: 'shop' })
    expect([...forShop.pass]).toEqual(['orders.status'])
    // A source's own format for a field wins over the top's.
    expect(forShop.format.get('users.handle')).toBe('text')
    const forCrm = rulesFor(crm, { shared, source: 'crm' })
    expect([...forCrm.pass]).toEqual(['contacts.region'])
    expect(unheldRules(shared, [forShop.applied, forCrm.applied])).toEqual([])
  })

  it('tells a top rule no source holds, and a typo in a table that is there', () => {
    const shared = { pass: ['order.status'], format: { 'users.nick': 'username' } }
    expect(refused(() => rulesFor(shop, { shared, source: 'shop' }))).toEqual(["sosie.yml: users.nick is not a field of shop's users. A rule for one source goes under it."])
    const forCrm = rulesFor(crm, { shared: { pass: ['order.status'] }, source: 'crm' })
    expect(unheldRules({ pass: ['order.status'] }, [forCrm.applied])).toEqual(['sosie.yml: order.status is not a table of any source.'])
  })

  it('checks a source’s own rules against its schema alone', () => {
    expect(refused(() => rulesFor(crm, { own: { pass: ['contacts.regoin'] }, source: 'crm' }))).toEqual(['sosie.yml: sources.crm: contacts.regoin is not a field. Did you mean contacts.region?'])
  })

  it('keeps a top rule for a source that learns its fields, and holds it there', () => {
    const learned = rulesFor({ entities: [] }, { shared: { pass: ['orders.status'] }, source: 'api', learns: true })
    expect([...learned.pass]).toEqual(['orders.status'])
    expect(learned.warnings).toEqual([])
    expect(unheldRules({ pass: ['orders.status'] }, [learned.applied])).toEqual([])
  })

  it('warns of a top rule only a source that learns its fields kept: no source knows it, and it may be a typo', () => {
    const shared = { pass: ['user.emial', 'contacts.region', 'invoice.*'], format: { 'user.handle': 'username' } }
    const learned = rulesFor({ entities: [] }, { shared, source: 'api', learns: true })
    const forCrm = rulesFor(crm, { shared, source: 'crm' })
    expect(unheldRules(shared, [learned.applied, forCrm.applied])).toEqual([])
    // contacts.region is crm's: known, so no word of it.
    expect(unmetRules([learned, forCrm])).toEqual([
      'sosie.yml: user.emial is not known yet: it applies once Sosie meets it.',
      'sosie.yml: invoice.* is not known yet: it applies once Sosie meets it.',
      'sosie.yml: user.handle is not known yet: it applies once Sosie meets it.',
    ])
  })

  it('tells a field that passes without the one it shares values with where its rule is: the top, or the source', () => {
    const linked: Schema = {
      entities: [
        { id: 'users', name: 'users', fields: [{ id: 'users.id', name: 'id', type: { kind: 'integer' } }] },
        { id: 'orders', name: 'orders', fields: [{ id: 'orders.user_id', name: 'user_id', type: { kind: 'integer' }, references: 'users.id' }] },
      ],
    }
    const broken = 'orders.user_id passes but users.id, whose values it shares, does not. List both or neither.'
    expect(refused(() => rulesFor(linked, { shared: { pass: ['orders.user_id'] }, source: 'shop' }))).toEqual([`sosie.yml: ${broken}`])
    expect(refused(() => rulesFor(linked, { own: { pass: ['orders.user_id'] }, source: 'shop' }))).toEqual([`sosie.yml: sources.shop: ${broken}`])
  })

  it('says which of the top’s rules a source holds even when its own are wrong, so all is told at once', () => {
    const shared = { pass: ['contacts.region', 'order.status'] }
    let error: unknown
    try {
      rulesFor(crm, { shared, own: { pass: ['contacts.regoin'] }, source: 'crm' })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(RulesError)
    expect(unheldRules(shared, [(error as RulesError).applied!])).toEqual(['sosie.yml: order.status is not a table of any source.'])
  })
})
