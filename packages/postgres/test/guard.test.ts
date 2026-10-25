import { loadModule } from 'pgsql-parser'
import { beforeAll, describe, expect, it } from 'vitest'
import { analyze, parseStatements } from '../src/guard.js'
import { catalog } from './catalog.js'

beforeAll(() => loadModule())

const check = (sql: string) => analyze(parseStatements(sql)[0]!.stmt, catalog, { statementTimeout: 30_000 })
const near = (sql: string) =>
  check(sql).consts.map((c) => [c.node.sval?.sval ?? c.node.ival?.ival ?? 0, c.near === 'catalog' ? 'catalog' : c.near?.id])

describe('parsing', () => {
  it('splits statements, keeping each one’s own text', () => {
    expect(parseStatements("SELECT 'é'; SELECT 2").map((s) => s.text.trim())).toEqual(["SELECT 'é'", 'SELECT 2'])
    expect(parseStatements('  ')).toEqual([])
    expect(parseStatements('-- nothing')).toEqual([])
  })
})

describe('the guard', () => {
  it.each([
    'SELECT * FROM users',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'SHOW search_path',
    "SET search_path = public",
    "SET statement_timeout = '10s'",
    'SET statement_timeout = 5000',
    'RESET ALL',
    'BEGIN',
    'BEGIN READ ONLY',
    'COMMIT',
    'DECLARE c CURSOR FOR SELECT * FROM users',
    'FETCH 10 FROM c',
    'CLOSE c',
    'DISCARD ALL',
    'DEALLOCATE ALL',
    "SET client_encoding = 'UTF8'",
    'SET standard_conforming_strings = on',
    'SET client_encoding TO DEFAULT',
  ])('allows %s', (sql) => {
    expect(check(sql).refusal).toBeUndefined()
  })

  it.each([
    ['INSERT INTO users DEFAULT VALUES', '25006'],
    ['MERGE INTO users u USING orders o ON o.user_id = u.id WHEN MATCHED THEN DELETE', '25006'],
    ['WITH x AS (UPDATE users SET email = NULL RETURNING id) SELECT * FROM x', '25006'],
    ['CREATE TEMP TABLE t (id int)', '25006'],
    ['VACUUM', '25006'],
    ['CALL do_it()', '25006'],
    ['SET TRANSACTION READ WRITE', '25006'],
    ['SET session_authorization = postgres', '42501'],
    ['SET statement_timeout = 0', '42501'],
    ['SELECT * FROM pg_statistic', '42501'],
    ['SELECT * FROM pg_catalog.pg_stats_ext', '42501'],
    ['SELECT pg_read_file(\'/etc/passwd\')', '42501'],
    ['SELECT dblink_exec(\'x\')', '42501'],
    ["SELECT table_to_xml('users', true, false, '')", '42501'],
    ['SELECT set_config(name, setting, false) FROM pg_settings', '42501'],
    ["SELECT * FROM ts_stat('SELECT body FROM posts')", '42501'],
    ["SELECT * FROM pg_logical_slot_peek_changes('s', NULL, NULL)", '42501'],
    ['SELECT * FROM pg_prepared_statement()', '42501'],
    ['SELECT ident FROM pg_backend_memory_contexts', '42501'],
    ['SET standard_conforming_strings = off', '42501'],
    ["SET client_encoding = 'SJIS'", '42501'],
    ["SELECT set_config('client_encoding', 'SJIS', false)", '42501'],
    ["SELECT pg_create_logical_replication_slot('s', 'pgoutput')", '25006'],
    ['SELECT pg_try_advisory_lock(1)', '25006'],
    ['WITH gone AS (DELETE FROM users RETURNING id) SELECT 1 UNION SELECT 2', '25006'],
    ['PREPARE TRANSACTION \'x\'', '0A000'],
    ['EXPLAIN ANALYZE SELECT 1', '0A000'],
  ])('refuses %s', (sql, code) => {
    expect(check(sql).refusal?.code).toBe(code)
  })

  it('tells catalog-only reads from reads of data', () => {
    expect(check('SELECT relname FROM pg_class').catalogOnly).toBe(true)
    expect(check('SELECT * FROM information_schema.columns').catalogOnly).toBe(true)
    expect(check('SELECT version(), now()').catalogOnly).toBe(true)
    expect(check('SELECT * FROM users').catalogOnly).toBe(false)
    expect(check('SELECT user_email(1)').catalogOnly).toBe(false)
    expect(check('SELECT (SELECT email FROM users LIMIT 1)').catalogOnly).toBe(false)
    expect(check('FETCH 1 FROM c').catalogOnly).toBe(false)
  })

  it('reads the select list, to tell count(…) from values', () => {
    expect(check('SELECT count(*), u.*, id + 1 FROM users u').targets).toEqual(['count', 'star', 'other'])
    // A set operation's columns have no source Postgres reports, and its arms differ: no select list speaks for them.
    expect(check('SELECT count(*) FROM users UNION SELECT 1').targets).toBeUndefined()
    // Only Postgres's own count passes.
    expect(check('SELECT public.count(email) FROM users').targets).toEqual(['other'])
  })

  it('names the field of a column that is only cast, as ORMs do with enums', () => {
    const status = catalog.columns.get('100:3')
    expect(check('SELECT "public"."users"."status"::text, id::text AS i, upper(email) FROM public.users').targets).toEqual([
      status,
      catalog.columns.get('100:1'),
      'other',
    ])
  })
})

describe('what is compared with what', () => {
  it('names the field a constant is compared with, through aliases and schemas', () => {
    expect(near("SELECT * FROM users u WHERE u.email = 'a@example.com' AND 7 = id")).toEqual([
      ['a@example.com', 'users.email'],
      [7, 'users.id'],
    ])
    expect(near('SELECT * FROM billing.invoices i JOIN orders o ON o.id = i.order_id WHERE i.order_id = 3 AND o.user_id IN (1, 2)')).toEqual([
      [3, 'billing.invoices.order_id'],
      [1, 'orders.user_id'],
      [2, 'orders.user_id'],
    ])
    expect(near('SELECT * FROM public.users WHERE public.users.id = 9')).toEqual([[9, 'users.id']])
  })

  it('looks out through enclosing queries, and not into the catalogs', () => {
    expect(near('SELECT * FROM orders WHERE user_id IN (SELECT id FROM users WHERE email = \'x@example.com\')')).toEqual([
      ['x@example.com', 'users.email'],
    ])
    expect(near("SELECT * FROM pg_class WHERE relname = 'users'")).toEqual([])
    expect(near("SELECT * FROM users WHERE lower(email) = 'x@example.com'")).toEqual([['x@example.com', undefined]])
    expect(near('SELECT * FROM users LIMIT 10 OFFSET 5')).toEqual([])
    expect(near("SELECT * FROM users, orders WHERE id = 1")).toEqual([[1, undefined]])
  })

  it('names the field of each parameter, and arrays compared with ANY', () => {
    const a = check('SELECT * FROM users WHERE id = $1 AND email = ANY($2) AND status = ANY(ARRAY[$3, \'ok\']) LIMIT $4')
    expect([...a.params].map(([n, p]) => [n, p.near === 'catalog' ? 'catalog' : p.near?.id, p.array])).toEqual([
      [1, 'users.id', false],
      [2, 'users.email', true],
      [3, 'users.status', false],
    ])
    expect(near("SELECT * FROM users WHERE tags = ANY('{a,b}')")).toEqual([['{a,b}', 'users.tags']])
  })
})
