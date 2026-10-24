import type { Field, RequestScope } from '@sosie/core'
import { loadModule } from 'pgsql-parser'
import { beforeAll, describe, expect, it } from 'vitest'
import { analyze, parseStatements } from '../src/guard.js'
import { print, rewriteConsts, rewriteParam } from '../src/rewrite.js'
import { catalog } from './catalog.js'

beforeAll(() => loadModule())

/** A scope that knows a few fakes, by field. */
const known: Record<string, Record<string, string>> = {
  'users.email': { 'kim@example.net': 'real@corp.test' },
  'users.id': { '42': '7' },
  'orders.user_id': { '42': '7' },
}
const scope: RequestScope = {
  lookup: (fake: string, near?: Field) => (near ? known[near.id]?.[fake] : fake === 'kim@example.net' ? 'real@corp.test' : undefined),
  scrub: (t: string) => t,
}

const rewrite = (sql: string) => {
  const { stmt } = parseStatements(sql)[0]!
  const analysis = analyze(stmt, catalog, { statementTimeout: 30_000 })
  return rewriteConsts(analysis, scope) ? print(stmt).replace(/\s+/g, ' ') : sql
}

describe('rewriting fakes to real values', () => {
  it('replaces fakes in constants, keeping their kind', () => {
    expect(rewrite("SELECT * FROM users WHERE email = 'kim@example.net'")).toBe("SELECT * FROM users WHERE email = 'real@corp.test'")
    expect(rewrite('SELECT * FROM orders WHERE user_id IN (42, 5)')).toBe('SELECT * FROM orders WHERE user_id IN (7, 5)')
    expect(rewrite("SELECT * FROM users WHERE lower(email) = 'kim@example.net'")).toBe(
      "SELECT * FROM users WHERE lower(email) = 'real@corp.test'",
    )
  })

  it('leaves a statement with no known fakes exactly as written', () => {
    const sql = 'select *   from users where id = 1'
    expect(rewrite(sql)).toBe(sql)
  })

  it('replaces fakes in parameters and array literals', () => {
    const { stmt } = parseStatements('SELECT * FROM users WHERE id = $1 AND email = ANY($2)')[0]!
    const analysis = analyze(stmt, catalog, { statementTimeout: 30_000 })
    expect(rewriteParam('42', analysis.params.get(1), scope)).toBe('7')
    expect(rewriteParam('{kim@example.net,"x y"}', analysis.params.get(2), scope)).toBe('{real@corp.test,"x y"}')
    expect(rewriteParam('42', undefined, scope)).toBe('42')
  })
})
