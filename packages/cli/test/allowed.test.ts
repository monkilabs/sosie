import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceConfig } from '@sosie/core'
import { describe, expect, it } from 'vitest'
import { allow, sendsOf, unallowed } from '../src/allowed.js'

const source = (name: string, upstream: string, headers: Record<string, string> = {}): SourceConfig => ({
  name,
  upstream,
  headers,
  host: '127.0.0.1',
  maxRows: 1000,
  timeout: 30,
  rules: {},
})

/** A home of Sosie's, and a project with a sosie.yml. */
function machine() {
  const home = mkdtempSync(join(tmpdir(), 'sosie-home-'))
  const file = join(mkdtempSync(join(tmpdir(), 'sosie-project-')), 'sosie.yml')
  writeFileSync(file, '')
  return { home, file }
}

describe('what a source may send', () => {
  it('is the variable its upstream is read from and each header’s, never a header that names none', () => {
    expect(sendsOf(source('billing', 'BILLING_URL', { Authorization: 'Bearer ${BILLING_TOKEN}', 'X-Team': 'core', 'X-Key': '${A}-${B}' }))).toBe(
      'BILLING_URL ← Authorization: BILLING_TOKEN; X-Key: A B',
    )
    expect(sendsOf(source('shop', 'SHOP_URL'))).toBeUndefined()
    expect(sendsOf(source('billing', 'BILLING_URL', { 'X-Team': 'core', 'X-Price': '$${AMOUNT}' }))).toBeUndefined()
  })

  it('is asked about until allowed, and again when sosie.yml has it send another variable, or send it elsewhere', () => {
    const { home, file } = machine()
    const billing = source('billing', 'BILLING_URL', { Authorization: 'Bearer ${BILLING_TOKEN}' })
    const shop = source('shop', 'SHOP_URL')
    expect(unallowed(home, file, [shop, billing])).toEqual([billing])
    allow(home, file, [shop, billing])
    expect(unallowed(home, file, [shop, billing])).toEqual([])
    // The text around a variable, and a header that names none, change nothing sent of the terminal's.
    expect(unallowed(home, file, [source('billing', 'BILLING_URL', { Authorization: 'Token ${BILLING_TOKEN}', 'X-Team': 'core' })])).toEqual([])
    const another = source('billing', 'BILLING_URL', { Authorization: 'Bearer ${AWS_SECRET_ACCESS_KEY}' })
    const elsewhere = source('billing', 'HTTPS_PROXY', { Authorization: 'Bearer ${BILLING_TOKEN}' })
    const moved = source('billing', 'BILLING_URL', { 'X-Debug': '${BILLING_TOKEN}' })
    for (const edited of [another, elsewhere, moved]) expect(unallowed(home, file, [edited])).toEqual([edited])
  })

  it('is kept for each project, and each way a source was allowed, so a branch that says otherwise is asked about once', () => {
    const { home, file } = machine()
    const other = machine().file
    const main = source('billing', 'BILLING_URL', { Authorization: 'Bearer ${BILLING_TOKEN}' })
    const branch = source('billing', 'BILLING_URL', { Authorization: 'Bearer ${BILLING_V2_TOKEN}' })
    allow(home, file, [main])
    expect(unallowed(home, other, [main])).toEqual([main])
    allow(home, file, [branch])
    expect(unallowed(home, file, [main])).toEqual([])
    expect(unallowed(home, file, [branch])).toEqual([])
  })

  it('keeps the names only, in a file of the machine’s that only its user reads', () => {
    const { home, file } = machine()
    allow(home, file, [source('billing', 'BILLING_URL', { Authorization: 'Bearer ${BILLING_TOKEN}' })])
    const path = join(home, 'allowed.json')
    expect(readFileSync(path, 'utf8')).not.toContain('Bearer')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    // A file that is not Sosie's allows nothing, and is written over.
    writeFileSync(path, '[1, 2]')
    expect(unallowed(home, file, [source('billing', 'BILLING_URL', { Authorization: '${T}' })])).toHaveLength(1)
  })
})
