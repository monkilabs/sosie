import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { ConfigError, readConfig } from '@sosie/core'
import { describe, expect, it } from 'vitest'
import { init, sourceFor } from '../src/init.js'
import { sources } from '../src/sources.js'

/** sosie init in a folder of its own, answered as a terminal would be: each answer a line. */
async function answer(lines: string[], existing?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'sosie-init-'))
  const file = join(dir, 'sosie.yml')
  if (existing !== undefined) writeFileSync(file, existing)
  const input = new PassThrough()
  const output = new PassThrough()
  let shown = ''
  output.on('data', (d) => (shown += d))
  const done = init(file, { input, output }, sources)
  // All at once, as a paste: each question reads its own line.
  input.write(lines.map((l) => `${l}\n`).join(''))
  const written = await done.catch((error: Error) => error)
  return { written, shown, file, text: existsSync(file) ? readFileSync(file, 'utf8') : undefined }
}

describe('sosie init', () => {
  it('asks for the first source, names it, and writes sosie.yml with the variable that holds it, never the string', async () => {
    const { written, shown, file, text } = await answer(['postgres://kim:s3cret@db.internal:5432/shop', '', ''])
    expect(written).toEqual({ name: 'shop', variable: 'SHOP_URL', value: 'postgres://kim:s3cret@db.internal:5432/shop' })
    expect(shown).toContain('✓ A Postgres database: db.internal:5432/shop')
    expect(shown).toContain('A name for it (shop): ')
    expect(shown).toContain('The variable to keep it in (SHOP_URL): ')
    expect(shown).toContain('Set SHOP_URL in your terminal, and Sosie starts without asking for it.')
    expect(shown + text).not.toContain('s3cret')
    expect(text).toMatch(/^# Sosie: this project's sources/)
    expect(text).toContain('sources:\n  shop:\n    upstream: ${SHOP_URL}\n')
    expect(readConfig(text!, file, sources).sources).toMatchObject([{ name: 'shop', upstream: 'SHOP_URL' }])
  })

  it('takes the name and the variable given, and tells an API from a database', async () => {
    const rest = await answer(['https://billing.internal/v1', 'billing-api', 'BILLING_API_BASE'])
    expect(rest.shown).toContain('✓ A REST API: billing.internal/v1')
    expect(rest.text).toContain('sources:\n  billing-api:\n    upstream: ${BILLING_API_BASE}\n')
    const graphql = await answer(['https://api.example.com/graphql', '', ''])
    expect(graphql.shown).toContain('✓ A GraphQL API: api.example.com/graphql')
    expect(graphql.written).toMatchObject({ name: 'example', variable: 'EXAMPLE_URL' })
  })

  it('asks again for what it cannot read, saying why, and never quotes a string', async () => {
    const { written, shown } = await answer(['redis://kim:s3cret@cache/0', 'mysql://root@127.0.0.1:3306/crm', 'Crm!', 'crm', '1BAD', 'CRM_URL'])
    expect(written).toMatchObject({ name: 'crm', variable: 'CRM_URL' })
    expect(shown).toContain('not redis://.')
    expect(shown).toContain('A source is named in lowercase letters, digits, - and _, a letter first.')
    expect(shown).toContain('A variable is named in letters, digits and _, not a digit first.')
    expect(shown).not.toContain('s3cret')
  })

  it('gives up after three strings it cannot read, and writes nothing', async () => {
    const { written, shown, text } = await answer(['redis://kim:s3cret@cache/0', 'host=db.internal user=kim password=s3cret dbname=shop', 'ftp://files.internal/app'])
    expect((written as Error).message).toBe('Nothing written.')
    expect(shown.split("Its connection string, or the API's URL (hidden): ")).toHaveLength(4)
    expect(shown).toContain('That is not a URL. It looks like postgres://user:password@host:5432/database, or https://api.example.com/v1.')
    expect(shown).toContain('Sosie reads postgres://, postgresql://, mysql://, mongodb://, mongodb+srv://, http:// and https:// upstreams, for now; not ftp://.')
    expect(shown).not.toContain('s3cret')
    expect(text).toBeUndefined()
  })

  it('refuses a replica set’s several hosts, asking for one, and never quotes the string', async () => {
    const one = 'Give one host of the replica set, with its replicaSet option: mongodb://user:password@host:27017/database?replicaSet=rs0. The driver finds the others.'
    // With ports, no URL; without, a URL whose host is h1,h2.
    const { written, shown } = await answer(['mongodb://kim:s3cret@h1:27017,h2:27017/app?replicaSet=rs0', 'mongodb://kim:s3cret@h1,h2/app', 'mongodb://kim:s3cret@h1:27017/app?replicaSet=rs0', '', ''])
    expect(shown.split(one)).toHaveLength(3)
    expect(shown).toContain('✓ A MongoDB database: h1:27017/app')
    expect(written).toEqual({ name: 'app', variable: 'APP_URL', value: 'mongodb://kim:s3cret@h1:27017/app?replicaSet=rs0' })
    expect(shown).not.toContain('s3cret')
  })

  it('suggests the kind for a name where the URL gives none: localhost, an IP, a database not named', async () => {
    for (const [url, name] of [
      ['http://localhost:3000', 'rest'],
      ['http://10.0.0.7:8080/graphql', 'graphql'],
      ['https://[fd00:ab::1]:8443/v1', 'rest'],
      ['postgres://kim@db.internal:5432', 'postgres'],
      ['mysql://root@127.0.0.1:3306/', 'mysql'],
    ] as const) {
      const { written, shown } = await answer([url, '', ''])
      expect(shown, url).toContain(`A name for it (${name}): `)
      expect(written, url).toMatchObject({ name, variable: `${name.toUpperCase()}_URL` })
    }
  })

  it('says a string with no // after its scheme is no URL, and quotes no part of it', async () => {
    // new URL() reads kim: and localhost: as schemes: the user name, or the host, would be quoted as one.
    const { written, shown } = await answer(['kim:s3cret@db.internal/shop', 'localhost:5432/shop', 'postgres://db/shop', '', ''])
    expect(written).toMatchObject({ name: 'shop' })
    expect(shown.split('That is not a URL.')).toHaveLength(3)
    expect(shown).not.toMatch(/kim|s3cret|localhost/)
  })

  it('writes an empty sosie.yml as a new one, with its header', async () => {
    for (const existing of ['', '\n  \n']) {
      const { text } = await answer(['postgres://db/app', '', ''], existing)
      expect(text).toMatch(/^# Sosie: this project's sources/)
      expect(text).toContain('\nsources:\n  app:\n    upstream: ${APP_URL}\n')
    }
  })

  it('adds the source to a sosie.yml that names none yet, its rules kept', async () => {
    const { text, file } = await answer(['postgres://db/app', '', ''], 'pass:\n  - orders.status\n')
    expect(text).toBe('pass:\n  - orders.status\n\nsources:\n  app:\n    upstream: ${APP_URL}\n')
    expect(readConfig(text!, file, sources)).toMatchObject({ rules: { pass: ['orders.status'] }, sources: [{ name: 'app' }] })
  })

  it('ends the last line of a sosie.yml that has no newline there before adding the source', async () => {
    const { text } = await answer(['postgres://db/app', '', ''], 'pass:\n  - orders.status')
    expect(text).toBe('pass:\n  - orders.status\n\nsources:\n  app:\n    upstream: ${APP_URL}\n')
  })

  it('leaves a sosie.yml that names its sources as it is', async () => {
    const existing = 'sources:\n  shop:\n    upstream: ${SHOP_URL}\n'
    const { written, text } = await answer([], existing)
    expect((written as Error).message).toBe('sosie.yml names its sources already: shop. Add another under sources:.')
    expect(text).toBe(existing)
  })

  it('says of a sources key with none under it what starting Sosie says, and writes no second one', async () => {
    for (const existing of ['sources:\n', 'sources: {}\n']) {
      const { written, text, file } = await answer([], existing)
      expect(text).toBe(existing)
      let started: unknown
      try {
        readConfig(existing, file, sources)
      } catch (error) {
        started = error
      }
      expect([(written as Error).message]).toEqual((started as ConfigError).problems)
    }
  })

  it('tells what else is wrong in a sosie.yml with no sources key, a misspelt one among it, and writes nothing', async () => {
    const existing = 'sourcs:\n  app:\n    upstream: ${APP_URL}\n'
    const { written, text } = await answer(['postgres://db/app', '', ''], existing)
    expect(written).toBeInstanceOf(ConfigError)
    expect((written as ConfigError).problems).toContain('sosie.yml: sourcs is not a key. Did you mean sources? Keys: sources, pass, format, host, max-rows, timeout.')
    expect(text).toBe(existing)
  })
})

describe('the source for an upstream', () => {
  it('is the kind’s, which must read the URL’s scheme', () => {
    expect(sourceFor(new URL('https://shop.internal/api'), 'graphql', sources).kind).toBe('graphql')
    expect(() => sourceFor(new URL('postgres://db/app'), 'graphql', sources)).toThrow(new Error('A graphql source reads http:// or https:// upstreams, not postgres://.'))
    expect(() => sourceFor(new URL('mongodb://db/app'), 'postgres', sources)).toThrow(new Error('A postgres source reads postgres:// or postgresql:// upstreams, not mongodb://.'))
  })
})
