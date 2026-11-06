import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { ConfigError, readConfig } from '@sosie/core'
import { describe, expect, it } from 'vitest'
import { init } from '../src/init.js'
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

  it('adds the source to a sosie.yml that names none yet, its rules kept', async () => {
    const { text, file } = await answer(['postgres://db/app', '', ''], 'pass:\n  - orders.status\n')
    expect(text).toBe('pass:\n  - orders.status\n\nsources:\n  app:\n    upstream: ${APP_URL}\n')
    expect(readConfig(text!, file, sources)).toMatchObject({ rules: { pass: ['orders.status'] }, sources: [{ name: 'app' }] })
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
